// SPDX-License-Identifier: BUSL-1.1
/**
 * The record-action privileges as a real deployment installs them: by a
 * MIGRATE role that is NOSUPERUSER and NOBYPASSRLS and holds nothing but
 * ownership of its own database and membership of the declared definer roles.
 *
 * Every statement the lookup needs is a privileged one — column-level GRANT,
 * CREATE POLICY, and an ownership transfer to another role — so "it worked as
 * the superuser" proves nothing about the environments this ships into. This
 * test is the one that says the design is deployable.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
  type OpenShapeForgeDatabase,
} from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { DATABASE_ROLES, databaseRole } from "../database-roles.js";
import {
  applyRecordActionsMigration,
  type RecordActionEntity,
} from "../migrations/record-actions.js";
import { APP_ROLE } from "../migrations/app-role.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 240_000;
const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const scratch = `record_actions_restricted_${suffix}`;
const migrateRole = `osf_restricted_migrate_${suffix}`;
/** A throwaway role the resolver is briefly made a member OF, and no more. */
const parentRole = `osf_resolver_parent_${suffix}`;
const MIGRATE_PASSWORD = "restricted-migrate";
const RESOLVER_ROLE = databaseRole("recordActionResolver").name;

let server: SQL;
let migrate: DatabaseRuntime;

