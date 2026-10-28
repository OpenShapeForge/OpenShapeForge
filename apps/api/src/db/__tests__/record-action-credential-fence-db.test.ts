// SPDX-License-Identifier: BUSL-1.1
/**
 * The credential fence on a record action, against a fully migrated database,
 * through the RESTRICTED app role, and through the ACTUAL Operation
 * dispatcher.
 *
 * The hole being closed: an application principal is an integration id, so it
 * survives rotation — and therefore cannot answer whether the key the caller
 * presented is still valid. A long-running Operation that authenticated with a
 * key, had that key revoked a moment later and then authorized its effect
 * against an unchanged record ACL would act on a withdrawn credential, because
 * the ACL row lock fences the GRANT and the grant had not changed.
 *
 * Everything here is the shipped thing. The subject is the repository's own
 * non-workflow use of the axis: `Notebook` declares `deliver` for integration
 * principals and `Notebook.deliver` is authorized by that action and by no
 * role. The revocations are `revokeKey` and `disableIntegration` from
 * `auth/api-key/service.ts` — the real management Operations, with their real
 * statements and therefore their real lock order — and the sessions are the
 * shape `auth/api-key/resolve.ts` produces from a resolved credential.
 *
 * What each group is for, in the order the failure would hurt:
 *
 *   1. a revoke cannot interleave with an effect in either direction: it
 *      waits for an action in flight, and an action that starts after it
 *      reads the revocation. Both interleavings are driven on separate
 *      restricted connections and asserted on `pg_blocking_pids`, never on a
 *      sleep having been long enough;
 *   2. the same for disabling the whole integration, which locks a different
 *      row first and is the reason the fence takes the order it does;
 *   3. expiry is measured against the wall clock, and rotation keeps the
 *      grant while retiring exactly one credential;
 *   4. the fence is bound to ONE tenant and ONE integration, so neither
 *      another tenant's live key nor a sibling integration's can stand in for
 *      a withdrawn one;
 *   5. a failed action commits nothing and leaves the credential usable;
 *   6. the lock ORDER is load-bearing: integration first, then credential,
 *      deadlocks under neither interleaving — and the reverse order does.
 *
 * Run (repo root), with a scratch admin database whose cluster has the roles
 * from `bun run db:provision-roles`:
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://…/postgres \
 *     bun test apps/api/src/db/__tests__/record-action-credential-fence-db.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Transaction } from "kysely";
import { operationErrorOf } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { API_KEY_MANAGE_ROLE, assertMayManageApiKeys } from "../../auth/api-key/ceiling.js";
import { UNDECLARED_CREDENTIAL_LIFETIME_POLICY } from "../../auth/api-key/lifetime.js";
import {
  disableIntegration,
  revokeKey,
  type ApiKeyServiceDeps,
  type ProvisioningSession,
} from "../../auth/api-key/service.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { WORKER_ROLE } from "../migrations/worker-role.js";
import { databaseRole } from "../database-roles.js";
import { withDbSession, type DbSessionInput } from "../session.js";
import type { DB } from "../../generated/db/types.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import { bindOperationHandlers, invokeOperation } from "../../operations/runtime.js";
import { HttpError } from "../../rest/http-error.js";
import type { ModuleOperationHandler, RuntimeModule } from "../../modules/contract.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = process.env.SCRATCH_APP_ROLE_PASSWORD ?? "openshapeforge_app";
const TEST_TIMEOUT = 180_000;
/**
 * Several tests here hold a transaction open on purpose while a second one
 * waits on its lock, so the default 15s statement timeout is the clock they
 * race. On a loaded machine an ordinary fixture INSERT can itself take
 * seconds, and a cancelled statement then reads as a fence failure. Raise the
 * bound rather than remove it: a genuine lock that never clears still fails
 * this file instead of hanging it.
 */
