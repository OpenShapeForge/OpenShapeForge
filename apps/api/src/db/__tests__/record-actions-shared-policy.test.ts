// SPDX-License-Identifier: BUSL-1.1
/**
 * A policy under one of this module's four names that is NOT the resolver's
 * alone.
 *
 * Both halves of the step change policies by NAME: the per-entity loop drops
 * and recreates its four, and the stale-grant cleanup drops them on a table
 * the manifest no longer declares. `pg_policy.polroles` is a list, so a
 * deployment that ran `alter policy <table>_record_action_read on <table> to
 * <resolver>, <other>` — or that created a policy of its own under one of
 * these names — holds another role's row-level access in an object this
 * migration was about to rewrite. Dropping it takes that access away;
 * recreating it `to <resolver>` alone is worse, because the catalog still
 * shows a policy by that name while the other role no longer has it.
 *
 * So neither half decides by name. A policy is this module's only if its `TO`
 * list is the resolver and nothing else, and every other list under one of
 * these names fails the step: a second role's, and `polroles = {0}`, which
 * names no role and therefore applies to every role in the cluster.
 *
 * Nothing here is the default shape. `applyRecordActions` writes each of its
 * policies `to <resolver>` alone, so a deployment that has not run `alter
 * policy` or `create policy` itself cannot reach any of these refusals — the
 * last test is the ordinary cleanup, on the same tables, proving the gate does
 * not stand in its way.
 *
 * It runs under the RESTRICTED migrate role — NOSUPERUSER, NOBYPASSRLS,
 * owning only its own database — because the refusals are about what one
 * table owner may do to another role's policy, and "it worked as the
 * superuser" would prove nothing about the deployments this ships into.
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

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 240_000;
const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const scratch = `record_actions_shared_${suffix}`;
const migrateRole = `osf_shared_migrate_${suffix}`;
/** A role the deployment added to one of the policies. Not a declared role. */
const otherRole = `osf_shared_other_${suffix}`;
const MIGRATE_PASSWORD = "shared-migrate";
const RESOLVER_ROLE = databaseRole("recordActionResolver").name;

/** Stays declared in every manifest below. Its state is the rollback proof. */
const KEPT = "shared_keeps";
/** Removed from the manifest, so the CLEANUP is what reaches its policies. */
const DROPPED = "shared_drops";
const TABLES = [KEPT, DROPPED] as const;

let server: SQL;
let migrate: DatabaseRuntime;

function entity(table: string, name: string, reads: string[]): RecordActionEntity {
  return {
    entity: name,
    schema: "erp",
    table,
    keyColumn: "id",
    keyIsUuid: true,
    aclColumn: "acl",
    actions: ["start"],
    reads: { start: reads.map((field) => ({ field, column: field })) },
    locks: { start: "exclusive" },
  };
}

/** Both entities declared, `shared_keeps` reading both of its fields. */
const BOTH: RecordActionEntity[] = [
  entity(KEPT, "SharedKeep", ["definition", "secret"]),
  entity(DROPPED, "SharedDrop", ["definition"]),
];
/**
 * `shared_drops` gone, and `shared_keeps` NARROWED. The narrowing is what
 * makes a rollback observable: the step revokes and regrants `shared_keeps`
 * before it ever reaches the cleanup, so if a refusal in the cleanup left
 * anything behind, `shared_keeps` would be holding the narrow grant set.
 */
const KEPT_ONLY: RecordActionEntity[] = [entity(KEPT, "SharedKeep", ["definition"])];

const WIDE = [
  "SELECT acl", "SELECT definition", "SELECT id", "SELECT secret", "SELECT tenant_id",
  "UPDATE acl",
];
const NARROW = ["SELECT acl", "SELECT definition", "SELECT id", "SELECT tenant_id", "UPDATE acl"];
const FOUR = (table: string) => [
  `${table}_record_action_delete_fence`,
  `${table}_record_action_fence`,
  `${table}_record_action_lock`,
  `${table}_record_action_read`,
];

