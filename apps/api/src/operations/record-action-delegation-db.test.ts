// SPDX-License-Identifier: BUSL-1.1
/**
 * Delegating a named record action, against a migrated scratch database and
 * through the RESTRICTED app role the API actually connects as.
 *
 * What these tests are for, in order of how badly each would hurt:
 *
 *   1. a record editor with no integration-management right cannot hand a
 *      tenant's integration the right to act on the record — not through the
 *      delegation Operation, and not through an ordinary update either;
 *   2. the manager who does hold that right can, and the grant then means
 *      exactly what the runtime lookup reads back, with the record still
 *      unreadable to the application it was granted to;
 *   3. an integration that is another tenant's, disabled or absent is one
 *      refusal and writes nothing;
 *   4. the delta cannot lose a concurrent administrator's grant, and an
 *      ordinary write cannot revoke one by omission or by handing back a
 *      stale document;
 *   5. the change is journalled like every other change to the record.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely, type Transaction } from "kysely";
import { operationErrorOf } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { API_KEY_MANAGE_ROLE } from "../auth/api-key/ceiling.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../db/connection.js";
import type { DB } from "../generated/db/types.js";
import manifest from "../generated/db/manifest.json" with { type: "json" };
import { runMigrationChain } from "../db/migration-chain.js";
import { applyAuditHistory } from "../db/migrations/audit-history.js";
import { APP_ROLE } from "../db/migrations/app-role.js";
import {
  applyRecordActionsMigration,
  type RecordActionEntity,
} from "../db/migrations/record-actions.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import {
  __registerGeneratedCrudTableForTests,
  createGeneratedEntityForTable,
  mergeGeneratedEntityObjectForTable,
  updateGeneratedEntityForTable,
} from "./entity/index.js";
import type { GeneratedCrudTable } from "./entity/types.js";
import type { ModuleOperationContext } from "../modules/contract.js";
import { recordActionOperationHandler } from "./record-action-operations.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = process.env.SCRATCH_APP_ROLE_PASSWORD ?? "openshapeforge_app";
const TEST_TIMEOUT = 180_000;
const scratch = `record_delegation_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const tenantA = randomUUID();
const tenantB = randomUUID();
/** Holds the record's view and edit, and the entity's update role. */
const editor = randomUUID();
/** The same, plus the integration-management role. */
const manager = randomUUID();
const outsider = randomUUID();
const relationGroup = randomUUID();
const EDITOR_ROLE = "Runs.All.ReadWrite";
const FOLLOW_ROLE = "Runs.All.Follow";

const activeIntegration = randomUUID();
/** `platform.api_keys.id` of the one live credential of `activeIntegration`. */
const liveCredential = randomUUID();
const secondIntegration = randomUUID();
const disabledIntegration = randomUUID();
const foreignIntegration = randomUUID();

const ENTITY = "DelegatedRun";
const SCHEMA = "erp";
const TABLE = "delegated_runs";
const ACTIONS: RecordActionEntity[] = [
  {
    entity: ENTITY, schema: SCHEMA, table: TABLE,
    keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
    // `start` is an application's; `follow` admits either; `review` is a
    // person's only, so the principal-kind refusal has something to refuse.
    actions: ["follow", "review", "start"],
    // The compiler always emits a mode per action; `exclusive` is its default
    // and the one under which two parallel holders cannot deadlock.
    locks: { follow: "exclusive", review: "exclusive", start: "exclusive" },
    reads: { start: [{ field: "definition", column: "definition" }] },
  },
];

/** The manifest entry the compiler would emit for this entity. */
const table = {
  schema: SCHEMA, table: TABLE, name: TABLE,
  tenantScoped: true, primaryKey: "id", generatedCrudEligible: true,
  columns: [
    { name: "id", type: "uuid", primaryKey: true, sourceField: "id" },
    { name: "tenant_id", type: "uuid", sourceField: "tenantId" },
    { name: "title", type: "text", sourceField: "title" },
    { name: "definition", type: "text", sourceField: "definition" },
    { name: "acl", type: "jsonb", sourceField: "authorization" },
    { name: "updated_at", type: "timestamptz", sourceField: "updatedAt" },
  ],
  realtime: { visibilityColumns: [] },
  source: {
    authoringEntityName: ENTITY,
    graphql: { typeName: ENTITY, singleQueryName: ENTITY, relationships: [] },
    crud: { operations: { list: true, get: true, create: true, update: true, delete: true } },
    authorization: {
      roles: {
        read: [EDITOR_ROLE], create: [EDITOR_ROLE],
        update: [EDITOR_ROLE], delete: [EDITOR_ROLE],
      },
      recordPermissions: {
        field: "authorization", column: "acl", empty: "restricted",
        createRequires: ["view", "edit"],
        actions: [
          { name: "follow", principals: ["integration", "person"] },
          { name: "review", principals: ["person"] },
          { name: "start", principals: ["integration"], reads: ["definition"] },
        ],
      },
    },
  },
} as unknown as GeneratedCrudTable;