process.env.DB_STATEMENT_TIMEOUT_MS = process.env.DB_STATEMENT_TIMEOUT_MS ?? "60000";
const scratch = `ra_credential_fence_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

const tenantA = randomUUID();
const tenantB = randomUUID();
/** The human who manages keys, and the actor every fixture row is created by. */
const manager = randomUUID();

/** The application the notebooks below grant `deliver` to. */
const integration = randomUUID();
/** A SECOND live integration of the same tenant, for the stand-in attack. */
const siblingIntegration = randomUUID();
/** The same arrangement in another tenant, for the cross-tenant attack. */
const foreignIntegration = randomUUID();

/**
 * One credential per scenario.
 *
 * Separate rows rather than one reused key, because several of these tests
 * revoke or disable what they used and the fence's whole subject is the state
 * of that row. A shared credential would make the order of the tests part of
 * their meaning.
 */
const keys = {
  /** Revoked while an action holds it (the in-flight case). */
  revokeInFlight: randomUUID(),
  /** Revoked and committed before the action starts. */
  revokedFirst: randomUUID(),
  /** Already past its expiry. */
  expired: randomUUID(),
  /** The retired half of a rotation. */
  rotatedOut: randomUUID(),
  /** The fresh half of the same rotation. */
  rotatedIn: randomUUID(),
  /** Live, and used by the tests that must not disturb one another. */
  live: randomUUID(),
  /** Live, and belonging to the sibling integration of the same tenant. */
  sibling: randomUUID(),
  /** Live, and belonging to another tenant entirely. */
  foreign: randomUUID(),
  /** Live, for the lock-order pairings. */
  lockOrder: randomUUID(),
  /** Live, for the reverse-order deadlock. */
  reverseOrder: randomUUID(),
} as const;

/**
 * One notebook per scenario.
 *
 * Most grant `deliver` to `integration`. The two disable scenarios grant to a
 * DISPOSABLE integration of their own, because `disableIntegration` takes the
 * whole application down with every key under it — pointing them at the
 * shared one would make every later test depend on the order this file runs
 * in rather than on the fence.
 */
const notebooks = {
  revokeInFlight: randomUUID(),
  revokedFirst: randomUUID(),
  disableInFlight: randomUUID(),
  disabledFirst: randomUUID(),
  expiry: randomUUID(),
  rotation: randomUUID(),
  attacks: randomUUID(),
  rollback: randomUUID(),
} as const;

/** The integrations the two disable scenarios own outright, with their keys. */
const disposable = {
  disableInFlight: { integration: randomUUID(), key: randomUUID() },
  disabledFirst: { integration: randomUUID(), key: randomUUID() },
} as const;

let server: SQL;
let admin: DatabaseRuntime;
let app: DatabaseRuntime;
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

/** The session auth/api-key/resolve.ts produces for a resolved credential. */
function application(
  credentialId: string,
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
    appPrincipal: { integrationId: integration, credentialId },
    ...overrides,
  };
}

/**
 * The management session `revokeKey` and `disableIntegration` require: a
 * human carrier holding the management role. An API-key session is refused by
 * the ceiling, which is why a key cannot revoke itself out of this fence.
 */
function management(tenantId = tenantA): ProvisioningSession {
  return {
    tenantId,
    userId: manager,
    roles: [API_KEY_MANAGE_ROLE],
    groups: [],
    credential: "bearer",
    principalKind: "person",
  };
}

test("management fixture is a verified person and rejects an unverified or service principal", () => {
  const session = management();
  expect(() => assertMayManageApiKeys(session)).not.toThrow();
  expect(() => assertMayManageApiKeys({ ...session, principalKind: undefined })).toThrow();
  expect(() => assertMayManageApiKeys({ ...session, principalKind: "service" })).toThrow();
});

/**
 * The session input `service.ts` opens its transaction with, so an outer
 * `withDbSession` on the same database JOINS it instead of opening a second
 * one. That is what lets these tests hold a REAL revoke open at the moment it
 * has taken its locks and not yet committed — the same nesting the Operations
 * runtime relies on, rather than a transcription of the statements.
 */
function managementSessionInput(tenantId = tenantA): DbSessionInput {
  const session = management(tenantId);
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    roles: [...session.roles],
    groups: [],
    principalKind: session.principalKind,
    scope: "tenant",
  };
}

/**
 * Only `db` is read by revoke/disable; the rest of the contract is unused.
 *
 * The lifetime policy included because the contract requires one — it is read
 * when a credential is MINTED, and nothing here mints. The expiry group below
 * ages its keys in the table instead, which is where the fence reads them.
 */
function serviceDeps(db: DatabaseRuntime["db"]): ApiKeyServiceDeps {
  return {
    db,
    keyring: { activeKeyId: "unused", keys: new Map() },
    admin: {} as ApiKeyServiceDeps["admin"],
    entityRoleClientId: "erp-provider",
    lifetime: UNDECLARED_CREDENTIAL_LIFETIME_POLICY,
  };
}

function code(error: unknown): string | undefined {
  return operationErrorOf(error)?.code ??
    (error instanceof HttpError ? error.code : undefined);
}

/** Whatever the dispatcher did: the value it returned, or the error it raised. */
async function outcome(
  promise: Promise<unknown>,
): Promise<{ resolved: unknown } | { thrown: string }> {
  try {
    return { resolved: await promise };
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return code(error);
  }
  return undefined;
}

/**
 * `Notebook.deliver` through the real dispatcher: its `auth.recordAction`
 * check, its transaction, its receipt and its record-action admission.
 *
 * `handler` replaces the shipped `deliverToNotebook` with a probe, which is
 * how a test gets to stand inside the Operation's own transaction — after the
 * credential fence and the ACL lookup have passed and while their locks are
 * still held.
 */
async function dispatch(
  session: TrustedSessionContext,
  notebookId: string,
  handler?: ModuleOperationHandler,
  db: DatabaseRuntime = app,
): Promise<unknown> {
  const modules = handler
    ? loadedModules.map((module) => module.name === "notebook"
      ? { ...module, operationHandlers: { ...module.operationHandlers, deliverToNotebook: handler } }
      : module)
    : loadedModules;
  const bound = bindOperationHandlers(modules).get("Notebook.deliver");
  if (!bound) throw new Error("Notebook.deliver has no bound runtime handler.");
  const host = new ModulePlatformRuntime(db.db);
  return invokeOperation(bound, { notebookId, reference: `ref-${randomUUID()}` }, {
    transport: "operation",
    session,
    platform: host.services,
    db: db.db,
  });
}

/** A probe handler's required output envelope, so the contract validates. */
function accepted() {
  return {
    value: {
      status: "accepted" as const,
      deliveryId: randomUUID(),
      notebookName: "probe",
      priorDeliveries: 0,
    },
  };
}

/**
 * Dispatch `Notebook.deliver`, and hold the Operation's transaction open from
 * inside the handler until `release` resolves.
 *
 * `signal` fires once the handler is running, which is the moment the fence's
 * share locks and the ACL lock are all held and no effect has committed.
 */
function dispatchHolding(
  session: TrustedSessionContext,
  notebookId: string,
  signal: () => void,
  release: Promise<void>,
  db: DatabaseRuntime = app,
): Promise<unknown> {
  return dispatch(session, notebookId, async () => {
    signal();
    await release;
    return accepted();
  }, db);
}

/** Waits until `label` is genuinely blocked, and fails if it never is. */
async function awaitBlocked(label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const blocked = await admin.db.connection().execute(async (conn) =>
      (await sql<{ count: number }>`
        select count(*)::int as count
          from pg_stat_activity
         where application_name = ${label}
           and cardinality(pg_blocking_pids(pid)) > 0
      `.execute(conn)).rows[0]!.count);
    if (blocked > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} never blocked; the fence took no lock.`);
}

