// SPDX-License-Identifier: BUSL-1.1
import manifest from '../../generated/db/manifest.json' with {type:'json'};
import type {GeneratedCrudTable} from '../../operations/entity/types.js';
import {test,expect} from 'bun:test';
import {SQL} from 'bun';
import type {Transaction} from 'kysely';
import type {DB} from '../../generated/db/types.js';
import {applyPublicColorPaletteMigration} from '../migrations/color-palette.js';
import {APP_ROLE} from '../migrations/app-role.js';
import {databaseRole} from '../database-roles.js';
import {WORKER_ROLE} from '../migrations/worker-role.js';
import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {parseTenantColors} from '@openshapeforge/operations';
import {createDatabaseRuntime} from '../connection.js';
import migration from '../migrations/versioned/0026_color-palette-references.js';
import {readColorPalette} from '../../operations/color-palette.js';
import {guardColorWrite,colorReferenceTables} from '../../operations/entity/color-references.js';
import {getGeneratedCrudTables} from '../../operations/entity/table-registry.js';

test('migrates existing colors without losing appearance; palette reads and writes stay tenant scoped',async()=>{
 const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
 const location=new URL(adminUrl);if(!['localhost','127.0.0.1'].includes(location.hostname)||location.pathname!='/postgres')throw Error('Local scratch admin required');
 const name='palette_'+randomUUID().replaceAll('-','');const admin=new SQL(adminUrl,{max:1});
 let runtime:ReturnType<typeof createDatabaseRuntime>|undefined;
 try{
  await admin.unsafe(`create database "${name}"`);location.pathname='/'+name;
  runtime=createDatabaseRuntime({databaseUrl:location.toString(),maxConnections:2});const db=runtime.db;
  await sql`create schema erp`.execute(db);
  await sql`create table erp.tenants(id uuid primary key)`.execute(db);
  await sql`create table erp.tenant_settings(id uuid primary key,tenant_id uuid not null,namespace text,key text,definition jsonb,value jsonb,description text)`.execute(db);
  await sql`create table erp.projects(id uuid primary key,tenant_id uuid not null,color text constraint projects_color_pattern_check check(color ~ '^#[0-9A-Fa-f]{6}$'))`.execute(db);
  const tenant=randomUUID(),other=randomUUID(),project=randomUUID();
  await sql`insert into erp.tenants values(${tenant}::uuid),(${other}::uuid)`.execute(db);
  await sql`insert into erp.projects values(${project}::uuid,${tenant}::uuid,'#2457D6')`.execute(db);
  await db.transaction().execute(trx=>migration.up(trx));
  const stored=(await sql<{color:string}>`select color from erp.projects`.execute(db)).rows[0]!.color;
  expect(stored).toBe('tenant:imported-2457d6');
  const actor={tenantId:tenant,userId:randomUUID(),roles:['Organization.All.ReadWrite'],groups:[]};
  // Exercise actual restricted API-role RLS, including a managed setting and a
  // hidden same-tenant reference. Admin is used only for fixture setup/inspection.
  await sql`create schema app; create schema platform;
    create function app.current_tenant() returns uuid language sql stable as $$select nullif(current_setting('app.tenant_id',true),'')::uuid$$;
    create function app.bypass_rls() returns boolean language sql stable as $$select coalesce(current_setting('app.bypass_rls',true),'')='true'$$;
    create table platform.system_bypass_audit(id uuid,actor_subject text,reason text,started_at timestamptz,ended_at timestamptz,succeeded boolean,tenant_id uuid);
  `.execute(db);
  await sql`grant usage on schema app,erp,platform to ${sql.id(APP_ROLE)}; grant execute on function app.current_tenant(),app.bypass_rls() to public;
    grant select on erp.tenant_settings,erp.projects to ${sql.id(APP_ROLE)};
    grant insert on platform.system_bypass_audit to ${sql.id(APP_ROLE)};
    alter table erp.tenant_settings enable row level security; alter table erp.tenant_settings force row level security;
    create policy tenant_scope on erp.tenant_settings using(tenant_id=app.current_tenant());
    create policy authorization_profile_scope on erp.tenant_settings as restrictive using(app.bypass_rls());
    alter table erp.projects enable row level security; alter table erp.projects force row level security;
    create policy tenant_scope on erp.projects using(tenant_id=app.current_tenant());
    create policy hidden_reference on erp.projects as restrictive using(app.bypass_rls());
  `.execute(db);
  await applyPublicColorPaletteMigration(db);
  await applyPublicColorPaletteMigration(db);
  await sql`alter policy authorization_profile_scope on erp.tenant_settings using(app.bypass_rls() or (current_user=${sql.lit(databaseRole('identityResolver').name)} and namespace='appearance' and key='colors'))`.execute(db);
  const scoped=<T>(work:(trx:Transaction<DB>)=>Promise<T>,tenantId=tenant)=>db.transaction().execute(async trx=>{
    await sql`set local role ${sql.id(APP_ROLE)}`.execute(trx);
    await sql`select set_config('app.tenant_id',${tenantId},true)`.execute(trx);
    return work(trx);
  });
  expect((await scoped(trx=>sql`select value from erp.tenant_settings`.execute(trx))).rows).toHaveLength(0);
  expect((await scoped(trx=>sql`select color from erp.projects`.execute(trx))).rows).toHaveLength(0);
  await expect(scoped(trx=>sql`select * from app.public_color_palette(${other}::uuid)`.execute(trx))).rejects.toThrow('matching tenant');
  expect((await sql<{allowed:boolean}>`select has_function_privilege(${WORKER_ROLE},'app.public_color_palette(uuid)','execute') as allowed`.execute(db)).rows[0]!.allowed).toBe(false);

  const resolver=databaseRole('identityResolver').name;
  expect((await sql<{login:boolean;create:boolean}>`select rolcanlogin as login,has_schema_privilege(${resolver},'app','CREATE') as create from pg_roles where rolname=${resolver}`.execute(db)).rows[0]).toEqual({login:false,create:false});
  expect((await sql`select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='app.public_color_palette(uuid)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'`.execute(db)).rows).toHaveLength(0);
  const palette=await scoped(trx=>readColorPalette(trx,actor));
  expect(palette.find(c=>c.reference===stored)?.value).toBe('#2457D6');
  const foreign=await scoped(trx=>readColorPalette(trx,{...actor,tenantId:other}),other);
  expect(foreign.some(c=>c.reference===stored)).toBe(false);
  const table=getGeneratedCrudTables().find(t=>t.source?.authoringEntityName==='Project')!;const column=table.columns.find(c=>c.colorReference)!;
  await expect(scoped(trx=>guardColorWrite(trx,{...actor,tenantId:other},table,new Map([[column,stored]])),other)).rejects.toThrow();
  await scoped(trx=>guardColorWrite(trx,actor,table,new Map([[column,stored]])));
  await sql`update erp.tenant_settings set value=jsonb_set(value,'{colors,0,value}','"#112233"') where tenant_id=${tenant}::uuid`.execute(db);
  expect((await scoped(trx=>readColorPalette(trx,actor))).find(c=>c.reference===stored)?.value).toBe('#112233');
  await sql`update erp.tenant_settings set value=jsonb_set(value,'{colors,0,active}','false') where tenant_id=${tenant}::uuid`.execute(db);
  await expect(scoped(trx=>guardColorWrite(trx,actor,table,new Map([[column,stored]])))).rejects.toThrow();
  // Unchanged use of an archived color remains valid during an unrelated edit.
  await scoped(trx=>guardColorWrite(trx,actor,table,new Map([[column,stored]]),{color:stored}));
  for(const target of colorReferenceTables) {
    const columns=target.columns.filter(c=>c.colorReference);
    if(!columns.length||target.table==='projects')continue;
    await sql`create schema if not exists ${sql.id(target.schema)}`.execute(db);
    await sql`create table if not exists ${sql.id(target.schema,target.table)} (id uuid primary key,tenant_id uuid not null,${sql.join(columns.map(c=>sql`${sql.id(c.name)} text`))})`.execute(db);
    await sql`alter table ${sql.id(target.schema,target.table)} add column if not exists tenant_id uuid`.execute(db);
    for(const column of columns)await sql`alter table ${sql.id(target.schema,target.table)} add column if not exists ${sql.id(column.name)} text`.execute(db);
    await sql`grant usage on schema ${sql.id(target.schema)} to ${sql.id(APP_ROLE)}; grant select on ${sql.id(target.schema,target.table)} to ${sql.id(APP_ROLE)}`.execute(db);
  }
  await sql`grant select on all tables in schema erp to ${sql.id(APP_ROLE)}`.execute(db);
  const settingTable=(manifest.tables as GeneratedCrudTable[]).find(t=>t.source?.authoringEntityName==='TenantSetting')!;
  const current=(await sql<Record<string,unknown>>`select * from erp.tenant_settings where tenant_id=${tenant}::uuid`.execute(db)).rows[0]!;
  const valueColumn=settingTable.columns.find(c=>c.name==='value')!;
  await expect(scoped(trx=>guardColorWrite(trx,actor,settingTable,new Map([[valueColumn,{colors:[]}]]),current))).rejects.toThrow('still in use');
  await expect(scoped(trx=>guardColorWrite(trx,actor,settingTable,new Map(),current,true))).rejects.toThrow('still in use');
  await scoped(async trx=>{
    await guardColorWrite(trx,actor,settingTable,new Map([[valueColumn,current.value]]),current);
    expect((await sql<{bypass:string}>`select current_setting('app.bypass_rls',true) as bypass`.execute(trx)).rows[0]!.bypass??'').toBe('');
    expect((await sql`select color from erp.projects`.execute(trx)).rows).toHaveLength(0);
  });
  expect((await sql`select id from platform.system_bypass_audit where tenant_id=${tenant}::uuid`.execute(db)).rows.length).toBeGreaterThan(0);
  // Both an assignment and a palette edit take the same tenant lock.
  for(const write of [
    (trx:Transaction<DB>)=>guardColorWrite(trx,actor,table,new Map([[column,'standard:blue']])),
    (trx:Transaction<DB>)=>guardColorWrite(trx,actor,settingTable,new Map([[valueColumn,current.value]]),current),
  ])await scoped(async trx=>{
    await write(trx);
    const acquired=await scoped(otherTrx=>sql<{locked:boolean}>`select pg_try_advisory_xact_lock(hashtextextended(${`colors:${tenant}`},0)) as locked`.execute(otherTrx));
    expect(acquired.rows[0]!.locked).toBe(false);
  });
  const duplicate=randomUUID();
  await sql`insert into erp.tenant_settings(id,tenant_id,namespace,key,definition,value) select ${duplicate}::uuid,tenant_id,namespace,key,definition,value from erp.tenant_settings where tenant_id=${tenant}::uuid`.execute(db);
  await expect(scoped(trx=>guardColorWrite(trx,actor,settingTable,new Map([[valueColumn,current.value]]),current))).rejects.toThrow('already has');
  await sql`delete from erp.tenant_settings where id=${duplicate}::uuid`.execute(db);
  await sql`update erp.tenant_settings set value=value||'{"credential":"must-not-leak"}'::jsonb where tenant_id=${tenant}::uuid`.execute(db);
  const publicRaw=await scoped(trx=>sql`select * from app.public_color_palette(${tenant}::uuid)`.execute(trx));
  expect(JSON.stringify(publicRaw.rows)).not.toContain('must-not-leak');
  await expect(scoped(trx=>readColorPalette(trx,actor))).rejects.toThrow('invalid');
  await sql`update erp.tenant_settings set value=value-'credential' where tenant_id=${tenant}::uuid`.execute(db);
  for(const field of ['key','name','value','active']){
    await sql`update erp.tenant_settings set value=jsonb_set(value,array['colors','0',${field}],'{"secret":"nested-must-not-leak"}'::jsonb) where tenant_id=${tenant}::uuid`.execute(db);
    const projection=await scoped(trx=>sql`select * from app.public_color_palette(${tenant}::uuid)`.execute(trx));
    expect(JSON.stringify(projection.rows)).not.toContain('nested-must-not-leak');
    await expect(scoped(trx=>readColorPalette(trx,actor))).rejects.toThrow('invalid');
    await sql`update erp.tenant_settings set value=${JSON.stringify(current.value)}::text::jsonb where tenant_id=${tenant}::uuid`.execute(db);
  }

  // A reference held exclusively by another tenant must not block this tenant.
  await sql`update erp.projects set tenant_id=${other}::uuid where id=${project}::uuid`.execute(db);
  await scoped(trx=>guardColorWrite(trx,actor,settingTable,new Map([[valueColumn,{colors:[]}]]),current));
  await db.transaction().execute(trx=>migration.up(trx));
  expect((await sql<{color:string}>`select color from erp.projects`.execute(db)).rows[0]!.color).toBe(stored);
 }finally{await runtime?.close();await admin.unsafe(`drop database if exists "${name}" with (force)`);await admin.close();}
},60000);

