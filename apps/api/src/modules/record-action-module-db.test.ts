// SPDX-License-Identifier: BUSL-1.1
/**
 * What a runtime module can and cannot do with the named-action axis, against
 * a fully migrated database, through the RESTRICTED app role, and through the
 * ACTUAL Operation dispatcher.
 *
 * The subject is the repository's own second, non-workflow use: `Notebook`
 * declares a `deliver` action for integrations with `reads: [name]`, and the
 * notebook example plugin's `deliverToNotebook` handler records one delivery
 * in its own `notebook.notebook_deliveries` table. Nothing here is
 * workflow-shaped, and nothing here is a fixture table: the policy, the SQL
 * lookup, the dispatcher and the handler are the compiled, shipped ones. A
 * hostile module is modelled by replacing that one handler with a probe
 * (`dispatch`, `withinDelivery`), so everything around it stays real.
 *
 * What each group is for:
 *
 *   1. the plugin-facing authorization answers for the record ACL and for
 *      nothing else — not another tenant's record, not an undeclared action,
 *      not an entity that declared none;
 *   2. the bounded read returns the declared field and no other column of the
 *      row, is bound to the record the Operation was authorized on rather
 *      than to everything the session's grant reaches, and discloses nothing
 *      at all outside such an Operation, while the row itself stays
 *      unreadable to the holder;
 *   3. the module's own rows compose with the axis instead of copying it, in
 *      one transaction, with the verified integration as provenance and as
 *      the replay namespace;
 *   4. no principal class other than a resolved API key holds the action,
 *      including a service account with every notebook role;
 *   5. a hostile module cannot widen the capability it was handed — not the
 *      nested application principal, not the tenant, not the arrays, not the
 *      prototype — and core's own session survives the attempt unchanged;
 *   6. the trust boundary of all of the above: what a module's RAW SQL still
 *      reaches, and what the database refuses it regardless.
 *
 * Run (repo root), with a local scratch admin database whose cluster has the
 * roles from `bun run db:provision-roles`:
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://…/postgres \
 *     bun test apps/api/src/modules/record-action-module-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { operationErrorOf } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import { ModulePlatformRuntime, withModuleOperationSession } from "./platform.js";
import { loadRuntimeModules } from "./registry.js";
import { bindOperationHandlers, invokeOperation } from "../operations/runtime.js";
import { HttpError } from "../rest/http-error.js";
import type { ModuleOperationHandler, RuntimeModule } from "./contract.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = process.env.SCRATCH_APP_ROLE_PASSWORD ?? "openshapeforge_app";
const TEST_TIMEOUT = 180_000;
const scratch = `record_action_module_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const tenantA = randomUUID();
const tenantB = randomUUID();
const integration = randomUUID();
const otherIntegration = randomUUID();
const person = randomUUID();

/** Notebooks: granted, ungranted, another integration's, and another tenant's. */
const granted = randomUUID();
/**
 * Granted the action AND restricted for people: `view` names one person, so
 * the row is hidden from every other session including this application's.
 * This is the shape that proves an action does not imply a read.
 */
const grantedRestricted = randomUUID();
const ungranted = randomUUID();
const otherApp = randomUUID();
const foreignTenant = randomUUID();

const NOTEBOOK_ROLES = [
  "General.All.Read",
  "General.All.ReadWrite",
  "Organization.All.ReadWrite",
];

let server: SQL;
let admin: DatabaseRuntime;
let app: DatabaseRuntime;
/**
 * The shipped handler, resolved the way the API resolves it: through the
 * generated module registry, from the example plugin's runtime half. Reaching
 * into `examples/` by path would also leave the registry — the thing that has
 * to agree — untested.
 */
let deliverToNotebook: ModuleOperationHandler;
/** Every loaded runtime module, so a bound Operation binds against the real set. */
let loadedModules: readonly RuntimeModule[];