/**
 * A one-connection restricted runtime whose backend answers to `label`, so
 * `pg_blocking_pids` can name it. The pool is 1, so the labelled backend is
 * the one every later statement on this runtime uses.
 */
async function labelledRuntime(label: string): Promise<DatabaseRuntime> {
  const runtime = createDatabaseRuntime({
    databaseUrl: url(scratch, true),
    maxConnections: 1,
  });
  await sql`select set_config('application_name', ${label}, false)`.execute(runtime.db);
  return runtime;
}

async function keyState(keyId: string): Promise<{
  revoked: boolean;
  integrationStatus: string;
}> {
  const row = (await sql<{ revoked: boolean; integration_status: string }>`
    select k.revoked_at is not null as revoked, i.status as integration_status
      from platform.api_keys k
      join platform.api_key_integrations i on i.id = k.integration_id
     where k.id = ${keyId}::uuid
  `.execute(admin.db)).rows[0]!;
  return { revoked: row.revoked, integrationStatus: row.integration_status };
}

async function deliveryCount(): Promise<number> {
  return Number((await sql<{ count: string }>`
    select count(*)::text as count from notebook.notebook_deliveries
  `.execute(admin.db)).rows[0]!.count);
}

/** The fence alone, in the session's own transaction. */
async function live(session: TrustedSessionContext): Promise<boolean> {
  return withDbSession(app.db, session as DbSessionInput, async (trx) =>
    (await sql<{ live: boolean }>`
      select app.record_action_principal_live() as live
    `.execute(trx)).rows[0]?.live === true);
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch)) throw new Error("unsafe scratch database name");
  const modules = await loadRuntimeModules();
  expect(modules.failures).toEqual([]);
  loadedModules = modules.loaded;
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${scratch}"`);
  admin = createDatabaseRuntime({ databaseUrl: url(scratch), maxConnections: 4 });
  await admin.db.connection().execute((conn) => runMigrationChain(conn));

  await admin.db.connection().execute(async (conn) => {
    await sql`
      insert into platform.tenants (id, slug, name, status) values
        (${tenantA}::uuid, ${`fence-a-${tenantA.slice(0, 8)}`}, 'Fence tenant A', 'active'),
        (${tenantB}::uuid, ${`fence-b-${tenantB.slice(0, 8)}`}, 'Fence tenant B', 'active')
    `.execute(conn);
    // Three active integrations: the one the notebooks grant to, a sibling in
    // the same tenant, and one in another tenant. All ACTIVE, so every
    // refusal below is the fence's binding and not a disabled row.
    await sql`
      insert into platform.api_key_integrations
        (id, tenant_id, display_name, keycloak_client_id, status, granted_roles, created_by)
      values
        (${integration}::uuid, ${tenantA}::uuid, 'Partner robot',
          ${`osf-int-${integration}`}, 'active', cast('[]' as jsonb), ${manager}::uuid),
        (${siblingIntegration}::uuid, ${tenantA}::uuid, 'Sibling robot',
          ${`osf-int-${siblingIntegration}`}, 'active', cast('[]' as jsonb), ${manager}::uuid),
        (${foreignIntegration}::uuid, ${tenantB}::uuid, 'Foreign robot',
          ${`osf-int-${foreignIntegration}`}, 'active', cast('[]' as jsonb), ${manager}::uuid)
    `.execute(conn);
    for (const [label, own] of Object.entries(disposable)) {
      await sql`
        insert into platform.api_key_integrations
          (id, tenant_id, display_name, keycloak_client_id, status, granted_roles, created_by)
        values (${own.integration}::uuid, ${tenantA}::uuid, ${`Disposable ${label}`},
          ${`osf-int-${own.integration}`}, 'active', cast('[]' as jsonb), ${manager}::uuid)
      `.execute(conn);
    }

    const insertKey = async (
      id: string,
      owner: string,
      tenant: string,
      expiresAt: Date | null,
    ) => {
      await sql`
        insert into platform.api_keys
          (id, tenant_id, integration_id, lookup_id, secret_hash, display_name,
           expires_at, created_by)
        values (${id}::uuid, ${tenant}::uuid, ${owner}::uuid, ${`lookup-${id}`},
          ${"0".repeat(64)}, ${`key-${id.slice(0, 8)}`}, ${expiresAt}, ${manager}::uuid)
      `.execute(conn);
    };
    for (const id of [
      keys.revokeInFlight, keys.revokedFirst, keys.rotatedOut, keys.rotatedIn,
      keys.live, keys.lockOrder, keys.reverseOrder,
    ]) {
      await insertKey(id, integration, tenantA, null);
    }
    for (const own of Object.values(disposable)) {
      await insertKey(own.key, own.integration, tenantA, null);
    }
    await insertKey(keys.expired, integration, tenantA, new Date(Date.now() - 60_000));
    await insertKey(keys.sibling, siblingIntegration, tenantA, null);
    await insertKey(keys.foreign, foreignIntegration, tenantB, null);

    // Each notebook grants `deliver` to one application and names nobody for
    // view/edit/delete, which is the shape the axis exists for: authorized to
    // act, blind to the record.
    const grantedTo: Array<[string, string]> = Object.entries(notebooks).map(
      ([label, notebookId]) => [
        notebookId,
        label === "disableInFlight"
          ? disposable.disableInFlight.integration
          : label === "disabledFirst"
            ? disposable.disabledFirst.integration
            : integration,
      ],
    );
    for (const [notebookId, owner] of grantedTo) {
      const grant = JSON.stringify({ actions: { deliver: { integrations: [owner] } } });
      await sql`
        insert into notebook.notebooks (id, tenant_id, name, body, permissions)
        values (${notebookId}::uuid, ${tenantA}::uuid, ${`Notes ${notebookId.slice(0, 8)}`},
          'confidential body', ${sql.raw(`'${grant}'::jsonb`)})
      `.execute(conn);
    }
  });

  app = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 8 });
  const role = (await sql<{ superuser: boolean; bypass: boolean }>`
    select rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname = current_user
  `.execute(app.db)).rows[0]!;
  expect(role).toEqual({ superuser: false, bypass: false });
}, TEST_TIMEOUT);