function url(role?: { username: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${scratch}`;
  if (role) {
    parsed.username = role.username;
    parsed.password = role.password;
  }
  return parsed.toString();
}

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch) || !/^[a-z0-9_]+$/.test(migrateRole)) {
    throw new Error("unsafe scratch identifiers");
  }
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(
    `create role ${migrateRole} login password '${MIGRATE_PASSWORD}' ` +
      "nosuperuser nobypassrls nocreaterole nocreatedb",
  );
  // Exactly the contract apps/api/src/db/database-roles.ts states: the host
  // provisions the roles and makes the migrate role a member of the definer
  // ones. Nothing else is granted — no CREATEROLE, no BYPASSRLS, no SUPERUSER.
  for (const role of DATABASE_ROLES) {
    if (role.migratorMember) {
      await server.unsafe(`grant ${role.name} to ${migrateRole} with inherit true, set true`);
    }
  }
  await server.unsafe(`create database "${scratch}" owner ${migrateRole}`);
  migrate = createDatabaseRuntime({
    databaseUrl: url({ username: migrateRole, password: MIGRATE_PASSWORD }),
    maxConnections: 2,
  });
}, TEST_TIMEOUT);

afterAll(async () => {
  await migrate?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.unsafe(`revoke ${parentRole} from ${RESOLVER_ROLE}`).catch(() => undefined);
  await server?.unsafe(`drop role if exists ${parentRole}`);
  await server?.unsafe(`drop role if exists ${migrateRole}`);
  await server?.close();
});

test("the restricted migrate role installs the lookup, its grants and its policies", async () => {
  await migrate.db.connection().execute(async (conn) => {
    const current = await sql<{ user: string; superuser: boolean; bypass: boolean }>`
      select current_user as "user",
             (select rolsuper from pg_roles where rolname = current_user) as superuser,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass
    `.execute(conn);
    expect(current.rows[0]).toEqual({ user: migrateRole, superuser: false, bypass: false });

    // The whole chain, including the record-action step, with no elevation.
    await runMigrationChain(conn);

    // Then an entity that declares an action — the case the shipped manifest
    // does not have yet, so the grants and policies are exercised rather than
    // skipped.
    await sql`
      create table erp.restricted_runs (
        id uuid primary key,
        tenant_id uuid not null,
        secret text not null,
        definition text not null,
        acl jsonb not null default '{}'::jsonb
      )
    `.execute(conn);
    await sql`alter table erp.restricted_runs enable row level security`.execute(conn);
    await sql`alter table erp.restricted_runs force row level security`.execute(conn);
    await sql`
      create policy restricted_runs_row_scope on erp.restricted_runs
      using (app.bypass_rls() or (tenant_id = app.current_tenant()
        and app.record_permission_allows("acl", 'view', false)))
      with check (app.bypass_rls() or tenant_id = app.current_tenant())
    `.execute(conn);
    const installed = await applyRecordActionsMigration(conn, [{
      entity: "RestrictedRun", schema: "erp", table: "restricted_runs",
      keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
      actions: ["start"],
      reads: { start: [{ field: "definition", column: "definition" }] },
      locks: { start: "exclusive" },
    }]);
    expect(installed.map((entity) => entity.entity)).toEqual(["RestrictedRun"]);

    // Both functions exist and are owned by the definer role, not the
    // migrate role that created them.
    const owners = await sql<{ name: string; owner: string; definer: boolean }>`
      select p.proname as name, r.rolname as owner, p.prosecdef as definer
        from pg_proc p
        join pg_roles r on r.oid = p.proowner
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app'
         and p.proname in ('record_action_allows', 'record_action_read')
       order by p.proname
    `.execute(conn);
    expect(owners.rows).toEqual([
      { name: "record_action_allows", owner: RESOLVER_ROLE, definer: true },
      { name: "record_action_read", owner: RESOLVER_ROLE, definer: true },
    ]);

    // The narrow grants landed, including the lock privilege and no more.
    const columns = await sql<{ column_name: string; privilege_type: string }>`
      select column_name, privilege_type
        from information_schema.column_privileges
       where grantee = ${RESOLVER_ROLE} and table_name = 'restricted_runs'
       order by privilege_type, column_name
    `.execute(conn);
    expect(columns.rows).toEqual([
      { column_name: "acl", privilege_type: "SELECT" },
      { column_name: "definition", privilege_type: "SELECT" },
      { column_name: "id", privilege_type: "SELECT" },
      { column_name: "tenant_id", privilege_type: "SELECT" },
      { column_name: "acl", privilege_type: "UPDATE" },
    ]);

    // And NOTHING table-wide. A table-level UPDATE would reach every column,
    // and TRUNCATE is outside row security altogether, so the step revokes
    // before it grants and reads the result back.
    const tableWide = await sql<{ privilege_type: string }>`
      select privilege_type from information_schema.table_privileges
       where grantee = ${RESOLVER_ROLE} and table_name = 'restricted_runs'
       order by privilege_type
    `.execute(conn);
    expect(tableWide.rows).toEqual([]);

    // CREATE POLICY ... AS RESTRICTIVE is a privileged statement too, and the
    // two fences are what bound the column grants above.
    const policies = await sql<{ policyname: string; cmd: string; permissive: string }>`
      select policyname, cmd, permissive
        from pg_policies
       where schemaname = 'erp' and tablename = 'restricted_runs'
         and ${RESOLVER_ROLE} = any(roles)
       order by policyname
    `.execute(conn);
    expect(policies.rows).toEqual([
      { policyname: "restricted_runs_record_action_delete_fence", cmd: "DELETE", permissive: "RESTRICTIVE" },
      { policyname: "restricted_runs_record_action_fence", cmd: "ALL", permissive: "RESTRICTIVE" },
      { policyname: "restricted_runs_record_action_lock", cmd: "UPDATE", permissive: "PERMISSIVE" },
      { policyname: "restricted_runs_record_action_read", cmd: "SELECT", permissive: "PERMISSIVE" },
    ]);

    // The fence is scoped `to <resolver>`, and RLS matches a policy's TO list
    // with has_privs_of_role — so it applies to THIS role as well, which the
    // contract makes a member of every definer role. The migrate role must
    // still be able to write the tables it migrates and seeds, and what
    // exempts it is that it holds the OWNER's privileges on this table, not
    // that it is "not the resolver": that older disjunct exempted every member
    // of the resolver, including one that owns nothing.
    const standing = await sql<{ member: boolean; owner: boolean; resolverOwns: boolean }>`
      select pg_has_role(current_user, ${RESOLVER_ROLE}, 'USAGE') as member,
        pg_has_role(current_user,
          (select relowner from pg_class where oid = 'erp.restricted_runs'::regclass),
          'USAGE') as owner,
        pg_has_role(${RESOLVER_ROLE},
          (select relowner from pg_class where oid = 'erp.restricted_runs'::regclass),
          'USAGE') as "resolverOwns"
    `.execute(conn);
    expect(standing.rows[0]).toEqual({ member: true, owner: true, resolverOwns: false });
    const tenant = randomUUID();
    await sql`select set_config('app.tenant_id', ${tenant}, false)`.execute(conn);
    await sql`
      insert into erp.restricted_runs (id, tenant_id, secret, definition, acl)
      values (${randomUUID()}::uuid, ${tenant}::uuid, 'seeded', 'graph', '{}'::jsonb)
    `.execute(conn);
    const updated = await sql`
      update erp.restricted_runs set acl = '{"view": {"users": []}}'::jsonb
       where tenant_id = ${tenant}::uuid
    `.execute(conn);
    expect(Number(updated.numAffectedRows ?? 0)).toBe(1);
    await sql`delete from erp.restricted_runs where tenant_id = ${tenant}::uuid`.execute(conn);

    // EXECUTE ends up where it should, after the two privilege sweeps that
    // run before this step would otherwise have widened it.
    const execute = await sql<{ grantee: string }>`
      select grantee from information_schema.routine_privileges
       where routine_schema = 'app'
         and routine_name in ('record_action_allows', 'record_action_read')
         and privilege_type = 'EXECUTE'
       order by grantee
    `.execute(conn);
    const grantees = new Set(execute.rows.map((row) => row.grantee));
    expect(grantees.has(APP_ROLE)).toBe(true);
    expect(grantees.has("PUBLIC")).toBe(false);
    expect(grantees.has(databaseRole("worker").name)).toBe(false);

    // Re-running is a no-op, which is what the chain relies on.
    await applyRecordActionsMigration(conn, [{
      entity: "RestrictedRun", schema: "erp", table: "restricted_runs",
      keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
      actions: ["start"],
      reads: { start: [{ field: "definition", column: "definition" }] },
      locks: { start: "exclusive" },
    }]);
  });
}, TEST_TIMEOUT);

/** The grants the shipped `RestrictedRun` declaration asks for. */
const RESTRICTED_RUN: RecordActionEntity = {
  entity: "RestrictedRun", schema: "erp", table: "restricted_runs",
  keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
  actions: ["start"],
  reads: { start: [{ field: "definition", column: "definition" }] },
  locks: { start: "exclusive" },
};
const DECLARED_GRANTS = [
  "SELECT acl", "SELECT definition", "SELECT id", "SELECT tenant_id", "UPDATE acl",
];

const resolverGrants = (conn: OpenShapeForgeDatabase) =>
  sql<{ column_name: string; privilege_type: string }>`
    select column_name, privilege_type from information_schema.column_privileges
     where grantee = ${RESOLVER_ROLE} and table_name = 'restricted_runs'
     order by privilege_type, column_name
  `.execute(conn).then((result) =>
    result.rows.map((row) => `${row.privilege_type} ${row.column_name}`));

/**
 * PUBLIC is a grantee like any other, and the resolver holds everything PUBLIC
 * holds.
 *
 * Nothing in the step grants to PUBLIC and `revoke all ... from <resolver>`
 * does not reach a PUBLIC grant, so reading only the resolver's own ACL
 * entries reports an exact privilege set the resolver does not have: with
 * `grant delete, truncate to public` the step used to succeed while the
 * resolver could TRUNCATE the table, which is outside row security entirely.
 *
 * The PUBLIC grant is NOT revoked by the migration — it belongs to every role
 * in the cluster — so the step refuses the table and names the remedy.
 */
test("it refuses an entity table PUBLIC holds a privilege on", async () => {
  await migrate.db.connection().execute(async (conn) => {
    expect(await resolverGrants(conn)).toEqual(DECLARED_GRANTS);

    // The two privileges no policy can bound: TRUNCATE ignores row security,
    // and DELETE is admitted by the delete fence for the session's own tenant.
    await sql`grant delete, truncate on erp.restricted_runs to public`.execute(conn);
    try {
      const effective = await sql<{ truncate: boolean; remove: boolean; granted: number }>`
        select has_table_privilege(${RESOLVER_ROLE}, 'erp.restricted_runs', 'TRUNCATE') as truncate,
               has_table_privilege(${RESOLVER_ROLE}, 'erp.restricted_runs', 'DELETE') as remove,
               (select count(*)::int from information_schema.table_privileges
                 where grantee = ${RESOLVER_ROLE} and table_name = 'restricted_runs') as granted
      `.execute(conn);
      // Nothing is granted TO the resolver, and it holds both regardless.
      expect(effective.rows[0]).toEqual({ truncate: true, remove: true, granted: 0 });
      await expect(applyRecordActionsMigration(conn, [RESTRICTED_RUN]))
        .rejects.toThrow(/PUBLIC holds DELETE, TRUNCATE/);
      // The refusal is before the first grant and inside the transaction, so
      // the deployment keeps the grants it had.
      expect(await resolverGrants(conn)).toEqual(DECLARED_GRANTS);
    } finally {
      await sql`revoke delete, truncate on erp.restricted_runs from public`.execute(conn);
    }

    // A PUBLIC COLUMN grant: narrower, outside the declared projection, and
    // just as invisible to a read of the resolver's own grants.
    await sql`grant select (secret) on erp.restricted_runs to public`.execute(conn);
    try {
      const leaked = await sql<{ secret: boolean }>`
        select has_column_privilege(${RESOLVER_ROLE}, 'erp.restricted_runs', 'secret', 'SELECT')
          as secret
      `.execute(conn);
      expect(leaked.rows[0]).toEqual({ secret: true });
      await expect(applyRecordActionsMigration(conn, [RESTRICTED_RUN]))
        .rejects.toThrow(/PUBLIC holds SELECT\(secret\)/);
    } finally {
      await sql`revoke select (secret) on erp.restricted_runs from public`.execute(conn);
    }

    // PUBLIC holding nothing is the ordinary case: the default ACL of a table
    // grants it nothing, and the step installs as before.
    await applyRecordActionsMigration(conn, [RESTRICTED_RUN]);
    expect(await resolverGrants(conn)).toEqual(DECLARED_GRANTS);
  });
}, TEST_TIMEOUT);

/**
 * The definer role's own attributes, which no policy can compensate for.
 *
 * BYPASSRLS ignores FORCE ROW LEVEL SECURITY and every policy with it, so a
 * resolver carrying it would hold the column grants unbounded; and a resolver
 * that INHERITS another role runs both SECURITY DEFINER bodies with whatever
 * that role holds. Roles are cluster-wide, so each case is applied to the real
 * declared role and undone in the same test.
 */
test("it refuses to grant anything to a resolver role that is outside its own bounds", async () => {
  const cases = [
    { apply: `alter role ${RESOLVER_ROLE} bypassrls`, undo: `alter role ${RESOLVER_ROLE} nobypassrls`,
      expected: /has BYPASSRLS/ },
    { apply: `alter role ${RESOLVER_ROLE} login`, undo: `alter role ${RESOLVER_ROLE} nologin`,
      expected: /it can log in/ },
    { apply: `create role ${parentRole} nologin; alter role ${RESOLVER_ROLE} inherit; ` +
        `grant ${parentRole} to ${RESOLVER_ROLE}`,
      undo: `revoke ${parentRole} from ${RESOLVER_ROLE}; alter role ${RESOLVER_ROLE} noinherit; ` +
        `drop role ${parentRole}`,
      expected: new RegExp(`it is a member of ${parentRole}, whose privileges it INHERITS`) },
  ];
  for (const scenario of cases) {
    await server.unsafe(scenario.apply);
    try {
      await migrate.db.connection().execute(async (conn) => {
        await expect(applyRecordActionsMigration(conn, [{
          entity: "RestrictedRun", schema: "erp", table: "restricted_runs",
          keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
          actions: ["start"], reads: {}, locks: { start: "exclusive" },
        }])).rejects.toThrow(scenario.expected);
      });
    } finally {
      await server.unsafe(scenario.undo);
    }
  }
  // Back inside its bounds, the step runs again.
  await migrate.db.connection().execute((conn) =>
    applyRecordActionsMigration(conn, [{
      entity: "RestrictedRun", schema: "erp", table: "restricted_runs",
      keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
      actions: ["start"],
      reads: { start: [{ field: "definition", column: "definition" }] },
      locks: { start: "exclusive" },
    }]));
}, TEST_TIMEOUT);

/**
 * The policies bound the column grants, and a policy binds nothing while row
 * security is off or unforced on the table. The generated schema always emits
 * both for a tenant-scoped table, so this is the case that proves the step
 * refuses to hand out the grants rather than trusting that.
 */
test("it refuses to grant anything on a table whose row security is not forced", async () => {
  await migrate.db.connection().execute(async (conn) => {
    const entity = (table: string) => [{
      entity: "Unbounded", schema: "erp", table,
      keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
      actions: ["start"], reads: {}, locks: { start: "exclusive" as const },
    }];
    for (const [table, pattern] of [
      ["rls_absent_runs", /row level security is not enabled on it/],
      ["rls_unforced_runs", /row level security is not FORCED on it/],
    ] as const) {
      await sql.raw(`
        create table erp.${table} (
          id uuid primary key, tenant_id uuid not null, acl jsonb not null default '{}'::jsonb)
      `).execute(conn);
      if (table === "rls_unforced_runs") {
        await sql.raw(`alter table erp.${table} enable row level security`).execute(conn);
      }
      await expect(applyRecordActionsMigration(conn, entity(table))).rejects.toThrow(pattern);
      // And nothing was granted on the way to the refusal.
      const granted = await sql<{ count: number }>`
        select count(*)::int as count from information_schema.column_privileges
         where grantee = ${RESOLVER_ROLE} and table_name = ${table}
      `.execute(conn);
      expect(granted.rows[0]!.count).toBe(0);
      await sql.raw(`drop table erp.${table}`).execute(conn);
    }
  });
}, TEST_TIMEOUT);
