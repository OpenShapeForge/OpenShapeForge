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
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { DATABASE_ROLES, databaseRole } from "../database-roles.js";
import { applyRecordActionsMigration } from "../migrations/record-actions.js";
import { APP_ROLE } from "../migrations/app-role.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 240_000;
const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const scratch = `record_actions_restricted_${suffix}`;
const migrateRole = `osf_restricted_migrate_${suffix}`;
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

    const policies = await sql<{ policyname: string; cmd: string; withcheck: string | null }>`
      select policyname, cmd, with_check as withcheck
        from pg_policies
       where schemaname = 'erp' and tablename = 'restricted_runs'
         and ${RESOLVER_ROLE} = any(roles)
       order by policyname
    `.execute(conn);
    expect(policies.rows).toEqual([
      { policyname: "restricted_runs_record_action_lock", cmd: "UPDATE", withcheck: "false" },
      { policyname: "restricted_runs_record_action_read", cmd: "SELECT", withcheck: null },
    ]);

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