// Bounded explicitly: dropping this file's scratch database closes the
// connections of every holder it opened, and on a loaded cluster that takes
// longer than the runner's default hook budget of five seconds — which would
// report a suite whose every assertion passed as a failure.
afterAll(async () => {
  await app?.close();
  await admin?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.close();
}, TEST_TIMEOUT);

describe("the fence function's own privileges", () => {
  test("it is an invoker function the app role alone may execute", async () => {
    const state = (await sql<{
      definer: boolean; owner: string; app: boolean; worker: boolean; anyone: boolean;
    }>`
      select p.prosecdef as definer, r.rolname as owner,
             has_function_privilege(${APP_ROLE}, p.oid, 'EXECUTE') as app,
             has_function_privilege(${WORKER_ROLE}, p.oid, 'EXECUTE') as worker,
             has_function_privilege('public', p.oid, 'EXECUTE') as anyone
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
       where n.nspname = 'app' and p.proname = 'record_action_principal_live'
    `.execute(admin.db)).rows[0]!;
    // NOT a definer, and not the record-action resolver's: it reads two
    // platform tables the restricted runtime role already holds tenant-fenced
    // DML on, so it carries no privilege of its own and widens nothing.
    expect(state.definer).toBe(false);
    expect(state.owner).not.toBe(databaseRole("recordActionResolver").name);
    expect({ app: state.app, worker: state.worker, anyone: state.anyone })
      .toEqual({ app: true, worker: false, anyone: false });
  }, TEST_TIMEOUT);
});

describe("a revocation and an action in flight cannot interleave", () => {
  test("the effect keeps the credential it checked, and the revoke waits for it", async () => {
    const revoker = await labelledRuntime("fence-revoke-second");
    try {
      const inside = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const delivering = dispatchHolding(
        application(keys.revokeInFlight), notebooks.revokeInFlight,
        inside.resolve, release.promise,
      );
      await inside.promise;

      // The REAL revoke, on its own connection. It takes the `for no key
      // update` every UPDATE takes on the credential row — the row the fence
      // is holding `for share` — so it cannot commit before the effect does.
      const revoking = revokeKey(serviceDeps(revoker.db), management(), keys.revokeInFlight);
      await awaitBlocked("fence-revoke-second");
      expect(await keyState(keys.revokeInFlight)).toEqual({
        revoked: false, integrationStatus: "active",
      });

      release.resolve();
      expect((await delivering as { value: { status: string } }).value.status).toBe("accepted");
      await revoking;
      expect((await keyState(keys.revokeInFlight)).revoked).toBe(true);

      // And the next action on the same credential is refused. That is the
      // explicit semantics of the in-flight order: an effect already
      // authorized completes under the credential it verified; the revocation
      // takes effect from the next one.
      expect(await refusal(dispatch(
        application(keys.revokeInFlight), notebooks.revokeInFlight,
      ))).toBe("FORBIDDEN");
    } finally {
      await revoker.close();
    }
  }, TEST_TIMEOUT);

  test("an action that starts while a revoke is open waits and then reads it", async () => {
    const holder = await labelledRuntime("fence-revoke-first");
    const actor = await labelledRuntime("fence-act-second");
    try {
      const revoked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // The real `revokeKey`, inside a transaction this test holds open: the
      // session input matches the one service.ts opens with, so the revoke
      // JOINS this transaction rather than committing in one of its own.
      const revoking = withDbSession(holder.db, managementSessionInput(), async () => {
        await revokeKey(serviceDeps(holder.db), management(), keys.revokedFirst);
        revoked.resolve();
        await release.promise;
        return "revoked" as const;
      });
      await revoked.promise;

      const acting = refusal(dispatch(
        application(keys.revokedFirst), notebooks.revokedFirst, undefined, actor,
      ));
      // Waiting on the credential row, not on a timer.
      await awaitBlocked("fence-act-second");
      release.resolve();
      expect(await revoking).toBe("revoked");
      // Not the state that was live when the action started: the committed
      // one. The fence re-reads after the lock is released.
      expect(await acting).toBe("FORBIDDEN");
    } finally {
      await holder.close();
      await actor.close();
    }
  }, TEST_TIMEOUT);
});

