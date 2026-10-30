// SPDX-License-Identifier: BUSL-1.1
import {test,expect} from 'bun:test';
import {SQL} from 'bun';
import {randomUUID} from 'node:crypto';
import {sql,type Kysely} from 'kysely';
import { versionedMigrations } from '../migrations/versioned/index.js';
import { applyVersionedMigrations, migrationFileChecksum } from '../migrations/versioned-runner.js';
import {createDatabaseRuntime} from '../connection.js';
import {upgradeTenantSettings} from '../migrations/versioned/0018_typed-tenant-settings.js';
import {upgradeLegacySealedTenantSettings} from '../migrations/versioned/0020_legacy-sealed-tenant-settings.js';
import {decryptSecret,encryptSecret,keyringFromEnv,type StoredSecret} from '@openshapeforge/plugin-runtime/secrets';
async function scratch(run:(db:Kysely<any>)=>Promise<void>){
 const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
 const name='typed_settings_'+randomUUID().replaceAll('-','');const admin=new SQL(adminUrl,{max:1});let runtime:ReturnType<typeof createDatabaseRuntime>|undefined;
 try{await admin.unsafe(`create database "${name}"`);const url=new URL(adminUrl);url.pathname='/'+name;runtime=createDatabaseRuntime({databaseUrl:url.toString(),maxConnections:1});
 await sql`create schema erp`.execute(runtime.db);
 await sql`create table erp.tenant_settings(id uuid primary key,tenant_id uuid not null,value_type text not null default 'string',value_text text,value_json jsonb,is_secret boolean not null default false,namespace text not null default 'fixture',key text not null default 'secret')`.execute(runtime.db);
 await sql`alter table erp.tenant_settings enable row level security`.execute(runtime.db);await sql`alter table erp.tenant_settings force row level security`.execute(runtime.db);
 await run(runtime.db);
 }finally{await runtime?.close();await admin.unsafe(`drop database if exists "${name}" with (force)`);await admin.close();}
}
test('released settings retain identities and values, seal secrets and restore RLS',async()=>scratch(async db=>{
 const tenant=randomUUID(),plain=randomUUID(),secret=randomUUID(),json=randomUUID();const original=process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;const keys='fixture:'+Buffer.alloc(32,19).toString('base64');
 try{process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=keys;
 await sql`insert into erp.tenant_settings(id,tenant_id,value_type,value_text,value_json,is_secret) values(${plain}::uuid,${tenant}::uuid,'string','plain',null,false),(${secret}::uuid,${tenant}::uuid,'string','private fixture',null,true),(${json}::uuid,${tenant}::uuid,'json',null,'{"enabled":true}'::jsonb,false)`.execute(db);
 await db.transaction().execute(upgradeLegacySealedTenantSettings);
 const rows=(await sql<{id:string;definition:{osfType:string};value:unknown}>`select id::text,definition,value from erp.tenant_settings`.execute(db)).rows;
 expect(rows.find(r=>r.id===plain)?.value).toBe('plain');expect(rows.find(r=>r.id===json)?.value).toEqual({enabled:true});const sealed=rows.find(r=>r.id===secret)!;
 expect(JSON.stringify(sealed.value)).not.toContain('private fixture');expect(decryptSecret(keyringFromEnv(keys)!,`${tenant}:erp.tenant_settings:${secret}`,'value',sealed.value as StoredSecret)).toBe('private fixture');
 const flags=(await sql<{enabled:boolean;forced:boolean}>`select relrowsecurity as enabled,relforcerowsecurity as forced from pg_class where oid='erp.tenant_settings'::regclass`.execute(db)).rows[0];expect(flags).toEqual({enabled:true,forced:true});
 await db.transaction().execute(upgradeLegacySealedTenantSettings);
 }finally{if(original===undefined)delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=original;}
}),30000);
test('unsupported legacy values abort without dropping columns, rows or RLS',async()=>scratch(async db=>{
 await sql`insert into erp.tenant_settings(id,tenant_id,value_type,value_text,value_json,is_secret) values(${randomUUID()}::uuid,${randomUUID()}::uuid,'json',null,'[1,"mixed"]'::jsonb,false)`.execute(db);
 await expect(db.transaction().execute(upgradeLegacySealedTenantSettings)).rejects.toThrow('explicit field definition');
 expect((await sql`select value_json from erp.tenant_settings`.execute(db)).rows).toEqual([{value_json:[1,'mixed']}]);
 expect((await sql<{enabled:boolean}>`select relrowsecurity as enabled from pg_class where oid='erp.tenant_settings'::regclass`.execute(db)).rows[0]?.enabled).toBe(true);
}),30000);

