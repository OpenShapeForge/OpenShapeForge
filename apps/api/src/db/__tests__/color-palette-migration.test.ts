// SPDX-License-Identifier: BUSL-1.1
import manifest from '../../generated/db/manifest.json' with {type:'json'};
import type {GeneratedCrudTable} from '../../operations/entity/types.js';
import {test,expect} from 'bun:test';
import {SQL} from 'bun';
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
  runtime=createDatabaseRuntime({databaseUrl:location.toString(),maxConnections:1});const db=runtime.db;
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
  const palette=await db.transaction().execute(trx=>readColorPalette(trx,actor));
  expect(palette.find(c=>c.reference===stored)?.value).toBe('#2457D6');
  const foreign=await db.transaction().execute(trx=>readColorPalette(trx,{...actor,tenantId:other}));
  expect(foreign.some(c=>c.reference===stored)).toBe(false);
  const table=getGeneratedCrudTables().find(t=>t.source?.authoringEntityName==='Project')!;const column=table.columns.find(c=>c.colorReference)!;
  await expect(db.transaction().execute(trx=>guardColorWrite(trx,{...actor,tenantId:other},table,new Map([[column,stored]])))).rejects.toThrow();
  await db.transaction().execute(trx=>guardColorWrite(trx,actor,table,new Map([[column,stored]])));
  await sql`update erp.tenant_settings set value=jsonb_set(value,'{colors,0,value}','"#112233"') where tenant_id=${tenant}::uuid`.execute(db);
  expect((await db.transaction().execute(trx=>readColorPalette(trx,actor))).find(c=>c.reference===stored)?.value).toBe('#112233');
  await sql`update erp.tenant_settings set value=jsonb_set(value,'{colors,0,active}','false') where tenant_id=${tenant}::uuid`.execute(db);
  await expect(db.transaction().execute(trx=>guardColorWrite(trx,actor,table,new Map([[column,stored]])))).rejects.toThrow();
  // Unchanged use of an archived color remains valid during an unrelated edit.
  await db.transaction().execute(trx=>guardColorWrite(trx,actor,table,new Map([[column,stored]]),{color:stored}));
  for(const target of colorReferenceTables) {
    const columns=target.columns.filter(c=>c.colorReference);
    if(!columns.length||target.table==='projects')continue;
    await sql`create schema if not exists ${sql.id(target.schema)}`.execute(db);
    await sql`create table if not exists ${sql.id(target.schema,target.table)} (id uuid primary key,tenant_id uuid not null,${sql.join(columns.map(c=>sql`${sql.id(c.name)} text`))})`.execute(db);
  }
  const settingTable=(manifest.tables as GeneratedCrudTable[]).find(t=>t.source?.authoringEntityName==='TenantSetting')!;
  const current=(await sql<Record<string,unknown>>`select * from erp.tenant_settings where tenant_id=${tenant}::uuid`.execute(db)).rows[0]!;
  const valueColumn=settingTable.columns.find(c=>c.name==='value')!;
  await expect(db.transaction().execute(trx=>guardColorWrite(trx,actor,settingTable,new Map([[valueColumn,{colors:[]}]]),current))).rejects.toThrow('still in use');
  await expect(db.transaction().execute(trx=>guardColorWrite(trx,actor,settingTable,new Map(),current,true))).rejects.toThrow('still in use');
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