describe("disabling the integration behaves the same, one row earlier", () => {
  /** A session of the application that owns one of the disposable integrations. */
  const owner = (own: { integration: string; key: string }) =>
    application(own.key, {
      appPrincipal: { integrationId: own.integration, credentialId: own.key },
    });

  test("the disable waits for an action in flight", async () => {
    const own = disposable.disableInFlight;
    const disabler = await labelledRuntime("fence-disable-second");
    try {
      const inside = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const delivering = dispatchHolding(
        owner(own), notebooks.disableInFlight, inside.resolve, release.promise,
      );
      await inside.promise;

      // The REAL disable. Its FIRST statement updates the integration row —
      // the row the fence locked before it looked at the credential at all —
      // so this is the other half of the ordering, contending on the other
      // row.
      const disabling = disableIntegration(
        serviceDeps(disabler.db), management(), own.integration,
      );
      await awaitBlocked("fence-disable-second");
      expect(await keyState(own.key)).toEqual({
        revoked: false, integrationStatus: "active",
      });

      release.resolve();
      expect((await delivering as { value: { status: string } }).value.status).toBe("accepted");
      await disabling;
      // The disable takes the credential with it, which is what makes a
      // disable strictly stronger than a revoke.
      expect(await keyState(own.key)).toEqual({
        revoked: true, integrationStatus: "disabled",
      });
      expect(await live(owner(own))).toBe(false);
      expect(await refusal(dispatch(
        owner(own), notebooks.disableInFlight,
      ))).toBe("FORBIDDEN");
    } finally {
      await disabler.close();
    }
  }, TEST_TIMEOUT);

  test("an action that starts while a disable is open waits and then reads it", async () => {
    const own = disposable.disabledFirst;
    const holder = await labelledRuntime("fence-disable-first");
    const actor = await labelledRuntime("fence-disable-act-second");
    try {
      expect(await live(owner(own))).toBe(true);
      const disabled = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // The real `disableIntegration`, joined to a transaction this test
      // holds open at the moment it has written both rows and committed
      // neither.
      const disabling = withDbSession(holder.db, managementSessionInput(), async () => {
        await disableIntegration(serviceDeps(holder.db), management(), own.integration);
        disabled.resolve();
        await release.promise;
        return "disabled" as const;
      });
      await disabled.promise;

      const acting = refusal(dispatch(
        owner(own), notebooks.disabledFirst, undefined, actor,
      ));
      await awaitBlocked("fence-disable-act-second");
      release.resolve();
      expect(await disabling).toBe("disabled");
      expect(await acting).toBe("FORBIDDEN");
      expect(await keyState(own.key)).toEqual({
        revoked: true, integrationStatus: "disabled",
      });
    } finally {
      await holder.close();
      await actor.close();
    }
  }, TEST_TIMEOUT);

  test("a pending integration never authorized in the first place", async () => {
    // 'pending' means provisioning never finished. The store already refuses
    // to resolve a credential under one; the fence refuses the same row for
    // the same reason, so a session that reached this code some other way
    // holds nothing either.
    const pending = randomUUID();
    const pendingKey = randomUUID();
    await admin.db.connection().execute(async (conn) => {
      await sql`
        insert into platform.api_key_integrations
          (id, tenant_id, display_name, keycloak_client_id, status, granted_roles, created_by)
        values (${pending}::uuid, ${tenantA}::uuid, 'Half provisioned',
          ${`osf-int-${pending}`}, 'pending', cast('[]' as jsonb), ${manager}::uuid)
      `.execute(conn);
      await sql`
        insert into platform.api_keys
          (id, tenant_id, integration_id, lookup_id, secret_hash, display_name, created_by)
        values (${pendingKey}::uuid, ${tenantA}::uuid, ${pending}::uuid,
          ${`lookup-${pendingKey}`}, ${"0".repeat(64)}, 'pending key', ${manager}::uuid)
      `.execute(conn);
    });
    expect(await live(application(pendingKey, {
      appPrincipal: { integrationId: pending, credentialId: pendingKey },
    }))).toBe(false);
  }, TEST_TIMEOUT);
});

