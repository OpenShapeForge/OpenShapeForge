// SPDX-License-Identifier: BUSL-1.1
/**
 * The named-action axis of the record ACL, against a migrated scratch database
 * and through the RESTRICTED app role — the role the API actually connects as,
 * NOSUPERUSER and NOBYPASSRLS.
 *
 * What these tests are for, in order of how badly each would hurt:
 *
 *   1. the lookup answers one boolean about one record and discloses nothing
 *      else — not the row, not the ACL column, not another tenant's record,
 *      and not an entity or action the compiler did not authorize;
 *   2. its definer role cannot be reached, assumed, or used to write;
 *   3. a subject kind is matched against the session's VERIFIED principal
 *      class, so the same role held by a person, an API-key application and a
 *      bearer service account does not resolve to the same rights;
 *   4. the single lock ordering holds under both concurrent interleavings of
 *      a policy change and a check, proven with pg_blocking_pids rather than
 *      with sleeps;
 *   5. none of it changes what an existing human session sees.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { APP_ROLE } from "../migrations/app-role.js";
import {
  applyRecordActionsMigration,
  recordActionEntities,
  type RecordActionEntity,
} from "../migrations/record-actions.js";
import { databaseRole } from "../database-roles.js";
import { withDbSession, type DbSessionInput } from "../session.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const APP_ROLE_PASSWORD = process.env.SCRATCH_APP_ROLE_PASSWORD ?? "openshapeforge_app";
const RESOLVER_ROLE = databaseRole("recordActionResolver").name;
const TEST_TIMEOUT = 180_000;
const scratch = `record_actions_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

const tenantA = randomUUID();
const tenantB = randomUUID();
const person = randomUUID();
const otherPerson = randomUUID();
const relationGroup = randomUUID();
const integration = randomUUID();
const otherIntegration = randomUUID();
const SHARED_ROLE = "Runs.All.Operate";

/** Three entities, so nothing can pass by being the only branch in the case. */
const RUN = "ActionRun";
const DOC = "ActionDoc";
/**
 * The lock-mode entity. Its ACL is `empty: public` for the three human
 * permissions and it names no view subject, so the row IS readable by the
 * acting session — the shape an entity takes when it holds its own
 * application grants beside ordinary human access. That is what makes an
 * effect's `for update` on the same row possible, and therefore what makes
 * the lock-upgrade question real rather than hypothetical.
 */
const JOB = "ActionJob";
const runRow = randomUUID();
const runRowTenantB = randomUUID();
const docRow = randomUUID();
/** One record per concurrent interleaving, so neither disturbs the other. */
const lockRowCheckFirst = randomUUID();
const lockRowRevokeFirst = randomUUID();
/** One record per parallel-holder pairing, for the same reason. */
const jobRowShared = randomUUID();
const jobRowExclusive = randomUUID();
const jobRowSharedFence = randomUUID();

const entities: RecordActionEntity[] = [
  {
    entity: RUN, schema: "erp", table: "action_runs",
    keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
    actions: ["follow", "start"],
    // `start` needs the definition to run; `follow` declares nothing, so it
    // authorizes an effect and discloses nothing. `secret` is declared by
    // neither and is what the tests watch for.
    reads: {
      start: [
        { field: "definition", column: "definition" },
        { field: "status", column: "status" },
      ],
    },
    // `start` writes the record it is authorized on, so it takes the
    // self-exclusive lock; `follow` only reads, and declares the shared one.
    // Both are exercised below, including the deadlock `shared` admits.
    locks: { follow: "shared", start: "exclusive" },
  },
  {
    entity: DOC, schema: "erp", table: "action_docs",
    keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
    actions: ["publish"], reads: {}, locks: { publish: "exclusive" },
  },
  {
    entity: JOB, schema: "erp", table: "action_jobs",
    keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
    // The same question twice, once per lock mode, so the pairing below
    // differs in nothing but the mode the action declared.
    actions: ["claimExclusive", "claimShared"], reads: {},
    locks: { claimExclusive: "exclusive", claimShared: "shared" },
  },
];

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
function session(overrides: Partial<DbSessionInput> = {}): DbSessionInput {
  return {
    tenantId: tenantA, userId: person, roles: [], groups: [],
    relationGroupIds: [], scope: "self", ...overrides,
  };
}

