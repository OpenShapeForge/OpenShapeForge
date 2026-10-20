// SPDX-License-Identifier: BUSL-1.1
import {test,expect} from 'bun:test';
import {SQL} from 'bun';
import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {createDatabaseRuntime} from '../db/connection.js';
import {runMigrationChain} from '../db/migration-chain.js';
import {ensureTenantOwnRelation,seedTenantOwnRelations} from './tenant-own-relation.js';
import {provisionTenant} from './provisioning.js';
import {fakeAdmin,fakeOrganizationScopes,fakeSpi} from '../db/__tests__/__fixtures__/control-keycloak-fakes.js';

const adminUrl=process.env.SCRATCH_ADMIN_DATABASE_URL!;
test('tenant creation and every-host seeds create or reuse exactly one own organization',async()=>{
 const name='tenant_own_'+randomUUID().replaceAll('-','').slice(0,12);
 const admin=new SQL(adminUrl,{max:1});let runtime:ReturnType<typeof createDatabaseRuntime>|undefined;
 try{
  await admin.unsafe(`create database "${name}"`);
  const url=new URL(adminUrl);url.pathname='/'+name;
  runtime=createDatabaseRuntime({databaseUrl:url.toString(),maxConnections:2});const db=runtime.db;
  await db.connection().execute(conn=>runMigrationChain(conn));
  const spi=fakeSpi();const deps={db,keycloak:spi,keycloakAdmin:fakeAdmin(spi),organizationScopes:fakeOrganizationScopes(),
    mcpResource:{origins:['http://127.0.0.1:3001'],clients:['codex']},tenantRealm:'openshapeforge',
    operator:{subject:randomUUID(),issuer:'https://example.test/control',username:'operator'}};
  const created=await provisionTenant(deps,{slug:'acme',name:'Acme'});
  await provisionTenant(deps,{slug:'acme',name:'Acme'});
  const org=await sql<{relation_id:string}>`select relation_id from platform.tenants where id=${created.tenant.id}`.execute(db);
  expect(org.rows[0]!.relation_id).toBeTruthy();
  const existing=randomUUID(),foreign=randomUUID();
  await sql`insert into platform.tenants(id,slug,name,status) values(${existing},'existing','Existing','active'),(${foreign},'foreign','Acme','active')`.execute(db);
  const reused=await sql<{id:string}>`insert into erp.relations(tenant_id,display_name,relation_type,status) values(${existing},'Existing','organization','active') returning id`.execute(db);
  await seedTenantOwnRelations(db);await seedTenantOwnRelations(db);
  const linked=await sql<{id:string;relation_id:string;tenant_id:string;display_name:string;relation_type:string}>`
   select t.id,t.relation_id,r.tenant_id,r.display_name,r.relation_type from platform.tenants t join erp.relations r on r.id=t.relation_id order by t.slug`.execute(db);
  expect(linked.rows).toHaveLength(3);
  expect(linked.rows.every(r=>r.id===r.tenant_id&&r.relation_type==='organization')).toBe(true);
  expect(linked.rows.find(r=>r.id===existing)!.relation_id).toBe(reused.rows[0]!.id);
  const counts=await sql<{count:number}>`select count(*)::int as count from erp.relations`.execute(db);expect(counts.rows[0]!.count).toBe(3);
  // Simultaneous retries serialize on the same tenant row.
  await sql`update platform.tenants set relation_id=null where id=${foreign}`.execute(db);
  await Promise.all([seedTenantOwnRelations(db),seedTenantOwnRelations(db)]);
  expect((await sql<{count:number}>`select count(*)::int as count from erp.relations`.execute(db)).rows[0]!.count).toBe(3);
 }finally{await runtime?.close();await admin.unsafe(`drop database if exists "${name}" with (force)`);await admin.close();}
},120000);