test('pending 0018 upgrades legacy sealed values atomically and preserves the historical checksum',async()=>scratch(async db=>{
 const original=process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS; const keys='fixture:'+Buffer.alloc(32,19).toString('base64');
 const tenant=randomUUID(), id=randomUUID();
 try {
  process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=keys; const ring=keyringFromEnv(keys)!;
  const sealed=encryptSecret(ring,JSON.stringify(['tenant-setting',tenant,'fixture','secret']),'value','synthetic-value');
  await sql`insert into erp.tenant_settings(id,tenant_id,value_type,value_text,value_json,is_secret) values(${id}::uuid,${tenant}::uuid,'string',null,${JSON.stringify({sealed})}::text::jsonb,true)`.execute(db);
  const plain=randomUUID();
  await sql`insert into erp.tenant_settings(id,tenant_id,value_type,value_text,value_json,is_secret) values(${plain}::uuid,${tenant}::uuid,'string','synthetic-plain',null,false)`.execute(db);
  const other: Array<{id:string;tenant:string;plaintext:string}> = [];
  for (let i=0;i<12;i++) {
   const item={id:randomUUID(),tenant:randomUUID(),plaintext:`synthetic-${i}`};
   const namespace=`fixture-${i}`, key=`key-${i}`;
   const encrypted=encryptSecret(ring,JSON.stringify(['tenant-setting',item.tenant,namespace,key]),'value',item.plaintext);
   await sql`insert into erp.tenant_settings(id,tenant_id,namespace,key,value_type,value_text,value_json,is_secret) values(${item.id}::uuid,${item.tenant}::uuid,${namespace},${key},'string',null,${JSON.stringify({sealed:encrypted})}::text::jsonb,true)`.execute(db);
   other.push(item);
  }
  await sql`create schema platform`.execute(db);
  await sql`create table platform.schema_migrations(version text primary key,checksum text not null,applied_at timestamptz not null default now(),applied_by text)`.execute(db);
  await sql`insert into platform.schema_migrations(version,checksum,applied_by) values('0001_generated_platform_schema','x','fixture')`.execute(db);
  const selected=versionedMigrations.filter(m=>m.version.startsWith('0018_')||m.version.startsWith('0020_'));
  expect((await applyVersionedMigrations(db,selected)).applied).toEqual(selected.map(m=>m.version));
  expect((await sql<{value:string}>`select value from erp.tenant_settings where id=${plain}::uuid`.execute(db)).rows[0]?.value).toBe('synthetic-plain');
  const row=(await sql<{value:StoredSecret}>`select value from erp.tenant_settings where id=${id}::uuid`.execute(db)).rows[0]!;
  expect(decryptSecret(ring,`${tenant}:erp.tenant_settings:${id}`,'value',row.value)).toBe('synthetic-value');
  for (const item of other) {
   const saved=(await sql<{value:StoredSecret}>`select value from erp.tenant_settings where id=${item.id}::uuid`.execute(db)).rows[0]!;
   expect(decryptSecret(ring,`${item.tenant}:erp.tenant_settings:${item.id}`,'value',saved.value)).toBe(item.plaintext);
  }
  expect(()=>decryptSecret(ring,`${randomUUID()}:erp.tenant_settings:${id}`,'value',row.value)).toThrow();
  const ledger=(await sql<{version:string;checksum:string}>`select version,checksum from platform.schema_migrations`.execute(db)).rows;
  expect(ledger.find(r=>r.version===selected[0]!.version)?.checksum).toBe(await migrationFileChecksum(selected[0]!));
  expect(ledger.find(r=>r.version===selected[1]!.version)?.checksum).toBe(await migrationFileChecksum(selected[1]!));
  expect((await applyVersionedMigrations(db,selected)).skipped).toEqual(selected.map(m=>m.version));
 } finally { if(original===undefined)delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=original; }
}),30000);

test('invalid legacy binding rolls back both data and compatibility ledger',async()=>scratch(async db=>{
 const original=process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS; const keys='fixture:'+Buffer.alloc(32,19).toString('base64');
 try {
  process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=keys;
  const sealed=encryptSecret(keyringFromEnv(keys)!,JSON.stringify(['tenant-setting',randomUUID(),'fixture','secret']),'value','synthetic-value');
  await sql`insert into erp.tenant_settings(id,tenant_id,value_type,value_text,value_json,is_secret) values(${randomUUID()}::uuid,${randomUUID()}::uuid,'string',null,${JSON.stringify({sealed})}::text::jsonb,true)`.execute(db);
  await sql`create schema platform`.execute(db);
  await sql`create table platform.schema_migrations(version text primary key,checksum text not null,applied_at timestamptz not null default now(),applied_by text)`.execute(db);
  await sql`insert into platform.schema_migrations(version,checksum,applied_by) values('0001_generated_platform_schema','x','fixture')`.execute(db);
  const selected=versionedMigrations.filter(m=>m.version.startsWith('0018_')||m.version.startsWith('0020_'));
  await expect(applyVersionedMigrations(db,selected)).rejects.toThrow('Could not authenticate');
  expect((await sql`select value_type from erp.tenant_settings`.execute(db)).rows).toHaveLength(1);
  expect((await sql`select version from platform.schema_migrations`.execute(db)).rows).toHaveLength(1);
  expect((await sql<{enabled:boolean;forced:boolean}>`select relrowsecurity as enabled,relforcerowsecurity as forced from pg_class where oid='erp.tenant_settings'::regclass`.execute(db)).rows[0]).toEqual({enabled:true,forced:true});
 } finally { if(original===undefined)delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=original; }
}),30000);