function url(role?: { username: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${scratch}`;
  if (role) {
    parsed.username = role.username;
    parsed.password = role.password;
  }
  return parsed.toString();
}

const columnGrants = (conn: OpenShapeForgeDatabase, table: string, grantee = RESOLVER_ROLE) =>
  sql<{ column_name: string; privilege_type: string }>`
    select column_name, privilege_type from information_schema.column_privileges
     where grantee = ${grantee} and table_name = ${table}
     order by privilege_type, column_name
  `.execute(conn).then((result) =>
    result.rows.map((row) => `${row.privilege_type} ${row.column_name}`));

const tableGrants = (conn: OpenShapeForgeDatabase, table: string, grantee: string) =>
  sql<{ privilege_type: string }>`
    select privilege_type from information_schema.table_privileges
     where grantee = ${grantee} and table_name = ${table}
     order by privilege_type
  `.execute(conn).then((result) => result.rows.map((row) => row.privilege_type));

/** Every policy on the table with its whole `TO` list, as the catalog holds it. */
const policies = (conn: OpenShapeForgeDatabase, table: string) =>
  sql<{ policyname: string; roles: string[] }>`
    select policyname, roles::text[] as roles from pg_policies
     where schemaname = 'erp' and tablename = ${table}
     order by policyname
  `.execute(conn).then((result) =>
    result.rows.map((row) => `${row.policyname} -> ${[...row.roles].sort().join(",")}`));

/**
 * The `TO` list of one policy in the order the CATALOG renders it, so an
 * expectation never hard-codes a collation's idea of how two role names sort.
 */
const policyRoles = (conn: OpenShapeForgeDatabase, table: string, suffixName: string) =>
  sql<{ roles: string[] }>`
    select roles::text[] as roles from pg_policies
     where schemaname = 'erp' and tablename = ${table}
       and policyname = ${`${table}_record_action_${suffixName}`}
  `.execute(conn).then((result) => result.rows[0]!.roles.join(", "));

const policyNames = (conn: OpenShapeForgeDatabase, table: string) =>
  sql<{ policyname: string }>`
    select policyname from pg_policies
     where schemaname = 'erp' and tablename = ${table} and ${RESOLVER_ROLE} = any(roles)
     order by policyname
  `.execute(conn).then((result) => result.rows.map((row) => row.policyname));

beforeAll(async () => {
  for (const name of [scratch, migrateRole, otherRole]) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error("unsafe scratch identifier");
  }
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(
    `create role ${migrateRole} login password '${MIGRATE_PASSWORD}' ` +
      "nosuperuser nobypassrls nocreaterole nocreatedb",
  );
  // The deployment's own role. NOT a member of the resolver and not a declared
  // role: it holds nothing except what the policies below name it in, which is
  // exactly what must survive every refusal.
  await server.unsafe(`create role ${otherRole} nologin nosuperuser nobypassrls`);
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
  await migrate.db.connection().execute(async (conn) => {
    await runMigrationChain(conn);
    for (const table of TABLES) {
      await sql.raw(`
        create table erp.${table} (
          id uuid primary key, tenant_id uuid not null, secret text not null,
          definition text not null default 'graph', acl jsonb not null default '{}'::jsonb)
      `).execute(conn);
      await sql.raw(`alter table erp.${table} enable row level security`).execute(conn);
      await sql.raw(`alter table erp.${table} force row level security`).execute(conn);
      await sql.raw(`
        create policy ${table}_tenant_isolation on erp.${table}
        using (app.bypass_rls() or tenant_id = app.current_tenant())
        with check (app.bypass_rls() or tenant_id = app.current_tenant())
      `).execute(conn);
      // The other role's OWN policy and grant, under a name this module does
      // not own. Nothing in this file may touch either.
      await sql.raw(`
        create policy ${table}_other_reads on erp.${table}
        for select to ${otherRole} using (tenant_id = app.current_tenant())
      `).execute(conn);
      await sql.raw(`grant select (definition) on erp.${table} to ${otherRole}`).execute(conn);
    }
    await applyRecordActionsMigration(conn, BOTH);
  });
}, TEST_TIMEOUT);

afterAll(async () => {
  await migrate?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.unsafe(`drop role if exists ${migrateRole}`);
  await server?.unsafe(`drop role if exists ${otherRole}`);
  await server?.close();
});

/** Put the other role into one of the four, as `alter policy` does. */
async function share(conn: OpenShapeForgeDatabase, table: string, suffixName: string) {
  await sql.raw(
    `alter policy ${table}_record_action_${suffixName} on erp.${table} ` +
      `to ${RESOLVER_ROLE}, ${otherRole}`,
  ).execute(conn);
}

/** Hand it back to the resolver alone, which is how this module writes it. */
async function unshare(conn: OpenShapeForgeDatabase, table: string, suffixName: string) {
  await sql.raw(
    `alter policy ${table}_record_action_${suffixName} on erp.${table} to ${RESOLVER_ROLE}`,
  ).execute(conn);
}

/** The other role's own policy and column grant, which must never change. */
async function expectOtherRoleIntact(conn: OpenShapeForgeDatabase) {
  for (const table of TABLES) {
    expect(await columnGrants(conn, table, otherRole)).toEqual(["SELECT definition"]);
    expect(await policies(conn, table)).toContain(`${table}_other_reads -> ${otherRole}`);
  }
}

test("the per-entity loop refuses a policy it would replace for a second role", async () => {
  await migrate.db.connection().execute(async (conn) => {
    expect(await columnGrants(conn, KEPT)).toEqual(WIDE);
    await share(conn, KEPT, "read");
    const both = await policyRoles(conn, KEPT, "read");
    expect(both.split(", ").sort()).toEqual([otherRole, RESOLVER_ROLE].sort());

    // The same manifest, re-applied. Without the gate this is a `drop policy`
    // and a `create policy ... to <resolver>` — the other role loses its
    // row-level access and the catalog still shows a policy by that name.
    await expect(applyRecordActionsMigration(conn, BOTH)).rejects.toThrow(
      `is not ${RESOLVER_ROLE}'s alone: ${KEPT}_record_action_read on erp.${KEPT} ` +
        `applies to ${both}.`,
    );
    // And it names the statements that resolve it rather than only the problem.
    await expect(applyRecordActionsMigration(conn, BOTH)).rejects.toThrow(
      /alter policy .* to <the roles that keep it>; or drop policy /,
    );

    // The policy still carries both roles, and the step is one transaction, so
    // everything else is as it was.
    expect(await policyRoles(conn, KEPT, "read")).toEqual(both);
    expect(await policyNames(conn, DROPPED)).toEqual(FOUR(DROPPED));
    expect(await columnGrants(conn, KEPT)).toEqual(WIDE);
    expect(await columnGrants(conn, DROPPED)).toEqual(NARROW);
    await expectOtherRoleIntact(conn);

    await unshare(conn, KEPT, "read");
    // Resolved, so the same manifest goes through again.
    await applyRecordActionsMigration(conn, BOTH);
    expect(await policyNames(conn, KEPT)).toEqual(FOUR(KEPT));
    expect(await columnGrants(conn, KEPT)).toEqual(WIDE);
  });
}, TEST_TIMEOUT);

