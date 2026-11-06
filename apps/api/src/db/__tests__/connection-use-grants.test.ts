// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createDatabaseRuntime } from '../connection.js';
import { runMigrationChain } from '../migration-chain.js';
import { provisionDatabaseRoles } from '../database-roles.js';
const url = process.env.SCRATCH_ADMIN_DATABASE_URL ?? 'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
const suffix = crypto.randomUUID().replaceAll('-', '');
const database = `connection_grants_${suffix}`, role = "openshapeforge_app";
const tenant = crypto.randomUUID(), foreignTenant = crypto.randomUUID(), owner = crypto.randomUUID(), actor = crypto.randomUUID(), service = crypto.randomUUID();
const identity = crypto.randomUUID(), adapter = crypto.randomUUID();
const connection = crypto.randomUUID(), grant = crypto.randomUUID(), subject = crypto.randomUUID();
let admin: SQL, db: SQL;
describe('owner-issued connection use grants', () => {
  beforeAll(async () => {
    admin = new SQL(url!); await admin.unsafe(`create database "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`; db = new SQL(target.href);
    const runtime=createDatabaseRuntime({databaseUrl:target.href,maxConnections:2});
    try {
      await provisionDatabaseRoles(runtime.db,{passwords:{app:'openshapeforge_app',worker:'openshapeforge_worker'}});
      await runtime.db.connection().execute(conn=>runMigrationChain(conn));
    } finally {await runtime.close();}
    // Standalone core has no host-owned Integration entity. Hubble's generated
    // schema does; use its real table and policy when composed with that host.
    const exists=(await db`select to_regclass('integration.connections') as name`)[0].name;
    if(!exists) await db.unsafe(`create schema integration;
      create table integration.adapters(id uuid primary key,tenant_id uuid,key text,name text,description text,transport text);
      create table integration.connections(id uuid primary key,tenant_id uuid not null,owner_user_id uuid,adapter_id uuid,key text,name text,configuration_values jsonb);
      alter table integration.connections enable row level security; alter table integration.connections force row level security;
      create policy connections_scope on integration.connections using(app.bypass_rls() or (tenant_id=app.current_tenant() and (owner_user_id is null or owner_user_id=app.current_relation_id())));`);
    await db.unsafe(`grant usage on schema app,platform,integration,erp to "${role}";
      grant select on all tables in schema platform,erp,integration to "${role}";
      grant insert,update,delete on platform.connection_use_grants,integration.connections to "${role}";
      grant execute on all functions in schema app to "${role}";`);
    await db`insert into platform.tenants(id,slug,name,status) values(${tenant}::uuid,${'grant-'+suffix},'Grant test','active'),(${foreignTenant}::uuid,${'foreign-'+suffix},'Foreign','active')`;
    await db`insert into erp.relations(id,tenant_id,display_name,relation_type,status) values(${owner}::uuid,${tenant}::uuid,'Owner','person','active'),(${service}::uuid,${tenant}::uuid,'Other','person','active')`;
    await db`insert into platform.identities(id,issuer,subject) values(${identity}::uuid,'https://identity.example.test',${actor})`;
    await db`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,linked_at,linked_by) values(${identity}::uuid,${tenant}::uuid,${owner}::uuid,'linked',now(),'jit')`;
    await db`insert into integration.adapters(id,tenant_id,key,name,description,transport) values(${adapter}::uuid,${tenant}::uuid,'test','Test','Test','rest')`;
    await db`insert into integration.connections(id,tenant_id,owner_user_id,adapter_id,key,name,configuration_values) values(${connection}::uuid,${tenant}::uuid,${owner}::uuid,${adapter}::uuid,'test','Test','{"accessToken":"ciphertext-fixture"}'::jsonb)`;
  },120_000);
  afterAll(async () => { await db?.close(); if (admin) { await admin.unsafe(`drop database "${database}" with(force)`); await admin.close(); } });
  async function as<T>(person: string, user: string, organization: string, operation: string, run: (tx: SQL) => Promise<T>) {
    return db.begin(async tx => {
      await tx.unsafe(`set local role "${role}"`);
      await tx`select set_config('app.tenant_id',${organization},true),set_config('app.relation_id',${person},true),set_config('app.user_id',${user},true),set_config('app.audit_operation',${operation},true)`;
      return run(tx);
    });
  }
  async function issue(tx: SQL, id = grant, ownerId = owner) {
    await tx`insert into platform.connection_use_grants(id,tenant_id,connection_table,values_column,connection_id,owner_relation_id,consumer_operation,subject_entity,subject_id,service_definition,definition_fingerprint,input_schema,issued_by,issued_identity_id)
      values(${id}::uuid,${tenant}::uuid,'integration.connections','configuration_values',${connection}::uuid,${ownerId}::uuid,'calendar.availability','Calendar',${subject}::uuid,${JSON.stringify({id:adapter})}::text::jsonb,${'a'.repeat(64)},'{}'::jsonb,${actor}::uuid,${identity}::uuid)`;
  }
  test('only the owner can issue; scope cannot be widened after issue', async () => {
    await as(owner,actor,tenant,'calendar.consent',tx => issue(tx));
    await expect(as(service,actor,tenant,'calendar.consent',tx => issue(tx,crypto.randomUUID()))).rejects.toThrow('row-level security');
    await expect(as(owner,actor,tenant,'calendar.consent',async tx => { await tx`update platform.connection_use_grants set consumer_operation='mail.send' where id=${grant}::uuid`; })).rejects.toThrow('scope is immutable');
  });
  test('service sees only the approved row through the exact operation and bypass is restored', async () => {
    await as(service,service,tenant,'calendar.availability',async tx => {
      expect(await tx`select * from integration.connections`).toHaveLength(0);
      const [result] = await tx`select app.delegated_connection_row(${grant}::uuid,'calendar.availability') as value`;
      expect(result.value.id).toBe(connection);
      expect(result.value.owner_user_id).toBe(owner);
      expect(await tx`select * from integration.connections`).toHaveLength(0);
      expect((await tx`select app.bypass_rls() as bypass`)[0].bypass).toBe(false);
    });
  });
  test('wrong tenant, operation and owner cannot use authority', async () => {
    for (const [organization,operation] of [[foreignTenant,'calendar.availability'],[tenant,'mail.send']]) {
      await as(service,service,organization!,operation!,async tx => expect((await tx`select app.delegated_connection_row(${grant}::uuid,'calendar.availability') as value`)[0].value).toBeNull());
    }
    await db`update integration.connections set owner_user_id=${service}::uuid where id=${connection}::uuid`;
    try { await as(service,service,tenant,'calendar.availability',async tx => expect((await tx`select app.delegated_connection_row(${grant}::uuid,'calendar.availability') as value`)[0].value).toBeNull()); }
    finally { await db`update integration.connections set owner_user_id=${owner}::uuid where id=${connection}::uuid`; }
  });
  test('token renewal updates only the granted connection, retaining caller identity', async () => {
    await as(service,service,tenant,'calendar.availability',async tx => {
      expect((await tx`select app.delegated_connection_token_update(${grant}::uuid,'calendar.availability','{"accessToken":"renewed-ciphertext"}'::jsonb) as updated`)[0].updated).toBe(true);
      expect((await tx`select app.current_user_id() as actor,app.current_relation_id() as party,app.bypass_rls() as bypass`)[0]).toMatchObject({actor:service,party:service,bypass:false});
    });
    expect((await db`select configuration_values from integration.connections where id=${connection}::uuid`)[0].configuration_values.accessToken).toBe('renewed-ciphertext');
  });
  test('duplicate active grants are refused and bypass cannot cross the tenant fence',async()=>{
    await expect(as(owner,actor,tenant,'calendar.consent',tx=>issue(tx,crypto.randomUUID()))).rejects.toThrow('duplicate key');
    await as(service,service,foreignTenant,'calendar.availability',async tx=>{
      await tx`select set_config('app.bypass_rls','true',true)`;
      expect(await tx`select * from platform.connection_use_grants where id=${grant}::uuid`).toHaveLength(0);
      expect((await tx`select app.delegated_connection_row(${grant}::uuid,'calendar.availability') as value`)[0].value).toBeNull();
    });
  });
  test('revocation immediately refuses reads and token writes and cannot be undone', async () => {
    await as(owner,actor,tenant,'calendar.consent',async tx => { await tx`update platform.connection_use_grants set revoked_at=now() where id=${grant}::uuid`; });
    await as(service,service,tenant,'calendar.availability',async tx => {
      expect((await tx`select app.delegated_connection_row(${grant}::uuid,'calendar.availability') as value`)[0].value).toBeNull();
      expect((await tx`select app.delegated_connection_token_update(${grant}::uuid,'calendar.availability','{}'::jsonb) as updated`)[0].updated).toBe(false);
    });
    await expect(as(owner,actor,tenant,'calendar.consent',async tx => { await tx`update platform.connection_use_grants set revoked_at=null where id=${grant}::uuid`; })).rejects.toThrow('scope is immutable');
  });
  test('offboarding withdraws authority permanently, including after access is restored',async()=>{
    const offboardingGrant=crypto.randomUUID();
    await as(owner,actor,tenant,'calendar.consent',tx=>issue(tx,offboardingGrant));
    // Use the normal tenant context even for the privileged migration fixture.
    await db.begin(async tx=>{
      await tx`select set_config('app.tenant_id',${tenant},true),set_config('app.roles','Organization.All.ReadWrite',true)`;
      await tx`update platform.identity_relations set access_blocked=true where identity_id=${identity}::uuid`;
    });
    await as(service,service,tenant,'calendar.availability',async tx=>expect((await tx`select app.delegated_connection_row(${offboardingGrant}::uuid,'calendar.availability') as value`)[0].value).toBeNull());
    await db.begin(async tx=>{await tx`select set_config('app.roles','Organization.All.ReadWrite',true)`;await tx`update platform.identity_relations set access_blocked=false where identity_id=${identity}::uuid`;});
    expect((await db`select revoked_at from platform.connection_use_grants where id=${offboardingGrant}::uuid`)[0].revoked_at).not.toBeNull();
    // New consent is a new row; the old one cannot be reactivated.
    await as(owner,actor,tenant,'calendar.consent',tx=>issue(tx,crypto.randomUUID()));
  });
});