function url(name: string, app = false): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${name}`;
  if (app) {
    parsed.username = APP_ROLE;
    parsed.password = APP_ROLE_PASSWORD;
  }
  return parsed.toString();
}

/** A session as the server would have classified it, never as a caller asks. */
function person(userId: string, roles: readonly string[]): TrustedSessionContext {
  return {
    tenantId: tenantA, userId, roles: [...roles], groups: [],
    relationGroupIds: [], scope: "tenant", credential: "bearer",
    principalKind: "person",
  } as unknown as TrustedSessionContext;
}

/**
 * An API-key session as the resolver builds one: the integration it acts as
 * AND the credential row that authenticated it. Both are required of the
 * carrier (auth/trusted-context.ts, VerifiedAppPrincipal), so a fixture that
 * named only the integration would be a session this server never produces.
 * `app.record_action_allows` reads neither — the credential fence is its own
 * function — so a synthetic credential id is the honest fixture here.
 */
/**
 * The resolved application behind the one live credential: the carrier a
 * RUNNING action arrives on, and the only class whose transaction gate takes
 * the credential fence's locks.
 */
function liveApplication(): DbSessionInput {
  return {
    tenantId: tenantA, userId: randomUUID(), roles: [], groups: [],
    relationGroupIds: [], scope: "tenant", credential: "api-key",
    principalKind: "service",
    appPrincipal: { integrationId: activeIntegration, credentialId: liveCredential },
  } as unknown as DbSessionInput;
}

function apiKeySession(integrationId: string, roles: readonly string[] = []): TrustedSessionContext {
  return {
    tenantId: tenantA, userId: randomUUID(), roles: [...roles], groups: [],
    relationGroupIds: [], scope: "tenant", credential: "api-key",
    principalKind: "service",
    appPrincipal: { integrationId, credentialId: randomUUID() },
  } as unknown as TrustedSessionContext;
}

let server: SQL;
let admin: DatabaseRuntime;
let app: DatabaseRuntime;
let release: () => void;

type Delegated = {
  entity: string; recordId: string; action: string; changed: boolean;
  subjects: Record<"users" | "groups" | "roles" | "integrations", string[]>;
};

async function run(
  input: Record<string, unknown>,
  session: TrustedSessionContext,
  runtime: DatabaseRuntime = app,
): Promise<Delegated> {
  const result = await recordActionOperationHandler({
    key: "delegate", handler: "delegateRecordAction",
  })(input, {
    db: runtime.db, session, transport: "operation",
  } as unknown as ModuleOperationContext);
  if (!("value" in result)) throw new Error("Expected a successful delegation.");
  return result.value as Delegated;
}

async function refusalOf(call: Promise<unknown>): Promise<{ code: string; detail?: string }> {
  try {
    await call;
  } catch (error) {
    const failure = operationErrorOf(error);
    if (failure) return { code: failure.code, ...(failure.detail ? { detail: failure.detail } : {}) };
    throw error;
  }
  throw new Error("Expected the Operation to refuse.");
}

/** The runtime lookup, i.e. what the grant actually means at invocation time. */
async function holdsAction(
  db: Kysely<DB>, input: DbSessionInput, recordId: string, action: string,
): Promise<boolean> {
  return withDbSession(db, input, async (trx) =>
    (await sql<{ allowed: boolean | null }>`
      select app.record_action_allows(${ENTITY}, ${recordId}, ${action}) as allowed
    `.execute(trx)).rows[0]?.allowed === true);
}

async function storedAcl(recordId: string): Promise<Record<string, unknown>> {
  return admin.db.connection().execute(async (conn) =>
    (await sql<{ acl: Record<string, unknown> }>`
      select acl from ${sql.id(SCHEMA, TABLE)} where id = ${recordId}::uuid
    `.execute(conn)).rows[0]!.acl);
}

const BASE_ACL = {
  view: { users: [editor, manager] },
  edit: { users: [editor, manager] },
};

let record: string;

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch)) throw new Error("unsafe scratch database name");
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${scratch}"`);
  admin = createDatabaseRuntime({ databaseUrl: url(scratch), maxConnections: 4 });
  await admin.db.connection().execute((conn) => runMigrationChain(conn));

  await admin.db.connection().execute(async (conn) => {
    const target = sql.id(SCHEMA, TABLE);
    await sql`
      create table ${target} (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null,
        title text not null default 'run',
        definition text not null default 'graph',
        acl jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now()
      )
    `.execute(conn);
    await sql`alter table ${target} enable row level security`.execute(conn);
    await sql`alter table ${target} force row level security`.execute(conn);
    // The shape the compiler emits: reads gated on the record's `view`.
    await sql`
      create policy ${sql.id(`${TABLE}_row_scope`)} on ${target}
      using (
        app.bypass_rls() or (
          tenant_id = app.current_tenant()
          and app.record_permission_allows("acl", 'view', false)
        )
      )
      with check (app.bypass_rls() or tenant_id = app.current_tenant())
    `.execute(conn);
    await sql.raw(
      `grant select, insert, update, delete on ${SCHEMA}.${TABLE} to ${APP_ROLE}`,
    ).execute(conn);
    await sql`
      insert into platform.tenants (id, name, slug, status, keycloak_realm)
      values (${tenantA}::uuid, 'Tenant A', ${`a-${scratch}`}, 'active', 'openshapeforge'),
             (${tenantB}::uuid, 'Tenant B', ${`b-${scratch}`}, 'active', 'openshapeforge')
      on conflict (id) do nothing
    `.execute(conn);
    // The integrations a delegation may and may not name.
    await sql`
      insert into platform.api_key_integrations
        (id, tenant_id, display_name, keycloak_client_id, status, created_by)
      values
        (${activeIntegration}::uuid, ${tenantA}::uuid, 'active', ${`c-${randomUUID()}`}, 'active', ${manager}::uuid),
        (${secondIntegration}::uuid, ${tenantA}::uuid, 'second', ${`c-${randomUUID()}`}, 'active', ${manager}::uuid),
        (${disabledIntegration}::uuid, ${tenantA}::uuid, 'disabled', ${`c-${randomUUID()}`}, 'disabled', ${manager}::uuid),
        (${foreignIntegration}::uuid, ${tenantB}::uuid, 'foreign', ${`c-${randomUUID()}`}, 'active', ${manager}::uuid)
    `.execute(conn);
    // One live credential behind the active integration. The lock-order
    // tests below need the RUNNING action's fence
    // (`app.record_action_principal_live`) to take its real `for share` locks
    // on the integration and the key, which it only does for a session whose
    // verified class is `application`.
    await sql`
      insert into platform.api_keys
        (id, tenant_id, integration_id, lookup_id, secret_hash, display_name, created_by)
      values (${liveCredential}::uuid, ${tenantA}::uuid, ${activeIntegration}::uuid,
        ${`lookup-${liveCredential}`}, ${"0".repeat(64)}, 'live key', ${manager}::uuid)
    `.execute(conn);
    await applyRecordActionsMigration(conn, ACTIONS);
    // The row-journal trigger this entity would have had, so the delegation's
    // audit trail is the real one rather than an assumption.
    await applyAuditHistory(conn, [
      ...(manifest.tables as unknown as GeneratedCrudTable[]),
      table,
    ]);
  });
  release = __registerGeneratedCrudTableForTests(table);
  app = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 6 });
}, TEST_TIMEOUT);