test("the loop refuses one of its names that applies to every role", async () => {
  await migrate.db.connection().execute(async (conn) => {
    // `polroles = {0}`: a policy written with no `TO` list at all, which RLS
    // applies to every role in the cluster. The resolver is not in the list by
    // name, so a check that looked for it there would step straight over this.
    await sql.raw(`drop policy ${KEPT}_record_action_lock on erp.${KEPT}`).execute(conn);
    await sql.raw(`
      create policy ${KEPT}_record_action_lock on erp.${KEPT}
      for update using (tenant_id = app.current_tenant()) with check (false)
    `).execute(conn);
    expect(await policies(conn, KEPT)).toContain(`${KEPT}_record_action_lock -> public`);

    await expect(applyRecordActionsMigration(conn, BOTH)).rejects.toThrow(
      `${KEPT}_record_action_lock on erp.${KEPT} applies to every role in the cluster, ` +
        "because it names none",
    );
    expect(await policies(conn, KEPT)).toContain(`${KEPT}_record_action_lock -> public`);
    await expectOtherRoleIntact(conn);

    await sql.raw(`drop policy ${KEPT}_record_action_lock on erp.${KEPT}`).execute(conn);
    await applyRecordActionsMigration(conn, BOTH);
    expect(await policyNames(conn, KEPT)).toEqual(FOUR(KEPT));
  });
}, TEST_TIMEOUT);

