// SPDX-License-Identifier: BUSL-1.1
/**
 * The record-action privileges across a real manifest UPGRADE: an old manifest
 * installed, a new one applied over it, and the question of what the resolver
 * still holds afterwards.
 *
 * Three shapes of change, derived through `recordActionEntities` from
 * manifest-shaped input rather than hand-written entity lists, because which
 * entities the step iterates is exactly what decides the answer:
 *
 *   still declared, projection narrowed   the step visits the table, and
 *                                         `revoke all` reaches the old column
 *                                         grant — nothing extra is needed;
 *   entity dropped                        the table is in no entity, so the
 *                                         loop never visits it;
 *   last action dropped                   same, one step earlier: an entity
 *                                         with no action is not a record-action
 *                                         entity at all.
 *
 * The last two are the ones a per-entity loop cannot fix, and the ones this
 * file exists for. It runs under the RESTRICTED migrate role — NOSUPERUSER,
 * NOBYPASSRLS, owning only its own database — because a revoke only reaches
 * what its grantor granted, and "it worked as the superuser" would prove
 * nothing about the deployments this ships into.
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
  recordActionEntities,
  type ManifestRecordActionTable,
} from "../migrations/record-actions.js";
import { APP_ROLE } from "../migrations/app-role.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 240_000;
const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const scratch = `record_actions_upgrade_${suffix}`;
const migrateRole = `osf_upgrade_migrate_${suffix}`;
const MIGRATE_PASSWORD = "upgrade-migrate";
const RESOLVER_ROLE = databaseRole("recordActionResolver").name;

/** Kept by the new manifest, with one read field fewer. */
const KEPT = "upgrade_keeps";
/** Removed from the new manifest altogether. */
const DROPPED = "upgrade_drops";
/** Still a table and still an entity, but its last action is gone. */
const QUIETED = "upgrade_quiets";
const TABLES = [KEPT, DROPPED, QUIETED] as const;

let server: SQL;
let migrate: DatabaseRuntime;

const COLUMNS = [
  { name: "id", primaryKey: true, type: "uuid" },
  { name: "tenant_id", type: "uuid" },
  { name: "secret", type: "text" },
  { name: "definition", type: "text" },
  { name: "acl", type: "jsonb" },
];

function manifestTable(
  name: string,
  entity: string,
  actions: Array<{ name: string; principals: string[]; reads?: string[] }>,
): ManifestRecordActionTable {
  return {
    schema: "erp",
    name,
    tenantScoped: true,
    columns: COLUMNS,
    source: {
      authoringEntityName: entity,
      authorization: { recordPermissions: { column: "acl", actions } },
    },
  };
}

/** The manifest before the upgrade: all three entities declare `start`. */
const OLD_MANIFEST: ManifestRecordActionTable[] = [
  manifestTable(KEPT, "UpgradeKeep", [
    { name: "start", principals: ["users"], reads: ["definition", "secret"] },
  ]),
  manifestTable(DROPPED, "UpgradeDrop", [
    { name: "start", principals: ["users"], reads: ["definition"] },
  ]),
  manifestTable(QUIETED, "UpgradeQuiet", [
    { name: "start", principals: ["users"], reads: ["definition"] },
  ]),
];

/**
 * The manifest after it: one entity narrowed, one entity gone, one entity left
 * without an action. The last two are what a loop over the CURRENT entities
 * cannot reach.
 */