describe("expiry is the wall clock, and rotation retires exactly one credential", () => {
  test("an expired credential holds nothing", async () => {
    expect(await live(application(keys.expired))).toBe(false);
    expect(await refusal(dispatch(
      application(keys.expired), notebooks.expiry,
    ))).toBe("FORBIDDEN");
  }, TEST_TIMEOUT);

  test("a credential that expires mid-transaction is refused on the wall clock", async () => {
    // `now()` is the transaction's START. A transaction that opened before a
    // key's expiry and asks after it is still inside its own `now()`, so a
    // fence written that way would pass a credential that has in fact
    // expired. `clock_timestamp()` is what makes the answer honest, and this
    // is the interleaving that tells the two apart.
    //
    // The window is minted inside the test rather than in the fixture: an
    // expiry relative to fixture time would have passed by the time the file
    // reaches this line, and the test would pass without proving anything.
    const key = randomUUID();
    // The expiry is stamped by the SERVER, at insert time, so the window
    // starts when the row exists rather than when this process decided to
    // write it — and the transaction below opens inside it however slow the
    // insert was.
    const expiresAt = await admin.db.connection().execute(async (conn) =>
      (await sql<{ expires_at: Date }>`
        insert into platform.api_keys
          (id, tenant_id, integration_id, lookup_id, secret_hash, display_name,
           expires_at, created_by)
        values (${key}::uuid, ${tenantA}::uuid, ${integration}::uuid,
          ${`lookup-${key}`}, ${"0".repeat(64)}, 'expiring key',
          clock_timestamp() + interval '5 seconds', ${manager}::uuid)
        returning expires_at
      `.execute(conn)).rows[0]!.expires_at);
    const observed = await withDbSession(
      app.db,
      application(key) as DbSessionInput,
      async (trx) => {
        const before = (await sql<{ live: boolean }>`
          select app.record_action_principal_live() as live
        `.execute(trx)).rows[0]!.live;
        while (Date.now() <= expiresAt.getTime() + 500) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const after = (await sql<{ live: boolean; stale: boolean }>`
          select app.record_action_principal_live() as live,
                 now() < ${expiresAt} as stale
        `.execute(trx)).rows[0]!;
        return { before, after };
      },
    );
    // Valid when the transaction opened, and the transaction's own clock
    // still says so — while the fence, reading the wall clock, does not.
    expect(observed.before).toBe(true);
    expect(observed.after.stale).toBe(true);
    expect(observed.after.live).toBe(false);
    // And outside any transaction it is simply an expired credential.
    expect(await live(application(key))).toBe(false);
    expect(await refusal(dispatch(application(key), notebooks.expiry))).toBe("FORBIDDEN");
  }, TEST_TIMEOUT);

  test("rotation keeps the grant and retires one credential", async () => {
    const retired = application(keys.rotatedOut);
    const fresh = application(keys.rotatedIn);
    // Two credentials, one application, one grant: both act.
    expect(await live(retired)).toBe(true);
    expect(await live(fresh)).toBe(true);
    expect((await dispatch(retired, notebooks.rotation) as
      { value: { status: string } }).value.status).toBe("accepted");

    await revokeKey(serviceDeps(app.db), management(), keys.rotatedOut);

    // The retired half holds nothing; the fresh half is untouched, and so is
    // the record's grant — which names the integration and knows nothing
    // about either key.
    expect(await live(retired)).toBe(false);
    expect(await refusal(dispatch(retired, notebooks.rotation))).toBe("FORBIDDEN");
    expect(await live(fresh)).toBe(true);
    expect((await dispatch(fresh, notebooks.rotation) as
      { value: { status: string } }).value.status).toBe("accepted");
  }, TEST_TIMEOUT);
});

describe("the fence is bound to one tenant and one integration", () => {
  test("another tenant's live credential cannot stand in", async () => {
    // The attack: the application's own key is revoked, so it presents the id
    // of a credential that IS live — in another tenant. Both rows exist, both
    // are active, and the session names the integration the record grants to.
    const revoked = randomUUID();
    await admin.db.connection().execute(async (conn) => {
      await sql`
        insert into platform.api_keys
          (id, tenant_id, integration_id, lookup_id, secret_hash, display_name,
           revoked_at, created_by)
        values (${revoked}::uuid, ${tenantA}::uuid, ${integration}::uuid,
          ${`lookup-${revoked}`}, ${"0".repeat(64)}, 'revoked key', now(), ${manager}::uuid)
      `.execute(conn);
    });
    expect(await live(application(revoked))).toBe(false);
    const borrowed = application(keys.foreign);
    expect(await live(borrowed)).toBe(false);
    expect(await refusal(dispatch(borrowed, notebooks.attacks))).toBe("FORBIDDEN");
    // Nor the other way round: the foreign credential with its own foreign
    // integration, pointed at this tenant's record.
    expect(await live(application(keys.foreign, {
      appPrincipal: { integrationId: foreignIntegration, credentialId: keys.foreign },
    }))).toBe(false);
  }, TEST_TIMEOUT);

  test("a sibling integration's live credential cannot stand in either", async () => {
    // Same tenant, both integrations active, the credential genuinely live —
    // and it belongs to the other application. The fence requires the
    // credential to name the integration the session claims, so a session
    // cannot keep the grant of one application alive on the key of another.
    expect(await live(application(keys.sibling))).toBe(false);
    expect(await refusal(dispatch(
      application(keys.sibling), notebooks.attacks,
    ))).toBe("FORBIDDEN");
    // The sibling's own session is coherent, and holds nothing on a record
    // that does not name it — the grant refusing where the fence would pass.
    const coherent = application(keys.sibling, {
      appPrincipal: { integrationId: siblingIntegration, credentialId: keys.sibling },
    });
    expect(await live(coherent)).toBe(true);
    expect(await refusal(dispatch(coherent, notebooks.attacks))).toBe("FORBIDDEN");
  }, TEST_TIMEOUT);

  test("every other principal class passes the fence unchanged", async () => {
    // Nothing here alters an existing human or bearer session: they carry no
    // API-key credential to withdraw, so the fence answers true without
    // reading a row. What refuses them is the axis itself, as before.
    const base = application(keys.live);
    const { appPrincipal: _absent, ...carrier } = base;
    for (const session of [
      { ...carrier, credential: "bearer" as const, principalKind: "person" as const },
      { ...carrier, credential: "bearer" as const },
      { ...carrier, credential: "trusted-context" as const },
    ]) {
      expect(await live(session)).toBe(true);
    }
  }, TEST_TIMEOUT);
});