test('already applied 0018 retains its checksum and records compatibility without rewriting data',async()=>scratch(async db=>{
 await sql`insert into erp.tenant_settings(id,tenant_id,value_type,value_text,value_json,is_secret) values(${randomUUID()}::uuid,${randomUUID()}::uuid,'string','synthetic-plain',null,false)`.execute(db);
 await db.transaction().execute(upgradeTenantSettings);
 await sql`create schema platform`.execute(db);
 await sql`create table platform.schema_migrations(version text primary key,checksum text not null,applied_at timestamptz not null default now(),applied_by text)`.execute(db);
 await sql`insert into platform.schema_migrations(version,checksum,applied_by) values('0001_generated_platform_schema','x','fixture')`.execute(db);
 const selected=versionedMigrations.filter(m=>m.version.startsWith('0018_')||m.version.startsWith('0020_'));
 const checksum=await migrationFileChecksum(selected[0]!);
 await sql`insert into platform.schema_migrations(version,checksum,applied_by) values(${selected[0]!.version},${checksum},'fixture')`.execute(db);
 const result=await applyVersionedMigrations(db,selected);
 expect(result.skipped).toContain(selected[0]!.version);
 expect(result.applied).toContain(selected[1]!.version);
 expect((await sql<{value:string}>`select value from erp.tenant_settings`.execute(db)).rows[0]?.value).toBe('synthetic-plain');
 expect((await sql<{checksum:string}>`select checksum from platform.schema_migrations where version=${selected[0]!.version}`.execute(db)).rows[0]?.checksum).toBe(checksum);
}),30000);

test('sealed values fail closed when the keyring is absent or its key is unavailable',async()=>scratch(async db=>{
 const original=process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
 const oldKey='old:'+Buffer.alloc(32,20).toString('base64');
 const tenant=randomUUID();
 try {
  const sealed=encryptSecret(keyringFromEnv(oldKey)!,JSON.stringify(['tenant-setting',tenant,'fixture','secret']),'value','synthetic-value');
  await sql`insert into erp.tenant_settings(id,tenant_id,value_type,value_text,value_json,is_secret) values(${randomUUID()}::uuid,${tenant}::uuid,'string',null,${JSON.stringify({sealed})}::text::jsonb,true)`.execute(db);
  delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;
  await expect(db.transaction().execute(upgradeLegacySealedTenantSettings)).rejects.toThrow('Configure secure value storage');
  process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS='different:'+Buffer.alloc(32,21).toString('base64');
  await expect(db.transaction().execute(upgradeLegacySealedTenantSettings)).rejects.toThrow('encryption key is unavailable');
  expect((await sql`select value_type from erp.tenant_settings`.execute(db)).rows).toHaveLength(1);
 } finally { if(original===undefined)delete process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS;else process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS=original; }
}),30000);

test('pending 0018 refuses a mismatched compatibility checksum before transforming values',async()=>scratch(async db=>{
 await sql`insert into erp.tenant_settings(id,tenant_id,value_type,value_text,value_json,is_secret) values(${randomUUID()}::uuid,${randomUUID()}::uuid,'string','synthetic',null,false)`.execute(db);
 await sql`create schema platform`.execute(db);
 await sql`create table platform.schema_migrations(version text primary key,checksum text not null,applied_at timestamptz not null default now(),applied_by text)`.execute(db);
 await sql`insert into platform.schema_migrations(version,checksum,applied_by) values('0001_generated_platform_schema','x','fixture'),('0020_legacy-sealed-tenant-settings','incorrect','fixture')`.execute(db);
 const selected=versionedMigrations.filter(m=>m.version.startsWith('0018_')||m.version.startsWith('0020_'));
 await expect(applyVersionedMigrations(db,selected)).rejects.toThrow('compatibility checksum mismatch');
 expect((await sql<{value_text:string}>`select value_text from erp.tenant_settings`.execute(db)).rows[0]?.value_text).toBe('synthetic');
 expect((await sql`select version from platform.schema_migrations where version=${selected[0]!.version}`.execute(db)).rows).toHaveLength(0);
}),30000);
