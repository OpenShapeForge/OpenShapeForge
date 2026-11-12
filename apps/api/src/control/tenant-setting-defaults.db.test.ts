// SPDX-License-Identifier: BUSL-1.1
/** Self-owned PostgreSQL proof: the scratch database is always dropped; no shared reset or external identity calls. */
import { afterAll, beforeAll, test, expect } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabaseRuntime, type DatabaseRuntime } from '../db/connection.js';
import { withSystemSession, SYSTEM_BYPASS_ROLE } from '../db/session.js';
import { encryptSecret, keyringFromEnv } from '@openshapeforge/plugin-runtime/secrets';
import { applyPublicColorPaletteMigration } from '../db/migrations/color-palette.js';
import { databaseRole } from '../db/database-roles.js';
import { backfillTenantSettingDefaults, ensureTenantSettingDefaults, tenantSettingDefaultsOf } from './tenant-setting-defaults.js';

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@127.0.0.1:5434/postgres";
const databaseName = `tenant_defaults_${randomUUID().replaceAll('-', '')}`;
const migratorRole=databaseName+'_migrator';
const migratorPassword='scratch-'+randomUUID();
const resolver=databaseRole('identityResolver').name;
let admin: SQL | undefined;
let runtime: DatabaseRuntime | undefined;
beforeAll(async () => {
  const url = new URL(adminUrl);
  url.pathname = '/postgres';
  admin = new SQL(url.toString(), { max: 1 });
  await admin.unsafe(`create role "${migratorRole}" login password '${migratorPassword}' nosuperuser nocreaterole nocreatedb nobypassrls`);
  await admin.unsafe(`grant "${resolver}" to "${migratorRole}" with inherit true, set true`);
  await admin.unsafe(`create database "${databaseName}" owner "${migratorRole}"`);
  url.pathname = '/' + databaseName;
  url.username=migratorRole;url.password=migratorPassword;
  runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
  await sql.raw(`
    create schema app;
    create function app.current_tenant() returns uuid language sql stable as $$select nullif(current_setting('app.tenant_id',true),'')::uuid$$;
    create function app.bypass_rls() returns boolean language sql stable as $$select coalesce(current_setting('app.bypass_rls',true),'')='true'$$;
    create schema platform;
    create schema erp;
    create table platform.tenants(id uuid primary key,slug text,name text,status text);
    create table erp.tenants(id uuid primary key,tenant_id uuid,slug text,name text);
    create table platform.system_bypass_audit(
      id uuid primary key,actor_subject text,reason text,started_at timestamptz,
      ended_at timestamptz,succeeded boolean,tenant_id uuid
    );
    create table erp.tenant_settings(
      id uuid primary key,tenant_id uuid references erp.tenants(id),namespace text,key text,
      definition jsonb,value jsonb,description text,updated_at timestamptz default clock_timestamp()
    );
    create function erp.fixture_touch_updated_at() returns trigger language plpgsql as
      $$begin new.updated_at=clock_timestamp(); return new; end$$;
    create trigger fixture_updated_at before update on erp.tenant_settings
      for each row execute function erp.fixture_touch_updated_at();
    alter table erp.tenant_settings enable row level security;
    alter table erp.tenant_settings force row level security;
    create policy tenant_scope on erp.tenant_settings using(app.bypass_rls() or tenant_id=app.current_tenant()) with check(app.bypass_rls() or tenant_id=app.current_tenant());
  `).execute(runtime.db);
  await applyPublicColorPaletteMigration(runtime.db);
}, 30000);
afterAll(async () => {
  if (runtime) await runtime.close();
  if (admin) {
    try { await admin.unsafe(`drop database if exists "${databaseName}" with (force)`); }
    finally { await admin.unsafe(`drop role if exists "${migratorRole}"`); await admin.close(); }
  }
});
const rollback = new Error('ROLLBACK_DEFAULTS_FIXTURE');
test('new tenant defaults are isolated and replay preserves saved ciphertext, choices and versions', async () => {
  if (!runtime) throw new Error('Scratch database initialization required.');
  const ids = [randomUUID(), randomUUID()];
  const defaults = tenantSettingDefaultsOf([{ tenantSettingDefaults: [
    { namespace: 'example.provider', key: 'api-key', definition: { key: 'value', osfType: 'string', classification: { sensitivity: 'confidential' } } },
    { namespace: 'example.chat', key: 'configuration', definition: { key: 'value', osfType: 'object', children: [{ key: 'model', osfType: 'string' }] } },
  ] }]);
  let checked = false;
  try {
    await withSystemSession(runtime.db, { actorSubject: 'tenant-defaults-transaction-test', roles: [SYSTEM_BYPASS_ROLE], reason: 'Test missing tenant-variable defaults with rolled-back fixtures' }, async trx => {
      for (const id of ids) {
        const slug = `defaults-proof-${id}`;
        await sql`insert into platform.tenants(id,slug,name,status) values(${id}::uuid,${slug},'Defaults test','active')`.execute(trx);
        await sql`insert into erp.tenants(id,tenant_id,slug,name) values(${id}::uuid,${id}::uuid,${slug},'Defaults test')`.execute(trx);
        expect(await ensureTenantSettingDefaults(trx, id, defaults)).toBe(3);
      }
      const [first, second] = await Promise.all(ids.map(id => sql<{id:string;definition:Record<string,unknown>;value:unknown;updated_at:unknown;namespace:string;key:string}>`select id,definition,value,updated_at,namespace,key from erp.tenant_settings where tenant_id=${id}::uuid order by namespace,key`.execute(trx)));
      if (!first || !second) throw new Error("Both tenant fixtures are required.");
      expect(first.rows).toHaveLength(3); expect(second.rows).toHaveLength(3);
      expect([...first.rows,...second.rows].every(row => row.definition?.key === "value")).toBe(true);
      expect(first.rows.find(row => row.namespace === "appearance")!.value).toEqual({colors: []});
      expect(first.rows.map(row => row.id).some(id => second.rows.some(row => row.id === id))).toBe(false);
      const key = first.rows.find(row => row.key === 'api-key')!;
      const encrypted = encryptSecret(keyringFromEnv(`test:${Buffer.alloc(32,11).toString('base64')}`)!, `${ids[0]}:erp.tenant_settings:${key.id}`, 'value', 'synthetic-only');
      await sql`update erp.tenant_settings set value=${JSON.stringify(encrypted)}::text::jsonb where id=${key.id}::uuid`.execute(trx);
      await sql`update erp.tenant_settings set value='{"model":"saved-test-model"}'::jsonb where tenant_id=${ids[0]}::uuid and namespace='example.chat'`.execute(trx);
      expect((await sql<{value:unknown}>`select value from erp.tenant_settings where id=${key.id}::uuid`.execute(trx)).rows[0]!.value).toEqual(encrypted);
      const before = (await sql`select * from erp.tenant_settings where tenant_id=${ids[0]}::uuid order by namespace,key`.execute(trx)).rows;
      expect(await ensureTenantSettingDefaults(trx, ids[0]!, defaults)).toBe(0);
      expect((await sql`select * from erp.tenant_settings where tenant_id=${ids[0]}::uuid order by namespace,key`.execute(trx)).rows).toEqual(before);
      expect((await sql<{value:unknown}>`select value from erp.tenant_settings where tenant_id=${ids[1]}::uuid and namespace='example.provider'`.execute(trx)).rows[0]!.value).toBeNull();
      checked = true;
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  expect(checked).toBe(true);
}, 30000);

test('restricted owner/member replays populated-tenant defaults while the resolver remains palette fenced',async()=>{
  if(!runtime)throw Error('Scratch database initialization required.');
  const db=runtime.db,ids=[randomUUID(),randomUUID()];
  await sql`insert into erp.tenants(id,tenant_id,slug,name) values ${sql.join(ids.map(id=>sql`(${id}::uuid,${id}::uuid,${'replay-'+id},'Replay test')`))}`.execute(db);
  const modules=[{name:'fixture',tenantSettingDefaults:[{namespace:'example.replay',key:'model',definition:{key:'value',osfType:'string'},value:'initial-model'}]}];
  expect(await backfillTenantSettingDefaults(db,modules)).toEqual({tenants:2,inserted:4});
  const session={actorSubject:'defaults-replay-proof',roles:[SYSTEM_BYPASS_ROLE],reason:'Verify restricted owner replay without changing existing tenant values'};
  await withSystemSession(db,session,async trx=>{await sql`update erp.tenant_settings set value='"saved-model"'::jsonb where tenant_id=${ids[0]}::uuid and namespace='example.replay'`.execute(trx);});
  const before=await withSystemSession(db,session,trx=>sql`select * from erp.tenant_settings order by tenant_id,namespace,key`.execute(trx));
  expect(await backfillTenantSettingDefaults(db,modules)).toEqual({tenants:2,inserted:0});
  expect((await withSystemSession(db,session,trx=>sql`select * from erp.tenant_settings order by tenant_id,namespace,key`.execute(trx))).rows).toEqual(before.rows);
  await db.transaction().execute(async trx=>{
    await sql`set local role ${sql.id(resolver)}`.execute(trx);
    await sql`select set_config('app.tenant_id',${ids[0]!},true),set_config('app.bypass_rls','true',true)`.execute(trx);
    const visible=await sql<{tenant_id:string;namespace:string;key:string}>`select tenant_id,namespace,key from erp.tenant_settings`.execute(trx);
    expect(visible.rows).toEqual([{tenant_id:ids[0]!,namespace:'appearance',key:'colors'}]);
    expect((await sql<{owner:boolean}>`select pg_has_role(current_user,(select relowner from pg_class where oid='erp.tenant_settings'::regclass),'USAGE') as owner`.execute(trx)).rows[0]!.owner).toBe(false);
  });
},30000);
