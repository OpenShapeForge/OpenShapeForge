// SPDX-License-Identifier: BUSL-1.1
import {afterAll,beforeAll,expect,test} from 'bun:test';
import {SQL} from 'bun';
import {sql} from 'kysely';
import {randomUUID} from 'node:crypto';
import {createDatabaseRuntime} from '../connection.js';
import {provisionDatabaseRoles} from '../database-roles.js';
import {runMigrationChain} from '../migration-chain.js';
import {versionedMigrations} from '../migrations/versioned/index.js';
import {checkStoredFieldPatterns} from '../migrations/versioned/0025_check-stored-field-patterns.js';
const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
const name='field_pattern_upgrade_'+randomUUID().replaceAll('-','');
const first=randomUUID(),second=randomUUID(),record=randomUUID();
const version='0025_check-stored-field-patterns';
let admin:SQL,runtime:ReturnType<typeof createDatabaseRuntime>;
const valid={fields:[{key:'code',osfType:'string',validation:{pattern:'^[A-Z]+$'}}],business:{pattern:'*.pdf'}};
const old={fields:[{key:'code',osfType:'string',validation:{pattern:'^(?=.*[A-Z]).{8,}$'}}]};
beforeAll(async()=>{
 admin=new SQL(adminUrl);await admin.unsafe(`create database "${name}"`);
 const url=new URL(adminUrl);url.pathname='/'+name;
 runtime=createDatabaseRuntime({databaseUrl:url.href,maxConnections:2});
 await provisionDatabaseRoles(runtime.db,{passwords:{app:'openshapeforge_app',worker:'openshapeforge_worker'}});
 await runtime.db.connection().execute(db=>runMigrationChain(db,{versioned:versionedMigrations.filter(m=>m.version!==version)}));
 await sql`insert into platform.tenants(id,slug,name,status) values(${first}::uuid,${'first-'+name},'First','active'),(${second}::uuid,${'second-'+name},'Second','active')`.execute(runtime.db);
 await sql`create schema pattern_fixture;
  create table pattern_fixture.definitions(id uuid primary key,tenant_id uuid not null,payload jsonb not null);
  alter table pattern_fixture.definitions enable row level security;
  alter table pattern_fixture.definitions force row level security;
  create policy tenant_base on pattern_fixture.definitions using(app.bypass_rls() or tenant_id=app.current_tenant());
  create policy tenant_fence on pattern_fixture.definitions as restrictive using(tenant_id=app.current_tenant());
  grant usage on schema pattern_fixture to openshapeforge_app;
  grant select on pattern_fixture.definitions to openshapeforge_app;`.execute(runtime.db);
 await sql`insert into pattern_fixture.definitions values(${record}::uuid,${second}::uuid,${JSON.stringify(valid)}::text::jsonb)`.execute(runtime.db);
},120000);
afterAll(async()=>{await runtime?.close();if(admin){await admin.unsafe(`drop database if exists "${name}" with(force)`);await admin.close();}});
test('a compatible stored field carries forward without touching unrelated business patterns or context',async()=>{
 await runtime.db.transaction().execute(async trx=>{
  await sql`set local role openshapeforge_app`.execute(trx);
  await sql`select set_config('app.tenant_id',${first},true),set_config('app.bypass_rls','false',true)`.execute(trx);
  await checkStoredFieldPatterns(trx);
  const {rows:[context]}=await sql<{tenant:string;bypass:string}>`select current_setting('app.tenant_id') as tenant,current_setting('app.bypass_rls') as bypass`.execute(trx);
  expect(context).toEqual({tenant:first,bypass:'false'});
 });
 expect((await sql<{payload:unknown}>`select payload from pattern_fixture.definitions where id=${record}::uuid`.execute(runtime.db)).rows[0]!.payload).toEqual(valid);
});
test('an old native-RegExp pattern blocks upgrade without data loss and an explicit correction permits it',async()=>{
 expect(()=>new RegExp(old.fields[0]!.validation.pattern)).not.toThrow();
 await sql`update pattern_fixture.definitions set payload=${JSON.stringify(old)}::text::jsonb where id=${record}::uuid`.execute(runtime.db);
 await runtime.db.transaction().execute(async trx=>{
  await sql`set local role openshapeforge_app`.execute(trx);
  await sql`select set_config('app.tenant_id',${first},true),set_config('app.bypass_rls','false',true)`.execute(trx);
  await expect(checkStoredFieldPatterns(trx)).rejects.toThrow('Stored FieldDefinition validation pattern is unsupported');
  const {rows:[context]}=await sql<{tenant:string;bypass:string}>`select current_setting('app.tenant_id') as tenant,current_setting('app.bypass_rls') as bypass`.execute(trx);
  expect(context).toEqual({tenant:first,bypass:'false'});
 });
 await expect(runtime.db.connection().execute(db=>runMigrationChain(db))).rejects.toThrow('correct the definition before upgrading');
 expect((await sql<{payload:unknown}>`select payload from pattern_fixture.definitions where id=${record}::uuid`.execute(runtime.db)).rows[0]!.payload).toEqual(old);
 expect((await sql`select 1 from platform.schema_migrations where version=${version}`.execute(runtime.db)).rows).toHaveLength(0);
 await sql`update pattern_fixture.definitions set payload=${JSON.stringify(valid)}::text::jsonb where id=${record}::uuid`.execute(runtime.db);
 const upgraded=await runtime.db.connection().execute(db=>runMigrationChain(db));
 expect(upgraded.versioned.applied).toContain(version);
 expect((await sql<{payload:unknown}>`select payload from pattern_fixture.definitions where id=${record}::uuid`.execute(runtime.db)).rows[0]!.payload).toEqual(valid);
 const replay=await runtime.db.connection().execute(db=>runMigrationChain(db));
 expect(replay.versioned.skipped).toContain(version);
},120000);