const NEW_MANIFEST: ManifestRecordActionTable[] = [
  manifestTable(KEPT, "UpgradeKeep", [
    { name: "start", principals: ["users"], reads: ["definition"] },
  ]),
  manifestTable(QUIETED, "UpgradeQuiet", []),
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

const columnGrants = (conn: OpenShapeForgeDatabase, table: string) =>
  sql<{ column_name: string; privilege_type: string }>`
    select column_name, privilege_type from information_schema.column_privileges
     where grantee = ${RESOLVER_ROLE} and table_name = ${table}
     order by privilege_type, column_name
  `.execute(conn).then((result) =>
    result.rows.map((row) => `${row.privilege_type} ${row.column_name}`));

const tableGrants = (
  conn: OpenShapeForgeDatabase,
  table: string,
  grantee: string,
) =>
  sql<{ privilege_type: string }>`
    select privilege_type from information_schema.table_privileges
     where grantee = ${grantee} and table_name = ${table}
     order by privilege_type
  `.execute(conn).then((result) => result.rows.map((row) => row.privilege_type));

const resolverPolicies = (conn: OpenShapeForgeDatabase, table: string) =>
  sql<{ policyname: string }>`
    select policyname from pg_policies
     where schemaname = 'erp' and tablename = ${table} and ${RESOLVER_ROLE} = any(roles)
     order by policyname
  `.execute(conn).then((result) => result.rows.map((row) => row.policyname));

beforeAll(async () => {
  if (!/^[a-z0-9_]+$/.test(scratch) || !/^[a-z0-9_]+$/.test(migrateRole)) {
    throw new Error("unsafe scratch identifiers");
  }
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(
    `create role ${migrateRole} login password '${MIGRATE_PASSWORD}' ` +
      "nosuperuser nobypassrls nocreaterole nocreatedb",
  );
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
  await server?.unsafe(`drop role if exists ${migrateRole}`);
  await server?.close();
});

test("a new manifest takes back the grants of an entity it no longer declares", async () => {
  await migrate.db.connection().execute(async (conn) => {
    await runMigrationChain(conn);
    for (const table of TABLES) {
      await sql.raw(`
        create table erp.${table} (
          id uuid primary key,
          tenant_id uuid not null,
          secret text not null,
          definition text not null default 'graph',
          acl jsonb not null default '{}'::jsonb
        )
      `).execute(conn);
      await sql.raw(`alter table erp.${table} enable row level security`).execute(conn);
      await sql.raw(`alter table erp.${table} force row level security`).execute(conn);
      await sql.raw(`
        create policy ${table}_tenant_isolation on erp.${table}
        using (app.bypass_rls() or tenant_id = app.current_tenant())
        with check (app.bypass_rls() or tenant_id = app.current_tenant())
      `).execute(conn);
      // A THIRD party's grants on the same tables. The cleanup addresses the
      // resolver, so these must come through it untouched.
      await sql.raw(
        `grant select, insert, update, delete on erp.${table} to ${APP_ROLE}`,
      ).execute(conn);
    }

    // The old manifest, through the real derivation: three entities.
    const before = recordActionEntities(OLD_MANIFEST);
    expect(before.map((entity) => entity.entity))
      .toEqual(["UpgradeDrop", "UpgradeKeep", "UpgradeQuiet"]);
    await applyRecordActionsMigration(conn, before);
    expect(await columnGrants(conn, KEPT)).toEqual([
      "SELECT acl", "SELECT definition", "SELECT id", "SELECT secret", "SELECT tenant_id",
      "UPDATE acl",
    ]);
    for (const table of [DROPPED, QUIETED]) {
      expect(await columnGrants(conn, table)).toEqual([
        "SELECT acl", "SELECT definition", "SELECT id", "SELECT tenant_id", "UPDATE acl",
      ]);
      expect(await resolverPolicies(conn, table)).toEqual([
        `${table}_record_action_delete_fence`,
        `${table}_record_action_fence`,
        `${table}_record_action_lock`,
        `${table}_record_action_read`,
      ]);
    }

    // The new manifest. `UpgradeDrop` has no table entry at all and
    // `UpgradeQuiet` declares no action, so neither is a record-action entity.
    const after = recordActionEntities(NEW_MANIFEST);
    expect(after.map((entity) => entity.entity)).toEqual(["UpgradeKeep"]);
    await applyRecordActionsMigration(conn, after);

    // The still-declared entity: the loop visited it and `revoke all` took the
    // `secret` column SELECT with it. This is the case that needed no new work.
    expect(await columnGrants(conn, KEPT)).toEqual([
      "SELECT acl", "SELECT definition", "SELECT id", "SELECT tenant_id", "UPDATE acl",
    ]);

    // The two the loop cannot reach. Before this change they kept the column
    // SELECT, the ACL UPDATE and all four policies for ever.
    for (const table of [DROPPED, QUIETED]) {
      expect(await columnGrants(conn, table)).toEqual([]);
      expect(await tableGrants(conn, table, RESOLVER_ROLE)).toEqual([]);
      expect(await resolverPolicies(conn, table)).toEqual([]);
      // The generated tenant policy is not a record-action policy and stays.
      const remaining = await sql<{ policyname: string }>`
        select policyname from pg_policies
         where schemaname = 'erp' and tablename = ${table} order by policyname
      `.execute(conn);
      expect(remaining.rows.map((row) => row.policyname)).toEqual([`${table}_tenant_isolation`]);
      // And the third party's grants are exactly as they were.
      expect(await tableGrants(conn, table, APP_ROLE))
        .toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    }

    // The dropped entity is not answerable either: the rewritten body has no
    // branch for its name, so the lookup refuses rather than reading a table
    // it still holds a grant on.
    await sql`select set_config('app.tenant_id', ${randomUUID()}, false)`.execute(conn);
    const answer = await sql<{ dropped: boolean | null; quieted: boolean | null }>`
      select app.record_action_allows('UpgradeDrop', ${randomUUID()}, 'start') as dropped,
             app.record_action_allows('UpgradeQuiet', ${randomUUID()}, 'start') as quieted
    `.execute(conn);
    expect(answer.rows[0]).toEqual({ dropped: false, quieted: false });

    // Re-running the new manifest changes nothing: there is no stale grant
    // left to take back, and the cleanup must not churn on every migrate.
    await applyRecordActionsMigration(conn, after);
    expect(await columnGrants(conn, KEPT)).toEqual([
      "SELECT acl", "SELECT definition", "SELECT id", "SELECT tenant_id", "UPDATE acl",
    ]);
    expect(await columnGrants(conn, DROPPED)).toEqual([]);
  });
}, TEST_TIMEOUT);

/**
 * The cleanup reaches a table that was RENAMED after its grants were made.
 *
 * It drops policies by the name the catalog holds, not by one derived from the
 * table's current name, because a rename leaves `<old name>_record_action_*`
 * on `<new name>` and a derived name would miss all four.
 */
test("it drops the policies of a renamed table it no longer manages", async () => {
  await migrate.db.connection().execute(async (conn) => {
    await sql`
      create table erp.upgrade_renames (
        id uuid primary key, tenant_id uuid not null,
        definition text not null default 'graph', acl jsonb not null default '{}'::jsonb)
    `.execute(conn);
    await sql`alter table erp.upgrade_renames enable row level security`.execute(conn);
    await sql`alter table erp.upgrade_renames force row level security`.execute(conn);
    await sql`
      create policy upgrade_renames_tenant_isolation on erp.upgrade_renames
      using (app.bypass_rls() or tenant_id = app.current_tenant())
      with check (app.bypass_rls() or tenant_id = app.current_tenant())
    `.execute(conn);
    const declared = recordActionEntities([
      ...NEW_MANIFEST,
      manifestTable("upgrade_renames", "UpgradeRename", [
        { name: "start", principals: ["users"], reads: ["definition"] },
      ]),
    ]);
    await applyRecordActionsMigration(conn, declared);
    expect(await resolverPolicies(conn, "upgrade_renames")).toHaveLength(4);

    await sql`alter table erp.upgrade_renames rename to upgrade_renamed`.execute(conn);
    await applyRecordActionsMigration(conn, recordActionEntities(NEW_MANIFEST));
    expect(await columnGrants(conn, "upgrade_renamed")).toEqual([]);
    expect(await resolverPolicies(conn, "upgrade_renamed")).toEqual([]);
    await sql`drop table erp.upgrade_renamed`.execute(conn);
  });
}, TEST_TIMEOUT);
