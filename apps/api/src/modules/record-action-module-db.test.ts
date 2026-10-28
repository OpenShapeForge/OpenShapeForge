// SPDX-License-Identifier: BUSL-1.1
/**
 * What a runtime module can and cannot do with the named-action axis, against
 * a fully migrated database and through the RESTRICTED app role.
 *
 * The subject is the repository's own second, non-workflow use: `Notebook`
 * declares a `deliver` action for integrations with `reads: [name]`, and the
 * notebook example plugin's `deliverToNotebook` handler records one delivery
 * in its own `notebook.notebook_deliveries` table. Nothing here is
 * workflow-shaped, and nothing here is a fixture table: the policy, the SQL
 * lookup and the handler are the compiled, shipped ones.
 *
 * What each group is for:
 *
 *   1. the plugin-facing authorization answers for the record ACL and for
 *      nothing else — not another tenant's record, not an undeclared action,
 *      not an entity that declared none;
 *   2. the bounded read returns the declared field and no other column of the
 *      row, while the row itself stays unreadable to the holder;
 *   3. the module's own rows compose with the axis instead of copying it, in
 *      one transaction, with the verified integration as provenance and as
 *      the replay namespace;
 *   4. no principal class other than a resolved API key holds the action,
 *      including a service account with every notebook role.
 *
 * Run (repo root), with a local scratch admin database:
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
import type { ModuleOperationHandler } from "./contract.js";

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

function code(error: unknown): string | undefined {
  return operationErrorOf(error)?.code;
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

/** The shipped handler, invoked exactly as the operations runtime would. */
async function deliver(
  session: TrustedSessionContext,
  input: { notebookId: string; reference: string },
): Promise<unknown> {
  const host = runtime();
  return withModuleOperationSession(host.services, session, async (live) =>
    deliverToNotebook(input, {
      transport: "operation",
      session: live,
      platform: host.services,
      db: app.db,
    } as never));
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch)) throw new Error("unsafe scratch database name");
  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);
  const notebook = modules.loaded.find((module) => module.name === "notebook");
  const handler = notebook?.operationHandlers?.deliverToNotebook;
  if (!handler) throw new Error("The notebook module registers no deliverToNotebook handler.");
  deliverToNotebook = handler;
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${scratch}"`);
  admin = createDatabaseRuntime({ databaseUrl: url(scratch), maxConnections: 4 });
  await admin.db.connection().execute((conn) => runMigrationChain(conn));
  await admin.db.connection().execute(async (conn) => {
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
    await asModule(application(), async (platform, live) => {
      const projection = await platform.records.readForAction(live, record(granted));
      expect(projection).toEqual({ name: "Granted notes" });
      expect(Object.isFrozen(projection)).toBe(true);
      // The body, the ACL and the tenant are columns of the same row.
      expect(Object.keys(projection)).toEqual(["name"]);
      expect(await refusal(platform.records.readForAction(live, record(ungranted)))).toBe("FORBIDDEN");
      expect(await refusal(platform.records.readForAction(live, record(foreignTenant)))).toBe("FORBIDDEN");
    });
  }, TEST_TIMEOUT);

  test("reading through the action does not make the record readable", async () => {
    await asModule(application(), async (platform, live) => {
      // The restricted notebook: this application holds `deliver` on it and
      // is named nowhere in view/edit/delete.
      const projection = await platform.records.readForAction(live, record(grantedRestricted));
      expect(projection).toEqual({ name: "Restricted notes" });
      await platform.db.withSession(live, async (trx) => {
        // The holder's own session, in the same transaction, after the read:
        // the row-scope policy still asks for `view` and the action supplied
        // none, so the row is simply not there.
        const rows = await sql<{ id: string }>`
          select id from notebook.notebooks where id = ${grantedRestricted}::uuid
        `.execute(trx);
        expect(rows.rows).toEqual([]);
        // Nor through the generic entity route.
        expect(await refusal(platform.records.assertAccess(live, {
          entityName: "Notebook", id: grantedRestricted, intent: "get",
        }))).toBeDefined();
      });
    });
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
    const result = await deliver(application(), { notebookId: granted, reference }) as {
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
    const first = await deliver(application(), { notebookId: granted, reference }) as
      { value: { status: string; deliveryId: string } };
    const again = await deliver(application(), { notebookId: granted, reference }) as
      { value: { status: string; deliveryId: string; priorDeliveries: number } };
    expect(first.value.status).toBe("accepted");
    expect(again.value.status).toBe("duplicate");
    expect(again.value.deliveryId).toBe(first.value.deliveryId);
    // The namespace is the integration, so the SAME reference from a
    // different application is a different delivery and never a replay of
    // this one. That application is granted on `otherApp`.
    const other = await deliver(
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
      expect(await refusal(deliver(application(), {
        notebookId, reference: `ref-${randomUUID()}`,
      }))).toBe("FORBIDDEN");
    }
    expect(await count()).toBe(started);
  }, TEST_TIMEOUT);

  test("a session with no application principal cannot deliver at all", async () => {
    // The handler refuses before it reaches the record: with no verified
    // integration there is no namespace to write in and no actor to record.
    const outcome = await deliver(
      withoutApplication(application({ credential: "bearer", roles: NOTEBOOK_ROLES })),
      { notebookId: granted, reference: `ref-${randomUUID()}` },
    ) as { ok?: false; status?: number };
    expect(outcome).toMatchObject({ ok: false, status: 403 });
  }, TEST_TIMEOUT);

  test("the delivery and its authorization are one transaction", async () => {
    // The handler joins the active transaction rather than opening its own,
    // so the ACL-row lock the check takes is held while the row is written.
    // Proven by transaction identity rather than by inspection.
    const reference = `ref-${randomUUID()}`;
    const host = runtime();
    const observed: string[] = [];
    await withModuleOperationSession(host.services, application(), async (live) => {
      await host.services.db.withSession(live!, async (trx) => {
        observed.push((await sql<{ xid: string }>`
          select pg_current_xact_id()::text as xid
        `.execute(trx)).rows[0]!.xid);
        await deliverToNotebook(
          { notebookId: granted, reference },
          { transport: "operation", session: live, platform: host.services, db: app.db } as never,
        );
        observed.push((await sql<{ xid: string }>`
          select pg_current_xact_id()::text as xid
        `.execute(trx)).rows[0]!.xid);
      });
    });
    expect(observed[1]).toBe(observed[0]!);
    // And the row the handler wrote belongs to that transaction, so it could
    // only have committed together with the authorization that admitted it.
    const written = (await sql<{ xid: string }>`
      select xmin::text as xid from notebook.notebook_deliveries
       where tenant_id = ${tenantA}::uuid and reference = ${reference}
    `.execute(admin.db)).rows[0]!;
    expect(written.xid).toBe(observed[0]!);
  }, TEST_TIMEOUT);
});