function url(name: string, asApp = false): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${name}`;
  if (asApp) {
    parsed.username = APP_ROLE;
    parsed.password = APP_ROLE_PASSWORD;
  }
  return parsed.toString();
}

/** The session auth/api-key/resolve.ts produces for a resolved key. */
function application(
  overrides: Partial<TrustedSessionContext> = {},
): TrustedSessionContext {
  return {
    tenantId: tenantA,
    userId: randomUUID(),
    roles: [],
    groups: [],
    relationGroupIds: [],
    scope: "self",
    credential: "api-key",
    principalKind: "service",
    appPrincipal: { integrationId: integration },
    ...overrides,
  };
}

/**
 * The same session with no verified application principal: the shape every
 * other carrier produces. Removing the property rather than setting it
 * undefined is what the session contract allows.
 */
function withoutApplication(session: TrustedSessionContext): TrustedSessionContext {
  const { appPrincipal: _absent, ...rest } = session;
  return rest;
}

function acl(actions: Record<string, unknown>): string {
  return JSON.stringify({ actions });
}

/**
 * The refusal code, whichever layer refused.
 *
 * The record check inside the Operation raises a canonical operation failure;
 * the dispatcher's earlier principal-class gate — an Operation whose action no
 * session of this class could ever hold — raises an `HttpError`. Both are the
 * same answer to a caller, so the tests read either rather than pinning which
 * gate got there first.
 */
function code(error: unknown): string | undefined {
  return operationErrorOf(error)?.code ??
    (error instanceof HttpError ? error.code : undefined);
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return code(error);
  }
  return undefined;
}

function runtime(): ModulePlatformRuntime {
  return new ModulePlatformRuntime(app.db);
}

/** One module invocation, as core hands it to a plugin handler. */
async function asModule<T>(
  session: TrustedSessionContext,
  work: (platform: ModulePlatformRuntime["services"], live: TrustedSessionContext) => Promise<T>,
): Promise<T> {
  const host = runtime();
  return withModuleOperationSession(host.services, session, (live) =>
    work(host.services, live!));
}

/**
 * `Notebook.deliver` through the ACTUAL dispatcher.
 *
 * Not the handler called directly: the Operation's `auth.recordAction` check,
 * its transaction, its keyed receipt and the record-action admission the
 * bounded read is bound to all live in `invokeOperation`, and every one of
 * them is part of what these tests are about. `handler` replaces the shipped
 * `deliverToNotebook` with a probe — which is how a HOSTILE module is modelled
 * here: real dispatcher, real policy, real database, plugin code that tries
 * things the shipped handler does not.
 */
async function dispatch(
  session: TrustedSessionContext,
  input: { notebookId: string; reference: string },
  handler?: ModuleOperationHandler,
): Promise<unknown> {
  const modules = handler
    ? loadedModules.map((module) => module.name === "notebook"
      ? { ...module, operationHandlers: { ...module.operationHandlers, deliverToNotebook: handler } }
      : module)
    : loadedModules;
  const bound = bindOperationHandlers(modules).get("Notebook.deliver");
  if (!bound) throw new Error("Notebook.deliver has no bound runtime handler.");
  const host = runtime();
  return invokeOperation(bound, input, {
    transport: "operation",
    session,
    platform: host.services,
    db: app.db,
  });
}

/** A probe handler's required output envelope, so the contract validates. */
function accepted(notebookName: string) {
  return {
    value: {
      status: "accepted" as const,
      deliveryId: randomUUID(),
      notebookName,
      priorDeliveries: 0,
    },
  };
}

/**
 * Run `work` as the plugin code of a real `Notebook.deliver` invocation on
 * `notebookId`.
 *
 * So `work` sees exactly what a handler sees: the capability core minted for
 * this invocation, the Operation's own transaction with the ACL-row lock the
 * dispatcher's check took, and the record-action admission that check
 * established. Several of the answers below differ inside and outside that
 * admission, which is the point.
 */
async function withinDelivery<T>(
  notebookId: string,
  work: (
    platform: ModulePlatformRuntime["services"],
    live: TrustedSessionContext,
  ) => Promise<T>,
  session: TrustedSessionContext = application(),
): Promise<T> {
  let captured: T | undefined;
  let ran = false;
  await dispatch(session, { notebookId, reference: `ref-${randomUUID()}` },
    async (_input, context) => {
      captured = await work(context.platform!, context.session!);
      ran = true;
      return accepted("probe");
    });
  if (!ran) throw new Error("The probe handler never ran.");
  return captured as T;
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch)) throw new Error("unsafe scratch database name");
  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);
  loadedModules = modules.loaded;
  const notebook = modules.loaded.find((module) => module.name === "notebook");
  const handler = notebook?.operationHandlers?.deliverToNotebook;
  if (!handler) throw new Error("The notebook module registers no deliverToNotebook handler.");
  deliverToNotebook = handler;
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${scratch}"`);
  admin = createDatabaseRuntime({ databaseUrl: url(scratch), maxConnections: 4 });
  await admin.db.connection().execute((conn) => runMigrationChain(conn));
  await admin.db.connection().execute(async (conn) => {
    // The Operation dispatcher writes a keyed execution receipt, which is
    // tenant-scoped by foreign key, so both tenants have to exist as rows.
    await sql`
      insert into platform.tenants (id, slug, name, status) values
        (${tenantA}::uuid, ${`record-action-a-${tenantA.slice(0, 8)}`}, 'Record action tenant A', 'active'),
        (${tenantB}::uuid, ${`record-action-b-${tenantB.slice(0, 8)}`}, 'Record action tenant B', 'active')
    `.execute(conn);
    await sql`
      insert into notebook.notebooks (id, tenant_id, name, body, permissions) values
        (${granted}::uuid, ${tenantA}::uuid, 'Granted notes', 'confidential body',
          ${sql.raw(`'${acl({ deliver: { integrations: [integration] } })}'::jsonb`)}),
        (${grantedRestricted}::uuid, ${tenantA}::uuid, 'Restricted notes', 'confidential body',
          ${sql.raw(`'${JSON.stringify({
            view: { users: [person] },
            edit: { users: [person] },
            actions: { deliver: { integrations: [integration] } },
          })}'::jsonb`)}),
        (${ungranted}::uuid, ${tenantA}::uuid, 'Ungranted notes', 'confidential body',
          ${sql.raw("'{}'::jsonb")}),
        (${otherApp}::uuid, ${tenantA}::uuid, 'Other application', 'confidential body',
          ${sql.raw(`'${acl({ deliver: { integrations: [otherIntegration] } })}'::jsonb`)}),
        (${foreignTenant}::uuid, ${tenantB}::uuid, 'Another tenant', 'confidential body',
          ${sql.raw(`'${acl({ deliver: { integrations: [integration] } })}'::jsonb`)})
    `.execute(conn);
  });
  app = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 6 });
  const role = (await sql<{ superuser: boolean; bypass: boolean }>`
    select rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname = current_user
  `.execute(app.db)).rows[0]!;
  expect(role).toEqual({ superuser: false, bypass: false });
}, TEST_TIMEOUT);

afterAll(async () => {
  await app?.close();
  await admin?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.close();
});

describe("the module-facing record action", () => {
  const record = (id: string) => ({ entityName: "Notebook", id, action: "deliver" } as const);

  test("answers for the record that names this integration and for no other", async () => {
    await asModule(application(), async (platform, live) => {
      expect(await platform.records.holdsAction(live, record(granted))).toBe(true);
      // An empty ACL is a denial even though the entity is `empty: public`:
      // `empty` governs the three human permissions, never an action.
      expect(await platform.records.holdsAction(live, record(ungranted))).toBe(false);
      expect(await platform.records.holdsAction(live, record(otherApp))).toBe(false);
      // Granted — in the other tenant. The tenant fence answers first.
      expect(await platform.records.holdsAction(live, record(foreignTenant))).toBe(false);
      expect(await platform.records.holdsAction(live, record(randomUUID()))).toBe(false);
      await platform.records.assertAction(live, record(granted));
      expect(await refusal(platform.records.assertAction(live, record(ungranted)))).toBe("FORBIDDEN");
      expect(await refusal(platform.records.assertAction(live, record(foreignTenant)))).toBe("FORBIDDEN");
    });
  }, TEST_TIMEOUT);

  test("refuses an action or an entity the compiler did not authorize", async () => {
    await asModule(application(), async (platform, live) => {
      for (const action of ["view", "edit", "delete", "publish", "Deliver", "deliver-now", ""]) {
        expect(await refusal(platform.records.assertAction(live, {
          entityName: "Notebook", id: granted, action,
        }))).toBeDefined();
      }
      // A real entity with a real record ACL — and no declared action.
      expect(await refusal(platform.records.assertAction(live, {
        entityName: "Relation", id: granted, action: "deliver",
      }))).toBe("FORBIDDEN");
      expect(await refusal(platform.records.assertAction(live, {
        entityName: "NotAnEntity", id: granted, action: "deliver",
      }))).toBe("FORBIDDEN");
      // Not a physical table name either.
      expect(await refusal(platform.records.assertAction(live, {
        entityName: "notebook.notebooks", id: granted, action: "deliver",
      }))).toBe("FORBIDDEN");
    });
  }, TEST_TIMEOUT);

  test("the bounded read carries the declared field and nothing else", async () => {
    const observed = await withinDelivery(granted, async (platform, live) => ({
      projection: await platform.records.readForAction(live, record(granted)),
      frozen: Object.isFrozen(await platform.records.readForAction(live, record(granted))),
      ungranted: await refusal(platform.records.readForAction(live, record(ungranted))),
      foreignTenant: await refusal(platform.records.readForAction(live, record(foreignTenant))),
    }));
    // The body, the ACL and the tenant are columns of the same row.
    expect(observed.projection).toEqual({ name: "Granted notes" });
    expect(Object.keys(observed.projection)).toEqual(["name"]);
    expect(observed.frozen).toBe(true);
    expect(observed.ungranted).toBe("FORBIDDEN");
    expect(observed.foreignTenant).toBe("FORBIDDEN");
  }, TEST_TIMEOUT);

  test("the bounded read is bound to the Operation's own target, not to the grant", async () => {
    // This integration holds `deliver` on BOTH notebooks. The Operation was
    // authorized on one of them, so that is the one the handler reads: a
    // module cannot walk the rest of its own grant through the read.
    const observed = await withinDelivery(granted, async (platform, live) => ({
      own: await platform.records.readForAction(live, record(granted)),
      holdsOther: await platform.records.holdsAction(live, record(grantedRestricted)),
      readOther: await refusal(platform.records.readForAction(live, record(grantedRestricted))),
      // The axis itself is unchanged: the action is still held on both, and
      // still asserts on both. Only the DISCLOSURE is bound.
      assertOther: await refusal(platform.records.assertAction(live, record(grantedRestricted))),
    }));
    expect(observed.own).toEqual({ name: "Granted notes" });
    expect(observed.holdsOther).toBe(true);
    expect(observed.readOther).toBe("FORBIDDEN");
    expect(observed.assertOther).toBeUndefined();
  }, TEST_TIMEOUT);

  test("outside a record-action Operation the bounded read discloses nothing", async () => {
    await asModule(application(), async (platform, live) => {
      // A module tool, a job, a webhook: a live verified session that no
      // dispatcher authorized on a record. It still holds the action.
      expect(await platform.records.holdsAction(live, record(granted))).toBe(true);
      expect(await refusal(platform.records.readForAction(live, record(granted))))
        .toBe("FORBIDDEN");
    });
  }, TEST_TIMEOUT);

  test("reading through the action does not make the record readable", async () => {
    // The restricted notebook: this application holds `deliver` on it and is
    // named nowhere in view/edit/delete. Delivered to, so the Operation's own
    // target is the record whose readability is in question.
    const observed = await withinDelivery(grantedRestricted, async (platform, live) => {
      const projection = await platform.records.readForAction(live, record(grantedRestricted));
      return platform.db.withSession(live, async (trx) => ({
        projection,
        // The holder's own session, in the same transaction, after the read:
        // the row-scope policy still asks for `view` and the action supplied
        // none, so the row is simply not there.
        rows: (await sql<{ id: string }>`
          select id from notebook.notebooks where id = ${grantedRestricted}::uuid
        `.execute(trx)).rows,
        // Nor through the generic entity route.
        access: await refusal(platform.records.assertAccess(live, {
          entityName: "Notebook", id: grantedRestricted, intent: "get",
        })),
      }));
    });
    expect(observed.projection).toEqual({ name: "Restricted notes" });
    expect(observed.rows).toEqual([]);
    expect(observed.access).toBeDefined();
  }, TEST_TIMEOUT);

  test("only a resolved API key holds it; no other principal class does", async () => {
    // Every one of these is a session the server classified itself. The
    // service account carries every notebook role the entity declares, which
    // is exactly the escalation the class match exists to stop.
    const classes: Array<[string, TrustedSessionContext]> = [
      ["service account with every notebook role", withoutApplication(application({
        credential: "bearer", roles: NOTEBOOK_ROLES,
      }))],
      ["verified person", withoutApplication(application({
        credential: "bearer", principalKind: "person", userId: person,
        roles: NOTEBOOK_ROLES,
      }))],
      ["trusted-context bundle", withoutApplication(application({
        credential: "trusted-context", roles: NOTEBOOK_ROLES,
      }))],
      ["another integration", application({ appPrincipal: { integrationId: otherIntegration } })],
    ];
    for (const [label, session] of classes) {
      await asModule(session, async (platform, live) => {
        expect([label, await platform.records.holdsAction(live, record(granted))])
          .toEqual([label, false]);
      });
    }
  }, TEST_TIMEOUT);

  test("a module cannot ask on a session core did not hand it", async () => {
    await asModule(application(), async (platform, live) => {
      const forged = { ...live, appPrincipal: { integrationId: integration } };
      expect(await refusal(platform.records.holdsAction(forged, record(granted)))).toBe("FORBIDDEN");
      expect(await refusal(platform.records.readForAction(forged, record(granted)))).toBe("FORBIDDEN");
      expect(() => platform.principals.application(forged)).toThrow();
    });
  }, TEST_TIMEOUT);
});

describe("the module's own rows compose with the axis", () => {
  test("a granted delivery is recorded against the verified integration", async () => {
    const reference = `ref-${randomUUID()}`;
    const result = await dispatch(application(), { notebookId: granted, reference }) as {
      value: { status: string; deliveryId: string; notebookName: string; priorDeliveries: number };
    };
    expect(result.value).toMatchObject({
      status: "accepted", notebookName: "Granted notes", priorDeliveries: 0,
    });
    const row = (await sql<{
      tenant_id: string; notebook_id: string; integration_id: string;
      reference: string; notebook_name: string;
    }>`
      select tenant_id, notebook_id, integration_id, reference, notebook_name
        from notebook.notebook_deliveries where id = ${result.value.deliveryId}::uuid
    `.execute(admin.db)).rows[0]!;
    // Provenance is the integration the host verified, not anything the
    // caller named, and the stored name came from the action's projection.
    expect(row).toEqual({
      tenant_id: tenantA, notebook_id: granted, integration_id: integration,
      reference, notebook_name: "Granted notes",
    });
  }, TEST_TIMEOUT);

  test("the reference is a replay fence in the principal's own namespace", async () => {
    const reference = `ref-${randomUUID()}`;
    const first = await dispatch(application(), { notebookId: granted, reference }) as
      { value: { status: string; deliveryId: string } };
    const again = await dispatch(application(), { notebookId: granted, reference }) as
      { value: { status: string; deliveryId: string; priorDeliveries: number } };
    expect(first.value.status).toBe("accepted");
    expect(again.value.status).toBe("duplicate");
    expect(again.value.deliveryId).toBe(first.value.deliveryId);
    // The namespace is the integration, so the SAME reference from a
    // different application is a different delivery and never a replay of
    // this one. That application is granted on `otherApp`.
    const other = await dispatch(
      application({ appPrincipal: { integrationId: otherIntegration } }),
      { notebookId: otherApp, reference },
    ) as { value: { status: string; deliveryId: string } };
    expect(other.value.status).toBe("accepted");
    expect(other.value.deliveryId).not.toBe(first.value.deliveryId);
  }, TEST_TIMEOUT);

  test("an ungranted notebook writes nothing at all", async () => {
    // In production core refuses `auth.recordAction` before the handler is
    // reached; this calls the handler directly, so what it proves is that the
    // handler's own first act is the host's check and that it does not
    // degrade a refusal into a partial write.
    const count = async () => (await sql<{ count: string }>`
      select count(*)::text as count from notebook.notebook_deliveries
    `.execute(admin.db)).rows[0]!.count;
    const started = await count();
    for (const notebookId of [ungranted, otherApp, foreignTenant, randomUUID()]) {
      expect(await refusal(dispatch(application(), {
        notebookId, reference: `ref-${randomUUID()}`,
      }))).toBe("FORBIDDEN");
    }
    expect(await count()).toBe(started);
  }, TEST_TIMEOUT);

  test("a session with no application principal cannot deliver at all", async () => {
    const session = withoutApplication(application({
      credential: "bearer", roles: NOTEBOOK_ROLES,
    }));
    // Core refuses first, before the handler is reached, and before a record
    // is even consulted: `deliver` admits an integration principal, this
    // carrier resolved to none, so no notebook could make the Operation
    // reachable (operations/runtime.ts recordActionPrincipalReachable).
    expect(await refusal(dispatch(session, {
      notebookId: granted, reference: `ref-${randomUUID()}`,
    }))).toBe("FORBIDDEN");
    // And the handler's own first act is the same refusal, so a module reached
    // some other way still writes nothing: with no verified integration there
    // is no namespace to write in and no actor to record.
    const host = runtime();
    const direct = await withModuleOperationSession(host.services, session, async (live) =>
      deliverToNotebook({ notebookId: granted, reference: `ref-${randomUUID()}` }, {
        transport: "operation", session: live, platform: host.services, db: app.db,
      } as never)) as { ok?: false; status?: number };
    expect(direct).toMatchObject({ ok: false, status: 403 });
  }, TEST_TIMEOUT);

  test("the delivery and its authorization are one transaction", async () => {
    // The handler joins the Operation's transaction rather than opening its
    // own, so the ACL-row lock `assertRecordActionInTransaction` took before
    // the handler ran is still held while the row is written. Proven by
    // transaction identity rather than by inspection: the shipped handler,
    // wrapped by a probe that reads the transaction id either side of it.
    const reference = `ref-${randomUUID()}`;
    const observed: string[] = [];
    const uncommitted: { reference: string; mine: boolean }[] = [];
    const xid = async (trx: Parameters<Parameters<
      ModulePlatformRuntime["services"]["db"]["withSession"]>[1]>[0]) =>
      (await sql<{ xid: string }>`select pg_current_xact_id()::text as xid`
        .execute(trx)).rows[0]!.xid;
    await dispatch(application(), { notebookId: granted, reference },
      async (input, context) => {
        await context.platform!.db.withSession(context.session!,
          async (trx) => { observed.push(await xid(trx)); });
        const shipped = await deliverToNotebook(input, context);
        await context.platform!.db.withSession(context.session!, async (trx) => {
          observed.push(await xid(trx));
          uncommitted.push(...(await sql<{ reference: string; mine: boolean }>`
            select reference,
                   pg_xact_status(xmin::text::xid8) = 'in progress' as mine
              from notebook.notebook_deliveries
             where tenant_id = ${tenantA}::uuid and reference = ${reference}
          `.execute(trx)).rows);
        });
        return shipped;
      });
    expect(observed[1]).toBe(observed[0]!);
    // And the row the handler wrote is a row of THAT transaction: still
    // uncommitted, yet already visible to a statement inside it, and
    // written under a transaction id that is this one or a savepoint of it.
    expect(uncommitted).toEqual([{ reference, mine: true }]);
    // It is there once the Operation committed, so the write and the
    // authorization that admitted it landed together or not at all.
    expect((await sql<{ reference: string }>`
      select reference from notebook.notebook_deliveries
       where tenant_id = ${tenantA}::uuid and reference = ${reference}
    `.execute(admin.db)).rows).toEqual([{ reference }]);
  }, TEST_TIMEOUT);
});

/**
 * The module as an ADVERSARY, inside a real `Notebook.deliver` invocation on a
 * notebook it legitimately holds `deliver` on.
 *
 * The services accept one object, by identity, and read the verified facts off
 * it: `appPrincipal.integrationId` is which application `platform.principals`
 * reports, which id `applyDbSession` writes to `app.app_principal_id`, and
 * therefore whose record-action grants `app.record_action_allows` answers for.
 * So the question is whether plugin code can change any of that from inside
 * the invocation it was legitimately given — and whether core's own session
 * survives the attempt.
 */
describe("a hostile module cannot widen the capability core handed it", () => {
  const record = (id: string) => ({ entityName: "Notebook", id, action: "deliver" } as const);

  test("refuses every write, and the verified principal is still this integration", async () => {
    const observed = await withinDelivery(granted, async (platform, live) => {
      const writes: string[] = [];
      const attempt = (label: string, write: () => void) => {
        try {
          write();
          writes.push(`${label}: ACCEPTED`);
        } catch {
          writes.push(`${label}: refused`);
        }
      };
      const mutable = live as unknown as Record<string, unknown>;
      // The nested application principal, four ways.
      attempt("appPrincipal.integrationId", () => {
        (live.appPrincipal as { integrationId: string }).integrationId = otherIntegration;
      });
      attempt("appPrincipal", () => {
        mutable.appPrincipal = { integrationId: otherIntegration };
      });
      attempt("defineProperty(appPrincipal)", () => {
        Object.defineProperty(live, "appPrincipal", {
          value: { integrationId: otherIntegration },
        });
      });
      attempt("delete appPrincipal", () => { delete mutable.appPrincipal; });
      // The tenant, the class and the carrier: the rest of what the axis
      // matches a subject against.
      attempt("tenantId", () => { mutable.tenantId = tenantB; });
      attempt("principalKind", () => { mutable.principalKind = "person"; });
      attempt("credential", () => { mutable.credential = "control-bearer"; });
      attempt("userId", () => { mutable.userId = person; });
      // The arrays, in place rather than by replacement.
      attempt("roles.push", () => (live.roles as string[]).push("Organization.All.ReadWrite"));
      attempt("groups.push", () => (live.groups as string[]).push("/forged"));
      attempt("relationGroupIds.push", () =>
        (live.relationGroupIds as string[]).push(randomUUID()));
      attempt("setPrototypeOf", () =>
        Object.setPrototypeOf(live, { appPrincipal: { integrationId: otherIntegration } }));

      // What the host says this session is, after all of that.
      const principal = platform.principals.application(live);
      const guc = await platform.db.withSession(live, async (trx) => (await sql<{
        principal: string | null; tenant: string | null; class: string;
      }>`
        select app.current_app_principal()::text as principal,
               app.current_tenant()::text as tenant,
               app.current_principal_class() as class
      `.execute(trx)).rows[0]!);
      return {
        writes,
        principalClass: platform.principals.classOf(live),
        integrationId: principal?.integrationId,
        guc,
        // The other application's notebook and the other tenant's, through
        // every door the axis opens.
        holdsOtherApp: await platform.records.holdsAction(live, record(otherApp)),
        holdsForeignTenant: await platform.records.holdsAction(live, record(foreignTenant)),
        assertOtherApp: await refusal(platform.records.assertAction(live, record(otherApp))),
        readOtherApp: await refusal(platform.records.readForAction(live, record(otherApp))),
        readForeignTenant: await refusal(
          platform.records.readForAction(live, record(foreignTenant))),
        // And the record this invocation WAS authorized on still reads.
        own: await platform.records.readForAction(live, record(granted)),
      };
    });

    // Not one of the writes landed. Listed rather than counted so a newly
    // accepted write names itself in the failure.
    expect(observed.writes.filter((entry) => entry.endsWith("ACCEPTED"))).toEqual([]);
    expect(observed.principalClass).toBe("application");
    expect(observed.integrationId).toBe(integration);
    expect(observed.guc).toEqual({
      principal: integration, tenant: tenantA, class: "application",
    });
    expect(observed.holdsOtherApp).toBe(false);
    expect(observed.holdsForeignTenant).toBe(false);
    expect(observed.assertOtherApp).toBe("FORBIDDEN");
    expect(observed.readOtherApp).toBe("FORBIDDEN");
    expect(observed.readForeignTenant).toBe("FORBIDDEN");
    expect(observed.own).toEqual({ name: "Granted notes" });
  }, TEST_TIMEOUT);

  test("leaves the parent trusted session, and the next invocation, untouched", async () => {
    // The caller's own session object: core's, not the capability's. A module
    // that reached it would corrupt every later use of this session, including
    // core's own authorization and the provenance of rows it writes.
    const parent = application();
    const before = structuredClone(parent);
    await withinDelivery(granted, async (_platform, live) => {
      const mutable = live as unknown as Record<string, unknown>;
      for (const write of [
        () => { (live.appPrincipal as { integrationId: string }).integrationId = otherIntegration; },
        () => { mutable.appPrincipal = { integrationId: otherIntegration }; },
        () => { mutable.tenantId = tenantB; },
        () => (live.roles as string[]).push("Organization.All.ReadWrite"),
      ]) {
        try { write(); } catch { /* every one of these is expected to refuse */ }
      }
      return undefined;
    }, parent);
    expect(parent).toEqual(before);

    // And the session still delivers as the integration it resolved to: the
    // provenance of the next row is the verified one, not the chosen one.
    const reference = `ref-${randomUUID()}`;
    const result = await dispatch(parent, { notebookId: granted, reference }) as {
      value: { deliveryId: string };
    };
    expect((await sql<{ integration_id: string; tenant_id: string }>`
      select integration_id, tenant_id from notebook.notebook_deliveries
       where id = ${result.value.deliveryId}::uuid
    `.execute(admin.db)).rows).toEqual([
      { integration_id: integration, tenant_id: tenantA },
    ]);
  }, TEST_TIMEOUT);
});

/**
 * THE TRUST BOUNDARY, written down as a test.
 *
 * Everything above is enforced in this process. It has to be: `platform.db
 * .withSession` hands a module the Operation's own transaction on the app
 * role's connection, so core's statements and the module's are the same
 * database principal, and PostgreSQL cannot tell them apart. No
 * database-enforced constraint can bind the one without binding the other.
 *
 * These two cases pin both halves of that so neither drifts unnoticed: what a
 * module's raw SQL can still reach, and what the database refuses it anyway.
 * The first is a limit being recorded, not a behaviour being endorsed —
 * closing it needs a database role of its own for module SQL, and the day that
 * lands this assertion is the one that fails. See docs/plugins.md.
 */
describe("the module database trust boundary", () => {
  test("raw module SQL is bounded in-process, not by the database", async () => {
    const forged = await asModule(application(), async (platform, live) =>
      platform.db.withSession(live, async (trx) => {
        // `app.*` session identity is a placeholder GUC, and PostgreSQL lets
        // every role set one: `revoke set on parameter` records nothing for a
        // placeholder, which is also why db/migrations/record-actions.ts
        // refuses to depend on `app.bypass_rls`.
        await sql`select set_config('app.app_principal_id', ${otherIntegration}, true)`
          .execute(trx);
        return (await sql<{ allowed: boolean; payload: unknown }>`
          select app.record_action_allows('Notebook', ${otherApp}, 'deliver') as allowed,
                 app.record_action_read('Notebook', ${otherApp}, 'deliver') as payload
        `.execute(trx)).rows[0]!;
      }));
    // The other application's grant answers, because the identity it was
    // matched against is one the module wrote. The host services refused this
    // exact pair in the group above; raw SQL is not behind them.
    expect(forged).toEqual({ allowed: true, payload: { name: "Other application" } });
  }, TEST_TIMEOUT);

  test("and the resolver's column grants still hold against it", async () => {
    // What the database enforces regardless of who is asking: the resolver
    // role reads the key, the tenant, the ACL and the declared projection of
    // an action, and nothing else on the row. So the most a forged identity
    // reaches is another declared projection of the same shape — never an
    // undeclared column, never the ACL, never the record.
    const observed = await asModule(application(), async (platform, live) =>
      platform.db.withSession(live, async (trx) => {
        await sql`select set_config('app.app_principal_id', ${otherIntegration}, true)`
          .execute(trx);
        const payload = (await sql<{ payload: Record<string, unknown> | null }>`
          select app.record_action_read('Notebook', ${otherApp}, 'deliver') as payload
        `.execute(trx)).rows[0]!.payload;
        // A notebook whose `view` names one person: the ACL the forged
        // identity does NOT satisfy is still the app role's own row gate, and
        // no action of any identity supplies `view`.
        const hidden = (await sql<{ id: string }>`
          select id from notebook.notebooks where id = ${grantedRestricted}::uuid
        `.execute(trx)).rows;
        return { fields: Object.keys(payload ?? {}).sort(), hidden: hidden.length };
      }));
    // `reads: [name]` and nothing more — not `body`, not `permissions`, not
    // `tenant_id`, which the migration refuses to grant at all.
    expect(observed.fields).toEqual(["name"]);
    expect(observed.hidden).toBe(0);
  }, TEST_TIMEOUT);
});