describe("a failed action commits nothing and leaves the credential usable", () => {
  test("the handler's failure rolls back the whole invocation", async () => {
    const before = await deliveryCount();
    const deliveryId = randomUUID();
    const failed = await outcome(dispatch(
      application(keys.live), notebooks.rollback,
      async (_input, context) => {
        // A write of the module's own, in the Operation's transaction, after
        // the fence and the ACL lookup passed — and then a failure.
        await context.platform!.db.withSession(context.session!, async (trx) => {
          await sql`
            insert into notebook.notebook_deliveries
              (id, tenant_id, notebook_id, integration_id, reference, notebook_name)
            values (${deliveryId}::uuid, ${tenantA}::uuid, ${notebooks.rollback}::uuid,
              ${integration}::uuid, ${`ref-${deliveryId}`}, 'rolled back')
          `.execute(trx as Transaction<DB>);
        });
        throw new Error("the effect failed after it was authorized");
      },
    ));
    // The handler's own failure, raised rather than degraded into a result.
    expect(failed).toEqual({ thrown: "the effect failed after it was authorized" });
    // Nothing of the failed invocation survived.
    expect(await deliveryCount()).toBe(before);
    expect((await sql<{ count: string }>`
      select count(*)::text as count from notebook.notebook_deliveries
       where id = ${deliveryId}::uuid
    `.execute(admin.db)).rows[0]!.count).toBe("0");
    // And the fence released what it held: the credential is neither revoked
    // nor stuck, and the next action goes through.
    expect(await keyState(keys.live)).toEqual({
      revoked: false, integrationStatus: "active",
    });
    expect((await dispatch(application(keys.live), notebooks.rollback) as
      { value: { status: string } }).value.status).toBe("accepted");
  }, TEST_TIMEOUT);
});