afterAll(async () => {
  release?.();
  await app?.close();
  await admin?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.close();
});

/**
 * One fresh record per test, so no test can pass on another's grant.
 *
 * Given the file's own timeout rather than the default five seconds: the
 * lock-order tests leave real contention behind them, and a hook that waits
 * for it is waiting correctly rather than hanging.
 */
beforeEach(async () => {
  record = randomUUID();
  await admin.db.connection().execute((conn) =>
    sql`insert into ${sql.id(SCHEMA, TABLE)} (id, tenant_id, acl)
      values (${record}::uuid, ${tenantA}::uuid,
        ${sql.raw(`'${JSON.stringify(BASE_ACL)}'::jsonb`)})`.execute(conn));
}, TEST_TIMEOUT);

describe("who may delegate a record action", () => {
  test("a record editor without the integration right cannot grant an integration", async () => {
    const refusal = await refusalOf(run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, person(editor, [EDITOR_ROLE])));
    expect(refusal.code).toBe("FORBIDDEN");
    expect(refusal.detail).toContain("integration-management authority");
    // And nothing was written, so the application holds nothing.
    expect(await storedAcl(record)).toEqual(BASE_ACL);
    expect(await holdsAction(app.db, apiKeySession(activeIntegration), record, "start")).toBe(false);
  }, TEST_TIMEOUT);

  test("the manager may, and the grant is what the runtime lookup reads back", async () => {
    const result = await run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]));
    expect(result).toEqual({
      entity: ENTITY, recordId: record, action: "start", changed: true,
      subjects: { users: [], groups: [], roles: [], integrations: [activeIntegration] },
    });
    expect(await holdsAction(app.db, apiKeySession(activeIntegration), record, "start")).toBe(true);
    // Another integration gets nothing from it, and neither does a person.
    expect(await holdsAction(app.db, apiKeySession(secondIntegration), record, "start")).toBe(false);
    expect(await holdsAction(app.db, person(editor, [EDITOR_ROLE]), record, "start")).toBe(false);
    // Holding the action still does not make the record readable.
    const visible = await withDbSession(app.db, apiKeySession(activeIntegration), async (trx) =>
      (await sql<{ count: number }>`select count(*)::int as count from ${sql.id(SCHEMA, TABLE)}`
        .execute(trx)).rows[0]!.count);
    expect(visible).toBe(0);
  }, TEST_TIMEOUT);

  test("a person subject needs only the record's editor authority", async () => {
    // Granting a person an action is the same kind of decision as rewriting
    // view/edit/delete, so it asks for the same authority and no more.
    const result = await run({
      entity: ENTITY, recordId: record, action: "review",
      grant: { users: [outsider], roles: [FOLLOW_ROLE], groups: [relationGroup] },
    }, person(editor, [EDITOR_ROLE]));
    expect(result.changed).toBe(true);
    expect(await holdsAction(app.db, person(outsider, []), record, "review")).toBe(true);
    expect(await holdsAction(
      app.db, { ...person(randomUUID(), [FOLLOW_ROLE]) } as DbSessionInput, record, "review",
    )).toBe(true);
    // An application is never matched against a person subject.
    expect(await holdsAction(app.db, apiKeySession(activeIntegration), record, "review")).toBe(false);
  }, TEST_TIMEOUT);

  test("an api-key session may not delegate, however many roles it holds", async () => {
    const refusal = await refusalOf(run({
      entity: ENTITY, recordId: record, action: "follow",
      grant: { integrations: [activeIntegration] },
    }, apiKeySession(activeIntegration, [EDITOR_ROLE, API_KEY_MANAGE_ROLE])));
    expect(refusal.code).toBe("FORBIDDEN");
    expect(await storedAcl(record)).toEqual(BASE_ACL);
  }, TEST_TIMEOUT);

  test("a verified service bearer may not delegate either", async () => {
    const service = {
      ...person(randomUUID(), [EDITOR_ROLE, API_KEY_MANAGE_ROLE]),
      principalKind: "service",
    } as unknown as TrustedSessionContext;
    expect((await refusalOf(run({
      entity: ENTITY, recordId: record, action: "review", grant: { users: [outsider] },
    }, service))).code).toBe("FORBIDDEN");
  }, TEST_TIMEOUT);

  test("the entity's update role and the record's edit permission both gate it", async () => {
    // Holds the management role, not the entity's update role.
    expect((await refusalOf(run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, person(manager, [API_KEY_MANAGE_ROLE])))).code).toBe("FORBIDDEN");
    // Holds both roles, and the record names it for view but not for edit:
    // the record permission is a second, independent gate.
    const viewOnly = randomUUID();
    await admin.db.connection().execute((conn) =>
      sql`update ${sql.id(SCHEMA, TABLE)}
        set acl = acl || ${sql.raw(`'${JSON.stringify({
          view: { users: [editor, manager, viewOnly] },
        })}'::jsonb`)}
        where id = ${record}::uuid`.execute(conn));
    expect((await refusalOf(run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, person(viewOnly, [EDITOR_ROLE, API_KEY_MANAGE_ROLE])))).code).toBe("FORBIDDEN");
    // And a caller the record does not even show gets the same answer every
    // unreadable record gives, rather than one that confirms it exists.
    expect((await refusalOf(run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, person(outsider, [EDITOR_ROLE, API_KEY_MANAGE_ROLE])))).code).toBe("NOT_FOUND");
    expect((await storedAcl(record)).actions).toBeUndefined();
  }, TEST_TIMEOUT);

  test("an undeclared action, a permission and a foreign entity are refused", async () => {
    const admin_ = person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]);
    for (const action of ["publish", "view", "edit", "delete"]) {
      expect((await refusalOf(run({
        entity: ENTITY, recordId: record, action, grant: { users: [outsider] },
      }, admin_))).code).toBe("BAD_USER_INPUT");
    }
    // An entity with no record ACL at all, and one outside the catalog.
    expect((await refusalOf(run({
      entity: "Relation", recordId: record, action: "start", grant: { users: [outsider] },
    }, admin_))).code).toBe("FORBIDDEN");
    expect((await refusalOf(run({
      entity: "NoSuchEntity", recordId: record, action: "start", grant: { users: [outsider] },
    }, admin_))).code).toBe("GENERATED_CRUD_NOT_ENABLED");
  }, TEST_TIMEOUT);

  test("a principal kind the action does not admit is refused", async () => {
    const admin_ = person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]);
    expect((await refusalOf(run({
      entity: ENTITY, recordId: record, action: "review",
      grant: { integrations: [activeIntegration] },
    }, admin_))).code).toBe("VALIDATION");
    expect((await refusalOf(run({
      entity: ENTITY, recordId: record, action: "start", grant: { users: [outsider] },
    }, admin_))).code).toBe("VALIDATION");
    expect(await storedAcl(record)).toEqual(BASE_ACL);
  }, TEST_TIMEOUT);
});

describe("which integration a delegation may name", () => {
  const admin_ = () => person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]);

  test("another tenant's, a disabled and an absent integration are one refusal", async () => {
    for (const integrationId of [foreignIntegration, disabledIntegration, randomUUID()]) {
      const refusal = await refusalOf(run({
        entity: ENTITY, recordId: record, action: "start",
        grant: { integrations: [integrationId] },
      }, admin_()));
      expect(refusal.code).toBe("NOT_FOUND");
      expect(refusal.detail).toContain(integrationId);
    }
    expect(await storedAcl(record)).toEqual(BASE_ACL);
  }, TEST_TIMEOUT);

  test("one unusable id refuses the whole call, including its usable siblings", async () => {
    expect((await refusalOf(run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration, foreignIntegration] },
    }, admin_()))).code).toBe("NOT_FOUND");
    expect(await storedAcl(record)).toEqual(BASE_ACL);
  }, TEST_TIMEOUT);

  test("a grant survives the integration being disabled, and stays revocable", async () => {
    await run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, admin_());
    await admin.db.connection().execute((conn) =>
      sql`update platform.api_key_integrations set status = 'disabled'
        where id = ${activeIntegration}::uuid`.execute(conn));
    try {
      // Revocation never asks whether the integration is still usable: a
      // grant left behind by a disabled or deleted one must stay removable.
      const result = await run({
        entity: ENTITY, recordId: record, action: "start",
        revoke: { integrations: [activeIntegration] },
      }, admin_());
      expect(result).toMatchObject({ changed: true, subjects: { integrations: [] } });
      // And the entry leaves no husk behind.
      expect(await storedAcl(record)).toEqual(BASE_ACL);
    } finally {
      await admin.db.connection().execute((conn) =>
        sql`update platform.api_key_integrations set status = 'active'
          where id = ${activeIntegration}::uuid`.execute(conn));
    }
  }, TEST_TIMEOUT);

  test("a malformed application id is refused before anything is read", async () => {
    for (const named of ["osf_live_abc", "not-a-uuid", ""]) {
      const refusal = await refusalOf(run({
        entity: ENTITY, recordId: record, action: "start",
        grant: { integrations: [named] },
      }, admin_()));
      expect(["VALIDATION", "BAD_USER_INPUT"]).toContain(refusal.code);
    }
  }, TEST_TIMEOUT);
});

describe("the delta is safe under concurrency and repetition", () => {
  const admin_ = () => person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]);

  test("the same delta twice changes nothing the second time", async () => {
    await run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, admin_());
    const before = await admin.db.connection().execute(async (conn) =>
      (await sql<{ updated_at: string }>`select updated_at::text as updated_at
        from ${sql.id(SCHEMA, TABLE)} where id = ${record}::uuid`.execute(conn)).rows[0]!.updated_at);
    const again = await run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, admin_());
    expect(again).toMatchObject({ changed: false });
    const after = await admin.db.connection().execute(async (conn) =>
      (await sql<{ updated_at: string }>`select updated_at::text as updated_at
        from ${sql.id(SCHEMA, TABLE)} where id = ${record}::uuid`.execute(conn)).rows[0]!.updated_at);
    // Nothing written means no version bump, so a concurrent editor's
    // expectedVersion is not invalidated by a no-op delegation.
    expect(after).toBe(before);
  }, TEST_TIMEOUT);

  test("two concurrent delegations both land", async () => {
    // A replace would lose one of them; the delta applies to the document
    // read under this transaction's own ACL-row lock, so they serialize.
    const first = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const second = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      await Promise.all([
        run({
          entity: ENTITY, recordId: record, action: "start",
          grant: { integrations: [activeIntegration] },
        }, admin_(), first),
        run({
          entity: ENTITY, recordId: record, action: "start",
          grant: { integrations: [secondIntegration] },
        }, admin_(), second),
      ]);
      const axis = (await storedAcl(record)).actions as
        Record<string, { integrations: string[] }> | undefined;
      expect([...(axis?.start?.integrations ?? [])].sort())
        .toEqual([activeIntegration, secondIntegration].sort());
    } finally {
      await first.close();
      await second.close();
    }
  }, TEST_TIMEOUT);

  test("revoking a subject nobody holds is not an error", async () => {
    const result = await run({
      entity: ENTITY, recordId: record, action: "review",
      revoke: { users: [outsider] },
    }, admin_());
    expect(result).toMatchObject({ changed: false, subjects: { users: [] } });
  }, TEST_TIMEOUT);

  test("granting and revoking the same subject in one call revokes it", async () => {
    const result = await run({
      entity: ENTITY, recordId: record, action: "review",
      grant: { users: [outsider] }, revoke: { users: [outsider] },
    }, admin_());
    expect(result).toMatchObject({ changed: false, subjects: { users: [] } });
  }, TEST_TIMEOUT);

  test("a call that grants and revokes nothing is refused", async () => {
    expect((await refusalOf(run({
      entity: ENTITY, recordId: record, action: "review",
    }, admin_()))).code).toBe("BAD_USER_INPUT");
  }, TEST_TIMEOUT);

  test("the change is journalled with everything else that happens to the record", async () => {
    await run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, admin_());
    const events = await admin.db.connection().execute(async (conn) =>
      (await sql<{ event_type: string }>`
        select event_type from platform.entity_events
         where tenant_id = ${tenantA}::uuid and aggregate_id = ${record}
         order by sequence
      `.execute(conn)).rows.map((row) => row.event_type));
    expect(events.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);
});

describe("an ordinary update cannot reach the axis", () => {
  const granted = { actions: { start: { integrations: [activeIntegration] } } };

  async function grantStart(): Promise<void> {
    await run({
      entity: ENTITY, recordId: record, action: "start",
      grant: { integrations: [activeIntegration] },
    }, person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]));
  }

  const update = (values: Record<string, unknown>, session = person(editor, [EDITOR_ROLE])) =>
    updateGeneratedEntityForTable(app.db, session, table, record, values);

  test("an editor cannot grant an integration by rewriting the ACL field", async () => {
    // The reported escalation, through the path that actually stores the
    // column rather than through the delegation Operation.
    const refusal = await refusalOf(update({ authorization: { ...BASE_ACL, ...granted } }));
    expect(refusal.code).toBe("FORBIDDEN");
    expect(refusal.detail).toContain("entity.record-action.delegate");
    expect(await storedAcl(record)).toEqual(BASE_ACL);
    expect(await holdsAction(app.db, apiKeySession(activeIntegration), record, "start")).toBe(false);
  }, TEST_TIMEOUT);

  test("not even the manager, who may delegate, may do it through an update", async () => {
    // One writer of the axis, not "the delegation Operation or an update by
    // someone who could have used it".
    expect((await refusalOf(update(
      { authorization: { ...BASE_ACL, ...granted } },
      person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]),
    ))).code).toBe("FORBIDDEN");
  }, TEST_TIMEOUT);

  test("a human permission update still works and preserves the grants", async () => {
    await grantStart();
    const row = await update({
      title: "renamed",
      authorization: { view: { users: [editor, manager, outsider] }, edit: { users: [editor] } },
    });
    expect(row).not.toBeNull();
    expect(await storedAcl(record)).toEqual({
      view: { users: [editor, manager, outsider] },
      edit: { users: [editor] },
      actions: { start: { integrations: [activeIntegration] } },
    });
    // The grant still means what it meant.
    expect(await holdsAction(app.db, apiKeySession(activeIntegration), record, "start")).toBe(true);
  }, TEST_TIMEOUT);

  test("a body that never mentions the axis does not remove a grant", async () => {
    // The old-client case: a client that predates the axis round-trips the
    // document it understands. Omission must not be a revocation.
    await grantStart();
    await update({ title: "still here" });
    expect((await storedAcl(record)).actions).toEqual({
      start: { integrations: [activeIntegration] },
    });
  }, TEST_TIMEOUT);

  test("a stale document whose axis has moved on is refused, not applied", async () => {
    const stale = { ...BASE_ACL, actions: {} };
    await grantStart();
    // The editor loaded the record before the delegation and is now saving
    // the permissions with the axis as it was. Refused rather than silently
    // revoking, and the refusal says to reload.
    const refusal = await refusalOf(update({ authorization: stale }));
    expect(refusal.code).toBe("FORBIDDEN");
    expect(refusal.detail).toContain("reload");
    expect((await storedAcl(record)).actions).toEqual({
      start: { integrations: [activeIntegration] },
    });
  }, TEST_TIMEOUT);

  test("handing the axis back unchanged is accepted and is not a change", async () => {
    await grantStart();
    const unchanged = {
      view: { users: [editor, manager] }, edit: { users: [editor, manager] },
      actions: { start: { integrations: [activeIntegration] } },
    };
    await update({ authorization: unchanged });
    expect((await storedAcl(record)).actions).toEqual({
      start: { integrations: [activeIntegration] },
    });
  }, TEST_TIMEOUT);

  test("an object merge into the ACL field cannot reach the axis either", async () => {
    // The merge path assembles the stored object and the patch inside the
    // update transaction, so it is a second way to the column.
    const author = person(editor, [EDITOR_ROLE]);
    const refusal = await refusalOf(mergeGeneratedEntityObjectForTable(
      app.db, author, table, record, "authorization", granted,
    ));
    expect(refusal.code).toBe("FORBIDDEN");
    expect(await storedAcl(record)).toEqual(BASE_ACL);
    // A merge that only touches the permissions still works, and the grant
    // already in force survives it.
    await grantStart();
    await mergeGeneratedEntityObjectForTable(
      app.db, author, table, record, "authorization",
      { view: { users: [editor, manager, outsider] } },
    );
    expect(await storedAcl(record)).toEqual({
      view: { users: [editor, manager, outsider] },
      edit: { users: [editor, manager] },
      actions: { start: { integrations: [activeIntegration] } },
    });
  }, TEST_TIMEOUT);

  test("a create cannot seed an action this entity does not default to", async () => {
    // Creating the record instead of editing it is the other way to the axis.
    const author = person(editor, [EDITOR_ROLE]);
    const refusal = await refusalOf(createGeneratedEntityForTable(app.db, author, table, {
      tenantId: tenantA, authorization: { ...BASE_ACL, ...granted },
    }));
    expect(refusal.code).toBe("FORBIDDEN");
    expect(refusal.detail).toContain("entity.record-action.delegate");
    // The same create without the axis does make a record, so the refusal is
    // the axis and not the create path refusing everything.
    const created = await createGeneratedEntityForTable(app.db, author, table, {
      tenantId: tenantA, authorization: BASE_ACL,
    });
    expect(await storedAcl(String(created.id))).toEqual(BASE_ACL);
  }, TEST_TIMEOUT);
});

/**
 * ONE global lock order for the whole axis, and the three transactions that
 * can contend for it:
 *
 *   integration -> credential -> record ACL
 *
 * A running action takes the first two in `app.record_action_principal_live`
 * and the third in `app.record_action_allows` (db/migrations/record-actions.ts).
 * `disableIntegration` (auth/api-key/service.ts) writes the integration row and
 * then the keys under it, and touches no business row. This writer takes the
 * integration share BEFORE the ACL row, which is what puts it in the same order
 * as the other two.
 *
 * WHY IT HAS TO BE THAT WAY ROUND. Two `for share` holders never block each
 * other, so there is no two-transaction deadlock to find here — the cycle needs
 * the disable's exclusive request sitting in the queue between them:
 *
 *   T1 running action   holds the integration share, waits for the ACL row;
 *   T3 disable          waits for T1's integration share;
 *   T2 this writer      holds the ACL row, and its own share request queues
 *                       BEHIND T3 rather than joining T1 as a co-holder.
 *
 * T1 -> T2 -> T3 -> T1: one of the three is aborted or waits past its
 * statement timeout. It is an availability failure and not an access bypass —
 * nothing is granted that was not authorized — but it only appears under load.
 *
 * What the two tests below actually establish, stated so neither is read as
 * more than it is:
 *
 *   the first  pins the ORDER itself. It holds the integration row
 *              exclusively and shows the writer waiting for it with the
 *              record's ACL row still lockable by somebody else. Inverting
 *              the two statements in `applyRecordActionDelegation` fails this
 *              test on that last assertion;
 *   the second drives all three transactions overlapping, synchronized on
 *              `pg_blocking_pids`, and shows every one of them committing.
 *              That is LIVENESS evidence for this interleaving under the
 *              order above; it is not a demonstration that the inverted order
 *              cycles, because nothing outside `run` can hold its transaction
 *              open between the two locks to force the one interleaving that
 *              does. The first test is what guards the order.
 *
 * Both synchronize on `pg_blocking_pids` rather than on a sleep, so neither
 * can pass by a wait having been too short to observe.
 */
describe("the global lock order holds across a running action, a delegation and a disable", () => {
  async function labelled<T>(
    runtime: DatabaseRuntime,
    input: DbSessionInput,
    label: string,
    work: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return withDbSession(runtime.db, input, async (trx) => {
      await sql`select set_config('application_name', ${label}, false)`.execute(trx);
      return work(trx);
    });
  }

  /**
   * Waits until some backend is genuinely blocked BY `holder`, and fails if
   * none ever is.
   *
   * Keyed on the holder's own pid rather than on an application name, because
   * the transaction under test runs inside the runtime's own pool and nothing
   * outside it can label that connection. `pg_blocking_pids` is the exact
   * question — who is waiting for whom — so nothing here rests on a sleep
   * having been long enough.
   */
  async function awaitBlockedBy(holder: number, why: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const blocked = await admin.db.connection().execute(async (conn) =>
        (await sql<{ count: number }>`
          select count(*)::int as count
            from pg_stat_activity
           where pid <> ${holder}
             and ${holder} = any(pg_blocking_pids(pid))
        `.execute(conn)).rows[0]!.count);
      if (blocked > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(why);
  }

  /** Is this row's ACL lockable right now, from a connection of its own? */
  async function aclRowIsFree(recordId: string): Promise<boolean> {
    try {
      return await admin.db.connection().execute(async (conn) =>
        (await sql<{ id: string | null }>`
          select id::text as id from ${sql.id(SCHEMA, TABLE)}
           where id = ${recordId}::uuid for update nowait
        `.execute(conn)).rows.length > 0);
    } catch {
      return false;
    }
  }

  test("the writer blocks on the integration row before it has touched the ACL row", async () => {
    // The order is observable: hold the integration row exclusively, start a
    // grant, and the grant is stuck on the integration while the record's ACL
    // row is still lockable by somebody else. Under the inverted order the
    // writer would already be holding the ACL row and the last assertion
    // below would fail.
    const writer = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const held = Promise.withResolvers<number>();
      const releaseIntegration = Promise.withResolvers<void>();
      const holding = admin.db.connection().execute(async (conn) => {
        await sql`begin`.execute(conn);
        await sql`select id from platform.api_key_integrations
           where id = ${activeIntegration}::uuid for update`.execute(conn);
        held.resolve((await sql<{ pid: number }>`
          select pg_backend_pid() as pid
        `.execute(conn)).rows[0]!.pid);
        await releaseIntegration.promise;
        await sql`commit`.execute(conn);
      });
      const holderPid = await held.promise;
      let grant: Promise<Delegated> | undefined;
      try {
        grant = run({
          entity: ENTITY, recordId: record, action: "start",
          grant: { integrations: [activeIntegration] },
        }, person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]), writer);
        await awaitBlockedBy(
          holderPid, "the delegation never waited for the integration row",
        );
        // Still free: the writer has not reached the ACL row yet.
        expect(await aclRowIsFree(record)).toBe(true);
      } finally {
        // Whatever happened above, the integration row goes back: a failed
        // assertion must not leave it locked for the rest of this file.
        releaseIntegration.resolve();
        await holding;
      }
      expect((await grant).subjects.integrations).toEqual([activeIntegration]);
    } finally {
      await writer.close();
    }
  }, TEST_TIMEOUT);

  test("the three overlapping transactions all complete, in the interleaving that would cycle", async () => {
    const actor = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const writer = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      // The record already names the application, so the running action is a
      // real holder taking real locks rather than a denial that takes none.
      await run({
        entity: ENTITY, recordId: record, action: "start",
        grant: { integrations: [activeIntegration] },
      }, person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]));

      const checked = Promise.withResolvers<number>();
      const effectDone = Promise.withResolvers<void>();
      // T1: the action in flight. The fence takes the integration and the
      // credential `for share`, the lookup takes the ACL row, and both are
      // held for as long as the Operation's transaction runs.
      const running = labelled(actor, liveApplication(), "ra-action-inflight", async (trx) => {
        const live = (await sql<{ live: boolean }>`
          select app.record_action_principal_live() as live
        `.execute(trx)).rows[0]?.live === true;
        const allowed = (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${ENTITY}, ${record}, 'start') as allowed
        `.execute(trx)).rows[0]?.allowed === true;
        checked.resolve((await sql<{ pid: number }>`
          select pg_backend_pid() as pid
        `.execute(trx)).rows[0]!.pid);
        await effectDone.promise;
        return { live, allowed };
      });
      const actionPid = await checked.promise;

      // T3: the administrator disabling the integration under it. Blocked on
      // T1's integration share, and so sitting in the lock queue ahead of
      // anybody who asks for that share next.
      const disabling = admin.db.connection().execute(async (conn) => {
        await sql`update platform.api_key_integrations set status = 'disabled'
           where id = ${activeIntegration}::uuid`.execute(conn);
        return "disabled" as const;
      });
      await awaitBlockedBy(actionPid, "the disable never waited for the integration share");

      // T2: a second delegation on the same record. Under the inverted order
      // it would hold the ACL row and then queue behind T3 for the integration
      // share, closing the cycle T1 -> T2 -> T3 -> T1. It now asks for the
      // share first, so the only thing it can wait for is T1 — ordinary
      // serialization, not a cycle. Revoking, so it needs no active
      // integration and cannot be answered by T3 winning the race.
      const second = run({
        entity: ENTITY, recordId: record, action: "follow",
        revoke: { integrations: [activeIntegration] },
      }, person(manager, [EDITOR_ROLE, API_KEY_MANAGE_ROLE]), writer);

      effectDone.resolve();

      expect(await running).toEqual({ live: true, allowed: true });
      // No deadlock: all three transactions committed.
      expect((await second).changed).toBe(false);
      expect(await disabling).toBe("disabled");
      // And the axis is exactly what it was: T2 revoked a grant nobody held.
      expect(await storedAcl(record)).toEqual({
        ...BASE_ACL,
        actions: { start: { integrations: [activeIntegration] } },
      });
    } finally {
      await actor.close();
      await writer.close();
      // T3 really disabled the shared integration, so put it back: this file's
      // fixtures are shared and a test must not depend on running last.
      await admin.db.connection().execute((conn) =>
        sql`update platform.api_key_integrations set status = 'active'
           where id = ${activeIntegration}::uuid`.execute(conn));
    }
  }, TEST_TIMEOUT);
});