for(const count of [100,101])test(`palette size boundary ${count} preserves all colors or rolls back the migration`,async()=>{
 const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
 const location=new URL(adminUrl);if(!['localhost','127.0.0.1'].includes(location.hostname)||location.pathname!='/postgres')throw Error('Local scratch admin required');
 const name='palette_limit_'+randomUUID().replaceAll('-','');const admin=new SQL(adminUrl,{max:1});
 let runtime:ReturnType<typeof createDatabaseRuntime>|undefined;
 try{
  await admin.unsafe(`create database "${name}"`);location.pathname='/'+name;
  runtime=createDatabaseRuntime({databaseUrl:location.toString(),maxConnections:1});const db=runtime.db;
  await sql`create schema erp`.execute(db);
  await sql`create table erp.tenants(id uuid primary key)`.execute(db);
  await sql`create table erp.tenant_settings(id uuid primary key,tenant_id uuid not null,namespace text,key text,definition jsonb,value jsonb,description text)`.execute(db);
  await sql`create table erp.projects(id uuid primary key,tenant_id uuid not null,color text constraint projects_color_pattern_check check(color ~ '^#[0-9A-Fa-f]{6}$'))`.execute(db);
  const tenant=randomUUID();await sql`insert into erp.tenants values(${tenant}::uuid)`.execute(db);
  const colors=Array.from({length:count},(_,index)=>'#'+index.toString(16).padStart(6,'0'));
  await sql`insert into erp.projects(id,tenant_id,color) values ${sql.join(colors.map(color=>sql`(gen_random_uuid(),${tenant}::uuid,${color})`))}`.execute(db);
  const run=()=>db.transaction().execute(trx=>migration.up(trx));
  if(count===100){
   await run();
   const palette=(await sql<{value:unknown}>`select value from erp.tenant_settings where tenant_id=${tenant}::uuid`.execute(db)).rows[0]!.value;
   expect(parseTenantColors(palette)).toHaveLength(count);
   expect((await sql<{count:number}>`select count(*)::int as count from erp.projects where color like 'tenant:%'`.execute(db)).rows[0]!.count).toBe(count);
  }else{
   await expect(run()).rejects.toThrow('at most 100 colors');
   expect((await sql<{color:string}>`select color from erp.projects order by color`.execute(db)).rows.map(row=>row.color)).toEqual([...colors].sort());
   expect((await sql`select id from erp.tenant_settings`.execute(db)).rows).toHaveLength(0);
   // The DDL change rolls back with the data as one versioned migration.
   await expect(sql`insert into erp.projects values(gen_random_uuid(),${tenant}::uuid,'tenant:invalid')`.execute(db)).rejects.toThrow();
  }
 }finally{await runtime?.close();await admin.unsafe(`drop database if exists "${name}" with (force)`);await admin.close();}
},30000);