describe("the lock order is integration, then credential", () => {
  /**
   * The order a disable writes in, taken `for share` so concurrent holders do
   * not serialize. Both interleavings below run against the real
   * `disableIntegration` and the real `revokeKey`; the point is that neither
   * produces a cycle, in either direction, on either row.
   */
  test("neither interleaving deadlocks", async () => {
    const owner = randomUUID();
    const key = randomUUID();
    await admin.db.connection().execute(async (conn) => {
      await sql`
        insert into platform.api_key_integrations
          (id, tenant_id, display_name, keycloak_client_id, status, granted_roles, created_by)
        values (${owner}::uuid, ${tenantA}::uuid, 'Order probe',
          ${`osf-int-${owner}`}, 'active', cast('[]' as jsonb), ${manager}::uuid)
      `.execute(conn);
      await sql`
        insert into platform.api_keys
          (id, tenant_id, integration_id, lookup_id, secret_hash, display_name, created_by)
        values (${key}::uuid, ${tenantA}::uuid, ${owner}::uuid, ${`lookup-${key}`},
          ${"0".repeat(64)}, 'order key', ${manager}::uuid)
      `.execute(conn);
    });
    const session = application(key, {
      appPrincipal: { integrationId: owner, credentialId: key },
    });
    const fencer = await labelledRuntime("fence-order-fence");
    const writer = await labelledRuntime("fence-order-writer");
    try {
      // Fence first, then the disable: the disable waits on the integration
      // row and the fence completes.
      const fenced = Promise.withResolvers<void>();
      const releaseFence = Promise.withResolvers<void>();
      const fencing = withDbSession(fencer.db, session as DbSessionInput, async (trx) => {
        const answer = (await sql<{ live: boolean }>`
          select app.record_action_principal_live() as live
        `.execute(trx)).rows[0]!.live;
        fenced.resolve();
        await releaseFence.promise;
        return answer;
      });
      await fenced.promise;
      const disabling = disableIntegration(serviceDeps(writer.db), management(), owner);
      await awaitBlocked("fence-order-writer");
      releaseFence.resolve();
      // Both complete; neither is a deadlock victim.
      expect(await fencing).toBe(true);
      await disabling;

      // Writer first, then the fence: the fence waits and reads the result.
      // Held open with the real disable joined to this transaction, so the
      // contention is against the statements the service actually issues.
      const secondOwner = randomUUID();
      const secondKey = randomUUID();
      await admin.db.connection().execute(async (conn) => {
        await sql`
          insert into platform.api_key_integrations
            (id, tenant_id, display_name, keycloak_client_id, status, granted_roles, created_by)
          values (${secondOwner}::uuid, ${tenantA}::uuid, 'Order probe two',
            ${`osf-int-${secondOwner}`}, 'active', cast('[]' as jsonb), ${manager}::uuid)
        `.execute(conn);
        await sql`
          insert into platform.api_keys
            (id, tenant_id, integration_id, lookup_id, secret_hash, display_name, created_by)
          values (${secondKey}::uuid, ${tenantA}::uuid, ${secondOwner}::uuid,
            ${`lookup-${secondKey}`}, ${"0".repeat(64)}, 'order key two', ${manager}::uuid)
        `.execute(conn);
      });
      const second = application(secondKey, {
        appPrincipal: { integrationId: secondOwner, credentialId: secondKey },
      });
      const written = Promise.withResolvers<void>();
      const releaseWriter = Promise.withResolvers<void>();
      const writing = withDbSession(writer.db, managementSessionInput(), async () => {
        await disableIntegration(serviceDeps(writer.db), management(), secondOwner);
        written.resolve();
        await releaseWriter.promise;
        return "disabled" as const;
      });
      await written.promise;
      const waiting = withDbSession(fencer.db, second as DbSessionInput, async (trx) =>
        (await sql<{ live: boolean }>`
          select app.record_action_principal_live() as live
        `.execute(trx)).rows[0]!.live);
      await awaitBlocked("fence-order-fence");
      releaseWriter.resolve();
      expect(await writing).toBe("disabled");
      expect(await waiting).toBe(false);
    } finally {
      await fencer.close();
      await writer.close();
    }
  }, TEST_TIMEOUT);

  test("two holders of two credentials under one integration do not serialize", async () => {
    // `for share` is self-compatible and the fence never upgrades it, so a
    // busy integration's actions run in parallel rather than queueing behind
    // each other. Proven by both fences answering while both transactions are
    // still open.
    const first = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const secondRuntime = createDatabaseRuntime({
      databaseUrl: url(scratch, true), maxConnections: 1,
    });
    try {
      const both = Promise.withResolvers<void>();
      let answered = 0;
      const hold = (runtime: DatabaseRuntime, key: string) =>
        withDbSession(runtime.db, application(key) as DbSessionInput, async (trx) => {
          const answer = (await sql<{ live: boolean }>`
            select app.record_action_principal_live() as live
          `.execute(trx)).rows[0]!.live;
          answered += 1;
          if (answered === 2) both.resolve();
          await both.promise;
          return answer;
        });
      expect(await Promise.all([
        hold(first, keys.lockOrder),
        hold(secondRuntime, keys.reverseOrder),
      ])).toEqual([true, true]);
    } finally {
      await first.close();
      await secondRuntime.close();
    }
  }, TEST_TIMEOUT);

  test("the reverse order deadlocks, which is why the fence takes this one", async () => {
    // Not a claim about the shipped fence — a claim about the order it chose.
    // Locking the credential before the integration is what a reader might
    // consider equivalent; against the real `disableIntegration`, which
    // writes the integration and then the keys, it is a cycle, and PostgreSQL
    // resolves it by aborting one of the two.
    const owner = randomUUID();
    const key = randomUUID();
    await admin.db.connection().execute(async (conn) => {
      await sql`
        insert into platform.api_key_integrations
          (id, tenant_id, display_name, keycloak_client_id, status, granted_roles, created_by)
        values (${owner}::uuid, ${tenantA}::uuid, 'Reverse probe',
          ${`osf-int-${owner}`}, 'active', cast('[]' as jsonb), ${manager}::uuid)
      `.execute(conn);
      await sql`
        insert into platform.api_keys
          (id, tenant_id, integration_id, lookup_id, secret_hash, display_name, created_by)
        values (${key}::uuid, ${tenantA}::uuid, ${owner}::uuid, ${`lookup-${key}`},
          ${"0".repeat(64)}, 'reverse key', ${manager}::uuid)
      `.execute(conn);
    });
    const reversed = createDatabaseRuntime({
      databaseUrl: url(scratch, true), maxConnections: 1,
    });
    const writer = createDatabaseRuntime({
      databaseUrl: url(scratch, true), maxConnections: 1,
    });
    try {
      const keyLocked = Promise.withResolvers<void>();
      const integrationLocked = Promise.withResolvers<void>();
      // A fence written the other way round: credential first.
      const backwards = withDbSession(
        reversed.db,
        application(key, { appPrincipal: { integrationId: owner, credentialId: key } }) as DbSessionInput,
        async (trx) => {
          await sql`
            select k.id from platform.api_keys k
             where k.id = ${key}::uuid and k.tenant_id = ${tenantA}::uuid for share
          `.execute(trx);
          keyLocked.resolve();
          await integrationLocked.promise;
          await sql`
            select i.id from platform.api_key_integrations i
             where i.id = ${owner}::uuid and i.tenant_id = ${tenantA}::uuid for share
          `.execute(trx);
          return "fenced" as const;
        },
      );
      await keyLocked.promise;
      const disabling = withDbSession(writer.db, managementSessionInput(), async (trx) => {
        await sql`
          update platform.api_key_integrations set status = 'disabled', updated_at = now()
           where id = ${owner}::uuid and tenant_id = ${tenantA}::uuid
        `.execute(trx);
        integrationLocked.resolve();
        await sql`
          update platform.api_keys set revoked_at = coalesce(revoked_at, now())
           where integration_id = ${owner}::uuid and tenant_id = ${tenantA}::uuid
        `.execute(trx);
        return "disabled" as const;
      });
      const outcomes = await Promise.allSettled([backwards, disabling]);
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(failures).toHaveLength(1);
      expect(String((failures[0] as PromiseRejectedResult).reason)).toMatch(/deadlock/i);
    } finally {
      await reversed.close();
      await writer.close();
    }
  }, TEST_TIMEOUT);
});
