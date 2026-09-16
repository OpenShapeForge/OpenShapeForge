// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import { applyAppRoleMigration, applyAppRoleGrants, APP_ROLE } from "../migrations/app-role.js";
import { applyAppHelpersMigration } from "../migrations/app-helpers.js";
import { applyBlueprintsMigration, applyBlueprintsGrants } from "../migrations/blueprints.js";
import { applyGeneratedTables } from "./__fixtures__/generated-tables.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

// A purpose-built scratch schema exercises the actual policies and definer as
// the restricted runtime role, without migrating any shared development data.
test("published blueprint lookup is scoped, authorized and read-only across tenants", async () => {
  const name = `blueprints_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const server = new SQL(adminUrl, { max: 1 });
  await server.unsafe(`create database "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
  const appUrl = new URL(url);
  appUrl.username = APP_ROLE;
  appUrl.password = "openshapeforge_app";
  const appRuntime = createDatabaseRuntime({ databaseUrl: appUrl.toString(), maxConnections: 1 });
  const bp = randomUUID(), customer = randomUUID(), stranger = randomUUID();
  try {
    await applyAppRoleMigration(runtime.db);
    await applyAppHelpersMigration(runtime.db);
    await sql`
      create schema platform;
      create table platform.tenants (id uuid primary key);
      create schema erp;
      create table erp.tenants (tenant_id uuid primary key, tenant_kind text not null);
    `.execute(runtime.db);
    await sql`insert into platform.tenants values (${bp}), (${customer}), (${stranger})`.execute(runtime.db);
    await sql`insert into erp.tenants values (${bp}, 'blueprint'), (${customer}, 'customer'), (${stranger}, 'customer');
    `.execute(runtime.db);
    // The three tables come from the manifest; the migration file owns only
    // their checks, policies and the definer function. Applied twice below to
    // prove that file idempotent.
    await applyGeneratedTables(runtime.db, [
      "platform.blueprint_libraries",
      "platform.blueprint_versions",
      "platform.blueprint_copies",
    ]);
    await applyBlueprintsMigration(runtime.db);
    await applyAppRoleGrants(runtime.db);
    await applyBlueprintsGrants(runtime.db);
    await applyBlueprintsMigration(runtime.db);
    await sql`insert into platform.blueprint_libraries values (${customer}, ${bp})`.execute(runtime.db);

    async function asApp<T>(tenant: string, roles: string, action: (db: typeof runtime.db) => Promise<T>, actor: string = randomUUID()) {
      return appRuntime.db.transaction().execute(async (trx) => {
        await sql`set local role ${sql.id(APP_ROLE)}`.execute(trx);
        await sql`select set_config('app.tenant_id', ${tenant}, true),
          set_config('app.user_id', ${actor}, true), set_config('app.roles', ${roles}, true)`.execute(trx);
        const identity = await sql<{ name: string; bypass: boolean }>`select current_user as name, rolbypassrls as bypass from pg_roles where rolname = current_user`.execute(trx);
        expect(identity.rows[0]).toEqual({ name: APP_ROLE, bypass: false });
        return action(trx);
      });
    }
    const publish = (db: typeof runtime.db, version: number) => sql`
      insert into platform.blueprint_versions
        (tenant_id, entity_name, blueprint_id, version, source_record_id, label, reader_roles, values_json)
      values (${bp}, 'Example', 'standard', ${version}, ${randomUUID()}, ${`Standard ${version}`},
        array['Example.All.ReadWrite'], '{"label":"published"}'::jsonb)
    `.execute(db);
    const read = (db: typeof runtime.db) => sql<{ version: number }>`select * from app.read_blueprints('Example', null, null, 20, 0)`.execute(db);

    await asApp(bp, 'platform-operator', (db) => publish(db, 1));
    await asApp(bp, 'platform-operator', (db) => publish(db, 2));
    expect((await asApp(customer, 'Example.All.ReadWrite', read)).rows.map((r) => r.version)).toEqual([2]);
    expect((await asApp(stranger, 'Example.All.ReadWrite', read)).rows).toEqual([]);
    expect((await asApp(customer, 'Other.All.ReadWrite', read)).rows).toEqual([]);
    expect((await asApp(customer, '', read)).rows).toEqual([]);
    expect((await asApp(customer, 'Example.All.ReadWrite', read, '')).rows).toEqual([]);
    expect((await asApp(customer, 'Example.All.ReadWrite', (db) => sql`select * from platform.blueprint_versions`.execute(db))).rows).toEqual([]);
    await expect(asApp(customer, 'platform-operator', (db) => publish(db, 3))).rejects.toThrow();
    await expect(asApp(bp, 'Example.All.ReadWrite', (db) => publish(db, 3))).rejects.toThrow();
    await expect(asApp(bp, 'platform-operator', (db) => sql`delete from platform.blueprint_versions`.execute(db))).rejects.toThrow();
    await expect(asApp(bp, 'platform-operator', (db) => sql`update platform.blueprint_versions set label = 'changed'`.execute(db))).rejects.toThrow();
    // The library assignment is registry state: a tenant session, whatever its
    // roles, cannot reach the row (RLS filters it, so the update touches nothing),
    // while the audited control-plane bypass can.
    expect((await asApp(customer, 'platform-operator', (db) => sql`update platform.blueprint_libraries set blueprint_tenant_id = ${stranger}`.execute(db))).numAffectedRows).toBe(0n);
    expect((await asApp(customer, 'platform-operator', (db) => sql`delete from platform.blueprint_libraries`.execute(db))).numAffectedRows).toBe(0n);
    await expect(asApp(customer, 'platform-operator', (db) => sql`insert into platform.blueprint_libraries values (${stranger}, ${bp})`.execute(db))).rejects.toThrow();
    expect((await asApp(customer, 'platform-operator', async (db) => {
      await sql`select set_config('app.bypass_rls', 'true', true)`.execute(db);
      return sql`update platform.blueprint_libraries set blueprint_tenant_id = ${bp} where tenant_id = ${customer}`.execute(db);
    })).numAffectedRows).toBe(1n);
    await asApp(customer, 'Example.All.ReadWrite', (db) => sql`
      insert into platform.blueprint_copies values (${customer}, 'Example', ${randomUUID()}, ${bp}, 'standard', 2)
    `.execute(db));
    await expect(asApp(stranger, 'Example.All.ReadWrite', (db) => sql`
      insert into platform.blueprint_copies values (${stranger}, 'Example', ${randomUUID()}, ${bp}, 'standard', 2)
    `.execute(db))).rejects.toThrow();
    await expect(asApp(customer, 'Example.All.ReadWrite', (db) => sql`set local role openshapeforge_blueprint_reader`.execute(db))).rejects.toThrow();
    // A changed reader policy on the latest version cannot fall back to an
    // older publication that happened to allow the caller's role.
    await asApp(bp, 'platform-operator', (db) => sql`
      insert into platform.blueprint_versions
        (tenant_id, entity_name, blueprint_id, version, source_record_id, label, reader_roles, values_json)
      values (${bp}, 'Example', 'standard', 3, ${randomUUID()}, 'Restricted standard',
        array['Other.All.ReadWrite'], '{}'::jsonb)
    `.execute(db));
    expect((await asApp(customer, 'Example.All.ReadWrite', read)).rows).toEqual([]);
    expect((await asApp(customer, 'Other.All.ReadWrite', read)).rows.map((r) => r.version)).toEqual([3]);
    const owner = await sql<{ owner: string; bypass: boolean; public_execute: boolean }>`
      select r.rolname as owner, r.rolbypassrls as bypass,
        exists(select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
      from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.oid = 'app.read_blueprints(text,text,text,integer,integer)'::regprocedure
    `.execute(runtime.db);
    expect(owner.rows[0]).toEqual({ owner: 'openshapeforge_blueprint_reader', bypass: false, public_execute: false });
  } finally {
    await appRuntime.close();
    await runtime.close();
    await server.unsafe(`drop database if exists "${name}" with (force)`);
    await server.close();
  }
}, 120_000);