/** The verified identity↔Relation link that classifies a trusted-context person. */
function linkedPerson(userId: string) {
  return {
    relation: {
      identityId: randomUUID(), issuer: "https://identity.example/realms/test",
      subject: userId, status: "linked",
    },
  } as Partial<DbSessionInput>;
}

let server: SQL;
let admin: DatabaseRuntime;
let app: DatabaseRuntime;

async function allows(
  db: Kysely<DB>,
  input: DbSessionInput,
  entity: string,
  recordKey: string,
  action: string,
): Promise<boolean> {
  return withDbSession(db, input, async (trx) => {
    const result = await sql<{ allowed: boolean | null }>`
      select app.record_action_allows(${entity}, ${recordKey}, ${action}) as allowed
    `.execute(trx);
    return result.rows[0]?.allowed === true;
  });
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch)) throw new Error("unsafe scratch database name");
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create database "${scratch}"`);
  admin = createDatabaseRuntime({ databaseUrl: url(scratch), maxConnections: 4 });
  await admin.db.connection().execute((conn) => runMigrationChain(conn));

  await admin.db.connection().execute(async (conn) => {
    for (const entity of entities) {
      const table = sql.id(entity.schema, entity.table);
      // The shape the compiler emits for an ACL-bearing entity, including the
      // unchanged view-gated row policy. `action_docs` keeps empty=public, the
      // default a human ACL ships with, so the tests can show it still works.
      const emptyIsPublic = entity.entity === DOC || entity.entity === JOB;
      await sql`
        create table ${table} (
          id uuid primary key,
          tenant_id uuid not null,
          secret text not null,
          definition text not null default 'graph',
          status text not null default 'ready',
          acl jsonb not null default '{}'::jsonb
        )
      `.execute(conn);
      await sql`alter table ${table} enable row level security`.execute(conn);
      await sql`alter table ${table} force row level security`.execute(conn);
      await sql`
        create policy ${sql.id(`${entity.table}_row_scope`)} on ${table}
        using (
          app.bypass_rls() or (
            tenant_id = app.current_tenant()
            and app.record_permission_allows("acl", 'view', ${sql.lit(emptyIsPublic)})
          )
        )
        with check (app.bypass_rls() or tenant_id = app.current_tenant())
      `.execute(conn);
      await sql.raw(
        `grant select, insert, update, delete on ${entity.schema}.${entity.table} to ${APP_ROLE}`,
      ).execute(conn);
    }

    const grantToIntegration = (id: string) =>
      JSON.stringify({
        view: { users: [otherPerson] },
        edit: { users: [otherPerson] },
        actions: { start: { integrations: [id] }, follow: { integrations: [id] } },
      });
    await sql`
      insert into erp.action_runs (id, tenant_id, secret, definition, status, acl) values
        (${runRow}::uuid, ${tenantA}::uuid, 'run-a-secret', 'graph-a', 'ready', ${sql.raw(`'${grantToIntegration(integration)}'::jsonb`)}),
        (${runRowTenantB}::uuid, ${tenantB}::uuid, 'run-b-secret', 'graph-b', 'ready', ${sql.raw(`'${grantToIntegration(integration)}'::jsonb`)}),
        (${lockRowCheckFirst}::uuid, ${tenantA}::uuid, 'lock-1', 'graph-1', 'ready', ${sql.raw(`'${grantToIntegration(integration)}'::jsonb`)}),
        (${lockRowRevokeFirst}::uuid, ${tenantA}::uuid, 'lock-2', 'graph-2', 'ready', ${sql.raw(`'${grantToIntegration(integration)}'::jsonb`)})
    `.execute(conn);
    // A person-only action grant that names a ROLE, beside an integration
    // grant for a different integration. Nothing here grants view.
    await sql`
      insert into erp.action_docs (id, tenant_id, secret, acl) values
        (${docRow}::uuid, ${tenantA}::uuid, 'doc-secret', ${sql.raw(`'${JSON.stringify({
          actions: {
            publish: {
              roles: [SHARED_ROLE], users: [person], groups: [relationGroup],
              integrations: [otherIntegration],
            },
          },
        })}'::jsonb`)})
    `.execute(conn);
    // The lock-mode rows: both claims granted to the integration, and no view
    // subject at all, which under `empty: public` leaves the row readable.
    await sql`
      insert into erp.action_jobs (id, tenant_id, secret, acl) values
        (${jobRowShared}::uuid, ${tenantA}::uuid, 'job-shared', ${sql.raw(`'${JSON.stringify({
          actions: {
            claimShared: { integrations: [integration] },
            claimExclusive: { integrations: [integration] },
          },
        })}'::jsonb`)}),
        (${jobRowExclusive}::uuid, ${tenantA}::uuid, 'job-exclusive', ${sql.raw(`'${JSON.stringify({
          actions: {
            claimShared: { integrations: [integration] },
            claimExclusive: { integrations: [integration] },
          },
        })}'::jsonb`)}),
        (${jobRowSharedFence}::uuid, ${tenantA}::uuid, 'job-fence', ${sql.raw(`'${JSON.stringify({
          view: { users: [otherPerson] },
          edit: { users: [otherPerson] },
          actions: { claimShared: { integrations: [integration] } },
        })}'::jsonb`)})
    `.execute(conn);
    await applyRecordActionsMigration(conn, entities);
  });
  app = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 4 });
}, TEST_TIMEOUT);

afterAll(async () => {
  await app?.close();
  await admin?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.close();
});

describe("record action lookup under the restricted app role", () => {
  test("answers for a verified application without making the record readable", async () => {
    const machine = session({
      userId: randomUUID(), principalKind: "service",
      appPrincipal: { integrationId: integration }, roles: [SHARED_ROLE],
    });
    expect(await allows(app.db, machine, RUN, runRow, "start")).toBe(true);
    expect(await allows(app.db, machine, RUN, runRow, "follow")).toBe(true);
    // The whole point: authorized to act, still blind to the record.
    const visible = await withDbSession(app.db, machine, async (trx) =>
      (await sql<{ count: number }>`select count(*)::int as count from erp.action_runs`
        .execute(trx)).rows[0]!.count);
    expect(visible).toBe(0);
  }, TEST_TIMEOUT);

  test("denies across tenants, outside the registry and outside the declared actions", async () => {
    const machine = session({
      userId: randomUUID(), principalKind: "service",
      appPrincipal: { integrationId: integration },
    });
    // The row exists and names this integration — in the OTHER tenant.
    expect(await allows(app.db, machine, RUN, runRowTenantB, "start")).toBe(false);
    expect(await allows(app.db, { ...machine, tenantId: tenantB }, RUN, runRow, "start")).toBe(false);
    // An entity the compiler never put in the case.
    expect(await allows(app.db, machine, "Tenant", runRow, "start")).toBe(false);
    expect(await allows(app.db, machine, "erp.action_runs", runRow, "start")).toBe(false);
    // An action this entity does not declare, and the permissions it may
    // never restate.
    expect(await allows(app.db, machine, RUN, runRow, "publish")).toBe(false);
    for (const permission of ["view", "edit", "delete"]) {
      expect(await allows(app.db, machine, RUN, runRow, permission)).toBe(false);
    }
    // A record of a registry entity that does not exist.
    expect(await allows(app.db, machine, RUN, randomUUID(), "start")).toBe(false);
    // Malformed keys and names fail closed rather than erroring.
    for (const key of ["", "not-a-uuid", "' or true--"]) {
      expect(await allows(app.db, machine, RUN, key, "start")).toBe(false);
    }
    for (const action of ["", "Start", "start; drop table erp.action_runs", "*"]) {
      expect(await allows(app.db, machine, RUN, runRow, action)).toBe(false);
    }
  }, TEST_TIMEOUT);

  test("an application holds only the grants that name it", async () => {
    const machine = session({
      userId: randomUUID(), principalKind: "service",
      appPrincipal: { integrationId: otherIntegration },
    });
    // Named for publish on the doc, named nowhere on the run.
    expect(await allows(app.db, machine, DOC, docRow, "publish")).toBe(true);
    expect(await allows(app.db, machine, RUN, runRow, "start")).toBe(false);
    expect(await allows(app.db, machine, RUN, runRow, "follow")).toBe(false);
  }, TEST_TIMEOUT);
});

describe("verified principal class decides which subjects apply", () => {
  // One ACL entry, one role, three carriers. Only the person may use it.
  test("the same role resolves differently for a person, an application and a service", async () => {
    const roles = [SHARED_ROLE];
    const asPerson = session({ userId: person, roles, principalKind: "person" });
    const asTrustedContextPerson = session({
      userId: person, roles, ...linkedPerson(person),
    });
    const asServiceBearer = session({
      userId: randomUUID(), roles, principalKind: "service",
    });
    const asApplication = session({
      userId: randomUUID(), roles, principalKind: "service",
      appPrincipal: { integrationId: integration },
    });
    const unclassified = session({ userId: randomUUID(), roles });

    expect(await allows(app.db, asPerson, DOC, docRow, "publish")).toBe(true);
    expect(await allows(app.db, asTrustedContextPerson, DOC, docRow, "publish")).toBe(true);
    // A verified client-credentials principal holding the SAME role gets
    // nothing from a person subject. This is the escalation being closed.
    expect(await allows(app.db, asServiceBearer, DOC, docRow, "publish")).toBe(false);
    // An application is matched only against `integrations`, never a role it
    // happens to carry — even though this ACL does name another integration.
    expect(await allows(app.db, asApplication, DOC, docRow, "publish")).toBe(false);
    // Nothing states a kind and no link exists: no class, no action.
    expect(await allows(app.db, unclassified, DOC, docRow, "publish")).toBe(false);
  }, TEST_TIMEOUT);

  test("a person matches by user id and by server-derived RelationGroup, never by Keycloak group", async () => {
    const byUser = session({ userId: person, principalKind: "person" });
    const byGroup = session({
      userId: otherPerson, principalKind: "person", relationGroupIds: [relationGroup],
    });
    const byKeycloakGroup = session({
      userId: otherPerson, principalKind: "person", groups: [relationGroup],
    });
    expect(await allows(app.db, byUser, DOC, docRow, "publish")).toBe(true);
    expect(await allows(app.db, byGroup, DOC, docRow, "publish")).toBe(true);
    expect(await allows(app.db, byKeycloakGroup, DOC, docRow, "publish")).toBe(false);
  }, TEST_TIMEOUT);

  test("an absent application principal denies and does not carry into the next session", async () => {
    const withoutPrincipal = session({ userId: randomUUID(), principalKind: "service" });
    expect(await allows(app.db, withoutPrincipal, RUN, runRow, "start")).toBe(false);

    // These settings are transaction-local, and a pooled connection serves one
    // request after another. Forge both, let the transaction end, and the next
    // session must start from what the server decided — applyDbSession writes
    // them unconditionally, empty included, so there is nothing to inherit.
    //
    // Within ONE transaction they are forgeable by anything running as the app
    // role, exactly as `app.roles` and `app.user_id` already are: they are the
    // authorization input this server writes, not a boundary against its own
    // SQL. What makes them trustworthy is that no request reaches set_config.
    await withDbSession(app.db, withoutPrincipal, async (trx) => {
      await sql`select set_config('app.app_principal_id', ${integration}, true),
        set_config('app.principal_class', 'application', true)`.execute(trx);
      expect(await allows(app.db, withoutPrincipal, RUN, runRow, "start")).toBe(true);
    });
    const next = await withDbSession(app.db, withoutPrincipal, async (trx) =>
      (await sql<{ class: string; principal: string | null }>`
        select app.current_principal_class() as class,
               app.current_app_principal()::text as principal
      `.execute(trx)).rows[0]!);
    expect(next).toEqual({ class: "service", principal: null });
    expect(await allows(app.db, withoutPrincipal, RUN, runRow, "start")).toBe(false);
  }, TEST_TIMEOUT);
});

describe("the bounded execution capability", () => {
  const machine = (id = integration) => session({
    userId: randomUUID(), principalKind: "service",
    appPrincipal: { integrationId: id },
  });
  async function read(
    input: DbSessionInput, entity: string, recordKey: string, action: string,
  ): Promise<Record<string, unknown> | null> {
    return withDbSession(app.db, input, async (trx) =>
      (await sql<{ payload: Record<string, unknown> | null }>`
        select app.record_action_read(${entity}, ${recordKey}, ${action}) as payload
      `.execute(trx)).rows[0]?.payload ?? null);
  }

  test("a start-only application reads exactly the declared fields", async () => {
    expect(await read(machine(), RUN, runRow, "start")).toEqual({
      definition: "graph-a", status: "ready",
    });
  }, TEST_TIMEOUT);

  test("it carries neither the ACL, nor the tenant, nor an undeclared column", async () => {
    const payload = (await read(machine(), RUN, runRow, "start"))!;
    expect(Object.keys(payload).sort()).toEqual(["definition", "status"]);
    for (const leaked of ["acl", "secret", "tenant_id", "id"]) {
      expect(payload).not.toHaveProperty(leaked);
    }
    expect(JSON.stringify(payload)).not.toContain("run-a-secret");
    expect(JSON.stringify(payload)).not.toContain(integration);
  }, TEST_TIMEOUT);

  test("an action that declares no projection discloses nothing", async () => {
    // `follow` is granted to this application and still reads nothing.
    expect(await allows(app.db, machine(), RUN, runRow, "follow")).toBe(true);
    expect(await read(machine(), RUN, runRow, "follow")).toBeNull();
    expect(await read(machine(otherIntegration), DOC, docRow, "publish")).toBeNull();
  }, TEST_TIMEOUT);

  test("it refuses for every reason the check refuses, as one answer", async () => {
    // Not granted this action.
    expect(await read(machine(otherIntegration), RUN, runRow, "start")).toBeNull();
    // Another tenant's record, and this session in another tenant.
    expect(await read(machine(), RUN, runRowTenantB, "start")).toBeNull();
    expect(await read({ ...machine(), tenantId: tenantB }, RUN, runRow, "start")).toBeNull();
    // Outside the registry, outside the declared actions, and absent rows.
    expect(await read(machine(), "Tenant", runRow, "start")).toBeNull();
    expect(await read(machine(), RUN, runRow, "view")).toBeNull();
    expect(await read(machine(), RUN, randomUUID(), "start")).toBeNull();
    expect(await read(machine(), RUN, "not-a-uuid", "start")).toBeNull();
    // A person who holds no action on this record gets nothing either; the
    // projection is the action's, not the carrier's.
    expect(await read(session({ userId: otherPerson, principalKind: "person" }), RUN, runRow, "start"))
      .toBeNull();
  }, TEST_TIMEOUT);

  test("reading still does not make the record readable", async () => {
    const input = machine();
    expect(await read(input, RUN, runRow, "start")).not.toBeNull();
    const visible = await withDbSession(app.db, input, async (trx) =>
      (await sql<{ count: number }>`select count(*)::int as count from erp.action_runs`
        .execute(trx)).rows[0]!.count);
    expect(visible).toBe(0);
  }, TEST_TIMEOUT);
});

describe("the definer role is bounded", () => {
  test("the app role can neither assume it nor read what it reads", async () => {
    await admin.db.connection().execute(async (conn) => {
      const member = await sql<{ member: boolean }>`
        select pg_has_role(${APP_ROLE}, ${RESOLVER_ROLE}, 'USAGE') as member
      `.execute(conn);
      expect(member.rows[0]!.member).toBe(false);
      const login = await sql<{ can_login: boolean }>`
        select rolcanlogin as can_login from pg_roles where rolname = ${RESOLVER_ROLE}
      `.execute(conn);
      expect(login.rows[0]!.can_login).toBe(false);
      const bypass = await sql<{ bypass: boolean }>`
        select rolbypassrls as bypass from pg_roles where rolname = ${RESOLVER_ROLE}
      `.execute(conn);
      expect(bypass.rows[0]!.bypass).toBe(false);
      // Exactly the three columns the one question needs, and no more.
      const columns = await sql<{ column_name: string; privilege_type: string }>`
        select column_name, privilege_type
          from information_schema.column_privileges
         where grantee = ${RESOLVER_ROLE} and table_name = 'action_runs'
         order by privilege_type, column_name
      `.execute(conn);
      expect(columns.rows).toEqual([
        { column_name: "acl", privilege_type: "SELECT" },
        { column_name: "definition", privilege_type: "SELECT" },
        { column_name: "id", privilege_type: "SELECT" },
        { column_name: "status", privilege_type: "SELECT" },
        { column_name: "tenant_id", privilege_type: "SELECT" },
        { column_name: "acl", privilege_type: "UPDATE" },
      ]);
      // `secret` is declared by no action, so the resolver cannot read it at
      // all — the projection is bounded by a privilege, not only by SQL.
      expect(columns.rows.map((row) => row.column_name)).not.toContain("secret");
      // The lock privilege exists so FOR SHARE is legal; the policy is what
      // makes a write impossible.
      const policies = await sql<{ policyname: string; cmd: string; withcheck: string | null }>`
        select policyname, cmd, with_check as withcheck
          from pg_policies
         where schemaname = 'erp' and tablename = 'action_runs'
           and ${RESOLVER_ROLE} = any(roles)
         order by policyname
      `.execute(conn);
      expect(policies.rows.map((row) => [row.policyname, row.cmd, row.withcheck])).toEqual([
        ["action_runs_record_action_lock", "UPDATE", "false"],
        ["action_runs_record_action_read", "SELECT", null],
      ]);
    });
    await expect(
      app.db.connection().execute((conn) => sql.raw(`set role ${RESOLVER_ROLE}`).execute(conn)),
    ).rejects.toThrow(/permission denied to set role/i);
  }, TEST_TIMEOUT);

  test("EXECUTE is not public and the worker is not granted it", async () => {
    await admin.db.connection().execute(async (conn) => {
      const grants = await sql<{ grantee: string }>`
        select grantee from information_schema.routine_privileges
         where routine_schema = 'app' and routine_name = 'record_action_allows'
           and privilege_type = 'EXECUTE'
         order by grantee
      `.execute(conn);
      const grantees = grants.rows.map((row) => row.grantee).filter((name) => name !== "PUBLIC");
      expect(grantees).toContain(APP_ROLE);
      expect(grantees).not.toContain(databaseRole("worker").name);
      expect(grants.rows.map((row) => row.grantee)).not.toContain("PUBLIC");
    });
  }, TEST_TIMEOUT);

  test("the shipped manifest declares no record-action entity yet, so the lookup denies everything", () => {
    // Opt-in means opt-in: nothing in this repository's authoring carries the
    // axis, so no production table is reachable through the function today.
    expect(recordActionEntities()).toEqual([]);
  });
});


/**
 * ONE lock ordering, used by all three participants: the ACL row of the
 * subject record is locked first and held until commit.
 *
 *   policy change   the ordinary UPDATE of the ACL field takes the row lock
 *                   PostgreSQL gives every UPDATE;
 *   runtime check   `for share` inside app.record_action_allows, in the
 *                   caller's transaction;
 *   effect          after the check, in that same transaction, under that
 *                   same lock.
 *
 * Both interleavings are driven on two separate restricted connections and
 * asserted on pg_blocking_pids — the test fails if the contending statement is
 * never actually blocked, so nothing here rests on a sleep having been long
 * enough.
 */
describe("the lock ordering serializes a policy change against a check", () => {
  const machine = () => session({
    userId: randomUUID(), principalKind: "service",
    appPrincipal: { integrationId: integration },
  });
  // The row names otherPerson for view and edit: the realistic holder of
  // editor authority, which is what assigning or revoking an action needs.
  const editor = () => session({ userId: otherPerson, principalKind: "person" });

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

  /** Waits for `label` to be genuinely blocked, and fails if it never is. */
  async function awaitBlocked(label: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
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
    throw new Error(`${label} never blocked; the ACL row was not locked.`);
  }

  function revokedAcl(): string {
    // View and edit stay, so the editor keeps the row it is changing.
    return JSON.stringify({
      view: { users: [otherPerson] }, edit: { users: [otherPerson] }, actions: {},
    });
  }

  test("check first: the revocation waits for the effect to commit", async () => {
    const checker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const revoker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const checked = Promise.withResolvers<void>();
      const effectDone = Promise.withResolvers<void>();
      const checking = labelled(checker, machine(), "ra-check-first", async (trx) => {
        const allowed = (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${RUN}, ${lockRowCheckFirst}, 'start') as allowed
        `.execute(trx)).rows[0]?.allowed === true;
        checked.resolve();
        // Stand in for the effect: the lock is held for as long as the
        // Operation's transaction runs.
        await effectDone.promise;
        return allowed;
      });
      await checked.promise;
      const revoking = labelled(revoker, editor(), "ra-revoke-second", async (trx) => {
        await sql`update erp.action_runs set acl = ${sql.raw(`'${revokedAcl()}'::jsonb`)}
          where id = ${lockRowCheckFirst}::uuid`.execute(trx);
        return "revoked" as const;
      });
      await awaitBlocked("ra-revoke-second");
      effectDone.resolve();
      expect(await checking).toBe(true);
      expect(await revoking).toBe("revoked");
      // And once it has committed, the next check is a denial.
      expect(await allows(app.db, machine(), RUN, lockRowCheckFirst, "start")).toBe(false);
    } finally {
      await checker.close();
      await revoker.close();
    }
  }, TEST_TIMEOUT);

  test("revoke first: the check waits and then reads the revocation", async () => {
    const checker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const revoker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const written = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const revoking = labelled(revoker, editor(), "ra-revoke-first", async (trx) => {
        await sql`update erp.action_runs set acl = ${sql.raw(`'${revokedAcl()}'::jsonb`)}
          where id = ${lockRowRevokeFirst}::uuid`.execute(trx);
        written.resolve();
        await release.promise;
        return "revoked" as const;
      });
      await written.promise;
      const checking = labelled(checker, machine(), "ra-check-second", async (trx) =>
        (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${RUN}, ${lockRowRevokeFirst}, 'start') as allowed
        `.execute(trx)).rows[0]?.allowed === true);
      await awaitBlocked("ra-check-second");
      release.resolve();
      expect(await revoking).toBe("revoked");
      // Not the grant that was live when the check started: the one that is
      // live now. A READ COMMITTED re-read after the lock is released is what
      // makes this the committed answer rather than a stale snapshot.
      expect(await checking).toBe(false);
    } finally {
      await checker.close();
      await revoker.close();
    }
  }, TEST_TIMEOUT);
});

/**
 * What the ACTION's declared lock mode does to two holders in parallel.
 *
 * The check and the effect are one transaction, with the check's row lock
 * taken first. If the effect then needs a stronger lock on that same row, the
 * strength the check took decides whether two parallel holders serialize or
 * deadlock:
 *
 *   shared     both pass the check holding a shared lock, both try to upgrade,
 *              and each waits for the other to let go. PostgreSQL detects the
 *              cycle and aborts one transaction (SQLSTATE 40P01).
 *   exclusive  the second holder waits at the CHECK. Only one holder is ever
 *              positioned to upgrade, so there is no cycle to detect.
 *
 * Both are driven on two separate restricted connections against real
 * transactions, and the serialization is asserted on pg_blocking_pids rather
 * than on a sleep. The deadlock case is here deliberately: it is the proof
 * that `exclusive` is load-bearing and not a precaution, and the reason it is
 * the default a silent manifest compiles to.
 */
describe("the declared lock decides what two parallel holders do", () => {
  const machine = () => session({
    userId: randomUUID(), principalKind: "service",
    appPrincipal: { integrationId: integration },
  });

  async function labelledJob<T>(
    runtime: DatabaseRuntime,
    label: string,
    work: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return withDbSession(runtime.db, machine(), async (trx) => {
      await sql`select set_config('application_name', ${label}, false)`.execute(trx);
      // deadlock_timeout is not settable by the restricted app role, so the
      // deadlock case waits out the server default (1s) before PostgreSQL
      // looks for a cycle. That is the real deployment's behaviour too.
      return work(trx);
    });
  }

  async function blocked(label: string): Promise<boolean> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const count = await admin.db.connection().execute(async (conn) =>
        (await sql<{ count: number }>`
          select count(*)::int as count
            from pg_stat_activity
           where application_name = ${label}
             and cardinality(pg_blocking_pids(pid)) > 0
        `.execute(conn)).rows[0]!.count);
      if (count > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  /** The effect: the row-exclusive lock a handler that writes the record takes. */
  async function lockForUpdate(trx: Transaction<DB>, row: string): Promise<number> {
    const result = await sql<{ id: string }>`
      select id from erp.action_jobs where id = ${row}::uuid for update
    `.execute(trx);
    return result.rows.length;
  }

  test("shared lets both through the check and then deadlocks on the upgrade", async () => {
    const first = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const second = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const bothChecked = Promise.withResolvers<void>();
      let checked = 0;
      const holder = (runtime: DatabaseRuntime, label: string) =>
        labelledJob(runtime, label, async (trx) => {
          const allowed = (await sql<{ allowed: boolean | null }>`
            select app.record_action_allows(${JOB}, ${jobRowShared}, 'claimShared') as allowed
          `.execute(trx)).rows[0]?.allowed === true;
          expect(allowed).toBe(true);
          checked += 1;
          if (checked === 2) bothChecked.resolve();
          await bothChecked.promise;
          // Both now hold a SHARED lock on the ACL row and both want it
          // exclusively. Neither can have it.
          return lockForUpdate(trx, jobRowShared);
        });
      const outcomes = await Promise.allSettled([
        holder(first, "ra-shared-1"),
        holder(second, "ra-shared-2"),
      ]);
      // Exactly one transaction survives; the other is the deadlock victim.
      const failures = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(failures).toHaveLength(1);
      expect(String((failures[0] as PromiseRejectedResult).reason)).toMatch(/deadlock/i);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  }, TEST_TIMEOUT);

  test("exclusive serializes at the check, so the upgrade is safe", async () => {
    const first = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const second = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const firstChecked = Promise.withResolvers<void>();
      const firstDone = Promise.withResolvers<void>();
      const order: string[] = [];
      const leader = labelledJob(first, "ra-exclusive-1", async (trx) => {
        const allowed = (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${JOB}, ${jobRowExclusive}, 'claimExclusive') as allowed
        `.execute(trx)).rows[0]?.allowed === true;
        expect(allowed).toBe(true);
        firstChecked.resolve();
        await firstDone.promise;
        const rows = await lockForUpdate(trx, jobRowExclusive);
        order.push("leader");
        return rows;
      });
      await firstChecked.promise;
      const follower = labelledJob(second, "ra-exclusive-2", async (trx) => {
        const allowed = (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${JOB}, ${jobRowExclusive}, 'claimExclusive') as allowed
        `.execute(trx)).rows[0]?.allowed === true;
        expect(allowed).toBe(true);
        const rows = await lockForUpdate(trx, jobRowExclusive);
        order.push("follower");
        return rows;
      });
      // The follower is held at its CHECK — before it holds anything the
      // leader needs — which is the whole point of the mode.
      expect(await blocked("ra-exclusive-2")).toBe(true);
      firstDone.resolve();
      expect(await leader).toBe(1);
      expect(await follower).toBe(1);
      expect(order).toEqual(["leader", "follower"]);
    } finally {
      await first.close();
      await second.close();
    }
  }, TEST_TIMEOUT);

  test("the revocation fence is the same under the shared mode", async () => {
    // The weaker mode trades parallel holders for nothing else: a concurrent
    // ACL change still cannot interleave with a check in flight.
    const checker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    const revoker = createDatabaseRuntime({ databaseUrl: url(scratch, true), maxConnections: 1 });
    try {
      const checked = Promise.withResolvers<void>();
      const effectDone = Promise.withResolvers<void>();
      const checking = labelledJob(checker, "ra-shared-fence-check", async (trx) => {
        const allowed = (await sql<{ allowed: boolean | null }>`
          select app.record_action_allows(${JOB}, ${jobRowSharedFence}, 'claimShared') as allowed
        `.execute(trx)).rows[0]?.allowed === true;
        checked.resolve();
        await effectDone.promise;
        return allowed;
      });
      await checked.promise;
      const revoking = withDbSession(
        revoker.db,
        session({ userId: otherPerson, principalKind: "person" }),
        async (trx) => {
          await sql`select set_config('application_name', 'ra-shared-fence-revoke', false)`.execute(trx);
          await sql`update erp.action_jobs
            set acl = ${sql.raw(`'${JSON.stringify({
              view: { users: [otherPerson] }, edit: { users: [otherPerson] }, actions: {},
            })}'::jsonb`)}
            where id = ${jobRowSharedFence}::uuid`.execute(trx);
          return "revoked" as const;
        },
      );
      expect(await blocked("ra-shared-fence-revoke")).toBe(true);
      effectDone.resolve();
      expect(await checking).toBe(true);
      expect(await revoking).toBe("revoked");
      expect(await allows(app.db, machine(), JOB, jobRowSharedFence, "claimShared")).toBe(false);
    } finally {
      await checker.close();
      await revoker.close();
    }
  }, TEST_TIMEOUT);
});

describe("existing human behaviour is unchanged", () => {
  test("a default-public ACL stays readable and a view grant still gates the row", async () => {
    const viewer = session({ userId: otherPerson, principalKind: "person" });
    const stranger = session({ userId: randomUUID(), principalKind: "person" });
    const readable = async (input: DbSessionInput, table: string) =>
      withDbSession(app.db, input, async (trx) =>
        (await sql<{ count: number }>`select count(*)::int as count from ${sql.id("erp", table)}`
          .execute(trx)).rows[0]!.count);
    // action_docs is empty=public and its ACL grants no view: still public.
    expect(await readable(stranger, "action_docs")).toBe(1);
    // action_runs is empty=restricted and names otherPerson for view on all
    // three tenant-A rows; the fourth belongs to the other tenant.
    expect(await readable(viewer, "action_runs")).toBe(3);
    expect(await readable(stranger, "action_runs")).toBe(0);
    // Holding an action never adds a row to either answer.
    const machine = session({
      userId: randomUUID(), principalKind: "service",
      appPrincipal: { integrationId: integration },
    });
    expect(await readable(machine, "action_runs")).toBe(0);
    expect(await readable(machine, "action_docs")).toBe(1);
  }, TEST_TIMEOUT);
});
