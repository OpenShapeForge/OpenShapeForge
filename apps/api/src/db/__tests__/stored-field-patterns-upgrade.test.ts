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
import {generatedRuntimeFieldSchemas} from '../../modules/field-schemas.js';
const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL??'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
const name='field_pattern_upgrade_'+randomUUID().replaceAll('-','');
const first=randomUUID(),second=randomUUID(),record=randomUUID(),frozen=randomUUID();
const version='0025_check-stored-field-patterns';
let admin:SQL,runtime:ReturnType<typeof createDatabaseRuntime>;
const legacyPattern='^(?=.*[A-Z]).{8,}$';
const unrelated={key:'business',osfType:'string',validation:{pattern:legacyPattern}};
const valid=[{key:'code',osfType:'string',validation:{pattern:'^[A-Z]+$'},defaultValue:unrelated}];
const old=[{key:'group',osfType:'object',shape:[{key:'code',osfType:'string',validation:{pattern:legacyPattern}}]}];
const snapshot={parameters:old};
async function payload(){return (await sql<{parameters:unknown}>`select parameters from erp.templates where id=${record}::uuid`.execute(runtime.db)).rows[0]!.parameters;}
beforeAll(async()=>{
 admin=new SQL(adminUrl);await admin.unsafe(`create database "${name}"`);
 const url=new URL(adminUrl);url.pathname='/'+name;
 runtime=createDatabaseRuntime({databaseUrl:url.href,maxConnections:2});
 await provisionDatabaseRoles(runtime.db,{passwords:{app:'openshapeforge_app',worker:'openshapeforge_worker'}});
 await runtime.db.connection().execute(db=>runMigrationChain(db,{versioned:versionedMigrations.filter(m=>m.version!==version)}));
 await sql`insert into platform.tenants(id,slug,name,status) values(${first}::uuid,${'first-'+name},'First','active'),(${second}::uuid,${'second-'+name},'Second','active')`.execute(runtime.db);
 await sql`insert into erp.templates(id,tenant_id,key,name,parameters) values(${record}::uuid,${second}::uuid,'pattern-proof','Pattern proof',${JSON.stringify(valid)}::text::jsonb)`.execute(runtime.db);
 await sql`create policy pattern_upgrade_tenant_fence on erp.templates as restrictive using(tenant_id=app.current_tenant());
  create schema pattern_fixture;
  create table pattern_fixture.business(payload jsonb);
  grant usage on schema pattern_fixture to openshapeforge_app;
  grant select on pattern_fixture.business to openshapeforge_app`.execute(runtime.db);
 await sql`insert into pattern_fixture.business values(${JSON.stringify({validation:{pattern:legacyPattern}})}::text::jsonb)`.execute(runtime.db);
 await sql`insert into erp.template_versions(id,tenant_id,template_id,version_number,snapshot,content_hash,published_by,published_at)
  values(${frozen}::uuid,${second}::uuid,${record}::uuid,1,${JSON.stringify(snapshot)}::text::jsonb,repeat('a',64),${randomUUID()}::uuid,now())`.execute(runtime.db);
 // Enforce the published-version immutability contract in this carry-forward fixture.
 await sql`create function pattern_fixture.frozen() returns trigger language plpgsql as $$begin raise exception 'Published snapshot is immutable';end$$;
  create trigger pattern_frozen before update or delete on erp.template_versions for each row execute function pattern_fixture.frozen()`.execute(runtime.db);
},120000);
afterAll(async()=>{await runtime?.close();if(admin){await admin.unsafe(`drop database if exists "${name}" with(force)`);await admin.close();}});
test('only canonical field positions are checked across tenants; arbitrary JSON and immutable snapshots survive',async()=>{
 await runtime.db.transaction().execute(async trx=>{
  await sql`set local role openshapeforge_app`.execute(trx);
  await sql`select set_config('app.tenant_id',${first},true),set_config('app.bypass_rls','false',true)`.execute(trx);
  await checkStoredFieldPatterns(trx);
  const {rows:[context]}=await sql<{tenant:string;bypass:string}>`select current_setting('app.tenant_id') as tenant,current_setting('app.bypass_rls') as bypass`.execute(trx);
  expect(context).toEqual({tenant:first,bypass:'false'});
 });
 expect(await payload()).toEqual(valid);
 await expect(sql`update erp.template_versions set snapshot='{}'::jsonb where id=${frozen}::uuid`.execute(runtime.db)).rejects.toThrow('immutable');
});
test('an incompatible nested editable definition stops the upgrade; correction carries immutable history forward',async()=>{
 expect(()=>new RegExp(legacyPattern)).not.toThrow();
 await sql`update erp.templates set parameters=${JSON.stringify(old)}::text::jsonb where id=${record}::uuid`.execute(runtime.db);
 await runtime.db.transaction().execute(async trx=>{
  await sql`set local role openshapeforge_app`.execute(trx);
  await sql`select set_config('app.tenant_id',${first},true),set_config('app.bypass_rls','false',true)`.execute(trx);
  await expect(checkStoredFieldPatterns(trx)).rejects.toThrow('Stored FieldDefinition validation pattern is unsupported');
  const {rows:[context]}=await sql<{tenant:string;bypass:string}>`select current_setting('app.tenant_id') as tenant,current_setting('app.bypass_rls') as bypass`.execute(trx);
  expect(context).toEqual({tenant:first,bypass:'false'});
 });
 await expect(runtime.db.connection().execute(db=>runMigrationChain(db))).rejects.toThrow('correct the editable definition before upgrading');
 expect(await payload()).toEqual(old);
 expect((await sql`select 1 from platform.schema_migrations where version=${version}`.execute(runtime.db)).rows).toHaveLength(0);
 await sql`update erp.templates set parameters=${JSON.stringify(valid)}::text::jsonb where id=${record}::uuid`.execute(runtime.db);
 const upgraded=await runtime.db.connection().execute(db=>runMigrationChain(db));
 expect(upgraded.versioned.applied).toContain(version);
 expect(await payload()).toEqual(valid);
 expect((await sql<{snapshot:unknown}>`select snapshot from erp.template_versions where id=${frozen}::uuid`.execute(runtime.db)).rows[0]!.snapshot).toEqual(snapshot);
 expect(generatedRuntimeFieldSchemas.validateObject(old,{})).toMatchObject({valid:false,error:{code:'INVALID_DEFINITION'}});
 const replay=await runtime.db.connection().execute(db=>runMigrationChain(db));
 expect(replay.versioned.skipped).toContain(version);
},120000);