test("the stale-grant cleanup refuses a shared policy on a removed entity", async () => {
  await migrate.db.connection().execute(async (conn) => {
    await share(conn, DROPPED, "fence");
    const both = await policyRoles(conn, DROPPED, "fence");
    expect(both.split(", ").sort()).toEqual([otherRole, RESOLVER_ROLE].sort());

    // `shared_drops` is in no entity, so only the cleanup reaches it. The
    // restrictive fence is the one policy whose loss would WIDEN the other
    // role's access rather than narrow it.
    await expect(applyRecordActionsMigration(conn, KEPT_ONLY)).rejects.toThrow(
      `is not ${RESOLVER_ROLE}'s alone: ${DROPPED}_record_action_fence on erp.${DROPPED} ` +
        `applies to ${both}.`,
    );

    // Nothing was revoked or dropped: the gate runs before the first revoke,
    // and the whole step is one transaction.
    expect(await policyRoles(conn, DROPPED, "fence")).toEqual(both);
    expect(await policyNames(conn, DROPPED)).toEqual(FOUR(DROPPED));
    expect(await columnGrants(conn, DROPPED)).toEqual(NARROW);
    // The rollback proof: `KEPT_ONLY` narrows `shared_keeps`, and the loop
    // revokes and regrants it long before the cleanup refuses. It still holds
    // the WIDE set, so the refusal took the whole transaction with it.
    expect(await columnGrants(conn, KEPT)).toEqual(WIDE);
    await expectOtherRoleIntact(conn);
  });
}, TEST_TIMEOUT);

test("the cleanup refuses one of its names it finds on another role alone", async () => {
  await migrate.db.connection().execute(async (conn) => {
    await unshare(conn, DROPPED, "fence");
    // The resolver is not in this list at all. The name is still one this
    // module drops, so leaving it in place while reporting the footprint taken
    // back would be the same silence as dropping another role's policy.
    await sql.raw(
      `alter policy ${DROPPED}_record_action_read on erp.${DROPPED} to ${otherRole}`,
    ).execute(conn);

    await expect(applyRecordActionsMigration(conn, KEPT_ONLY)).rejects.toThrow(
      `is not ${RESOLVER_ROLE}'s alone: ${DROPPED}_record_action_read on erp.${DROPPED} ` +
        `applies to ${otherRole}.`,
    );
    expect(await policies(conn, DROPPED))
      .toContain(`${DROPPED}_record_action_read -> ${otherRole}`);
    expect(await columnGrants(conn, DROPPED)).toEqual(NARROW);
    expect(await columnGrants(conn, KEPT)).toEqual(WIDE);
    await expectOtherRoleIntact(conn);
  });
}, TEST_TIMEOUT);

/**
 * The ordinary case, on the very tables the four refusals above ran against:
 * every record-action policy back `to <resolver>` alone, which is the only
 * shape this module writes. The gate must be invisible here.
 */
test("the ordinary cleanup still takes back a resolver-only footprint", async () => {
  await migrate.db.connection().execute(async (conn) => {
    await unshare(conn, DROPPED, "read");
    expect(await policyNames(conn, DROPPED)).toEqual(FOUR(DROPPED));

    await applyRecordActionsMigration(conn, KEPT_ONLY);

    // The removed entity: grants gone, all four policies gone.
    expect(await columnGrants(conn, DROPPED)).toEqual([]);
    expect(await tableGrants(conn, DROPPED, RESOLVER_ROLE)).toEqual([]);
    expect(await policyNames(conn, DROPPED)).toEqual([]);
    // And only those four. The generated tenant policy and the other role's
    // own policy are still on the table.
    expect(await policies(conn, DROPPED)).toEqual([
      `${DROPPED}_other_reads -> ${otherRole}`,
      `${DROPPED}_tenant_isolation -> public`,
    ]);
    // The still-declared entity took the narrowing this time.
    expect(await columnGrants(conn, KEPT)).toEqual(NARROW);
    expect(await policyNames(conn, KEPT)).toEqual(FOUR(KEPT));
    await expectOtherRoleIntact(conn);

    // Re-running changes nothing: there is no stale footprint left and the
    // cleanup must not churn on every migrate.
    await applyRecordActionsMigration(conn, KEPT_ONLY);
    expect(await columnGrants(conn, DROPPED)).toEqual([]);
    expect(await columnGrants(conn, KEPT)).toEqual(NARROW);
  });
}, TEST_TIMEOUT);
