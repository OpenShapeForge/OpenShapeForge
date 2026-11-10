// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import {sql,type Transaction} from 'kysely';
import type {DB} from '../../generated/db/types.js';
import {prepareConnectionUseGrant} from '../../modules/connection-use-grants.js';
import { createDatabaseRuntime } from '../connection.js';
import { runMigrationChain } from '../migration-chain.js';
import { IDENTITY_LINK_ADMIN_ROLE } from '../../auth/organization-roles.js';
import { provisionDatabaseRoles } from '../database-roles.js';
const url = process.env.SCRATCH_ADMIN_DATABASE_URL ?? 'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
const suffix = crypto.randomUUID().replaceAll('-', '');
const database = `connection_grants_${suffix}`, role = "openshapeforge_app";
const tenant = crypto.randomUUID(), foreignTenant = crypto.randomUUID(), owner = crypto.randomUUID(), actor = crypto.randomUUID(), service = crypto.randomUUID();
const identity = crypto.randomUUID(), adapter = crypto.randomUUID();
const connection = crypto.randomUUID(), grant = crypto.randomUUID(), subject = crypto.randomUUID();
let admin: SQL, db: SQL;
let grantsRuntime: ReturnType<typeof createDatabaseRuntime>;
describe('owner-issued connection use grants', () => {
  beforeAll(async () => {
    admin = new SQL(url!); await admin.unsafe(`create database "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`; db = new SQL(target.href);
    const runtime=createDatabaseRuntime({databaseUrl:target.href,maxConnections:2});
    try {
      await provisionDatabaseRoles(runtime.db,{passwords:{app:'openshapeforge_app',worker:'openshapeforge_worker'}});
      await runtime.db.connection().execute(conn=>runMigrationChain(conn));
      // Reapplying the complete chain must preserve grants and helper dependencies.
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
    grantsRuntime=createDatabaseRuntime({databaseUrl:target.href,maxConnections:4});
  },120_000);
  afterAll(async () => { await grantsRuntime?.close(); await db?.close(); if (admin) { await admin.unsafe(`drop database "${database}" with(force)`); await admin.close(); } });
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
  test('an owner withdraws consent without hard-deleting its record',async()=>{
    const retained=crypto.randomUUID();
    await as(owner,actor,tenant,'calendar.consent',tx=>issue(tx,retained));
    await as(owner,actor,tenant,'calendar.consent',async tx=>{
      expect(await tx`delete from platform.connection_use_grants where id=${retained}::uuid returning id`).toHaveLength(0);
      expect(await tx`select id from platform.connection_use_grants where id=${retained}::uuid`).toHaveLength(1);
      await tx`update platform.connection_use_grants set revoked_at=now() where id=${retained}::uuid`;
    });
    expect((await db`select revoked_at from platform.connection_use_grants where id=${retained}::uuid`)[0].revoked_at).not.toBeNull();
  });
  test('offboarding permanently withdraws consent through both tenant and cross-tenant maintenance sessions',async()=>{
    for(const maintenance of [false,true]) for(const remove of [false,true]){
      const offboardingGrant=crypto.randomUUID();
      await as(owner,actor,tenant,'calendar.consent',tx=>issue(tx,offboardingGrant));
      await as(service,service,maintenance?'':tenant,'account.block',async tx=>{
        await tx`select set_config('app.roles',${IDENTITY_LINK_ADMIN_ROLE},true),set_config('app.bypass_rls',${String(maintenance)},true)`;
        const changed = remove ? await tx`delete from platform.identity_relations where tenant_id=${tenant}::uuid and identity_id=${identity}::uuid returning identity_id`
          : await tx`update platform.identity_relations set access_blocked=true where tenant_id=${tenant}::uuid and identity_id=${identity}::uuid returning identity_id`;
        expect(changed).toHaveLength(1);
        expect((await tx`select app.current_tenant() as tenant,app.bypass_rls() as bypass,app.current_user_id() as actor`)[0]).toMatchObject({tenant:maintenance?null:tenant,bypass:maintenance,actor:service});
      });
      await as(service,service,tenant,'calendar.availability',async tx=>expect((await tx`select app.delegated_connection_row(${offboardingGrant}::uuid,'calendar.availability') as value`)[0].value).toBeNull());
      await as(service,service,tenant,'account.unblock',async tx=>{
        await tx`select set_config('app.roles',${IDENTITY_LINK_ADMIN_ROLE},true)`;
        if(remove) await tx`insert into platform.identity_relations(identity_id,tenant_id,relation_id,status,linked_at,linked_by) values(${identity}::uuid,${tenant}::uuid,${owner}::uuid,'linked',now(),'jit')`;
        else await tx`update platform.identity_relations set access_blocked=false where tenant_id=${tenant}::uuid and identity_id=${identity}::uuid`;
      });
      expect((await db`select revoked_at from platform.connection_use_grants where id=${offboardingGrant}::uuid`)[0].revoked_at).not.toBeNull();
      await as(service,service,tenant,'calendar.availability',async tx=>expect((await tx`select app.delegated_connection_row(${offboardingGrant}::uuid,'calendar.availability') as value`)[0].value).toBeNull());
    }
  });
  async function transaction<T>(person: string, organization: string, run: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return grantsRuntime.db.transaction().execute(async trx => {
      await sql.raw('set local role "openshapeforge_app"').execute(trx);
      await sql`select set_config('app.tenant_id',${organization},true),set_config('app.relation_id',${person},true),
        set_config('app.user_id',${actor},true),set_config('app.audit_operation','calendar.consent',true)`.execute(trx);
      return run(trx);
    });
  }
  const fingerprintA='a'.repeat(64),fingerprintB='b'.repeat(64);
  function scope(subjectId: string, fingerprint: string) {
    return {tenantId:tenant,subject:{entity:'Calendar',id:subjectId},connectionId:connection,
      consumerOperation:'calendar.availability',definitionId:adapter,fingerprint,consent:{inputSchema:{},expiresAt:null,identityId:identity,actorId:actor,ownerRelationId:owner}};
  }
  async function insert(trx: Transaction<DB>, id: string, subjectId: string, fingerprint: string, expiresAt: string | null = null) {
    await sql`insert into platform.connection_use_grants
      (id,tenant_id,connection_table,values_column,connection_id,owner_relation_id,consumer_operation,subject_entity,subject_id,service_definition,definition_fingerprint,input_schema,issued_by,issued_identity_id,expires_at)
      values(${id}::uuid,${tenant}::uuid,'integration.connections','configuration_values',${connection}::uuid,${owner}::uuid,
        'calendar.availability','Calendar',${subjectId}::uuid,${JSON.stringify({id:adapter})}::text::jsonb,${fingerprint},'{}'::jsonb,${actor}::uuid,${identity}::uuid,${expiresAt}::timestamptz)`.execute(trx);
  }
  test('explicit new consent atomically replaces a stale Service snapshot and survives concurrent retries', async()=>{
    const subjectId=crypto.randomUUID(),oldId=crypto.randomUUID();
    await transaction(owner,tenant,trx=>insert(trx,oldId,subjectId,fingerprintA));
    const attempts=await Promise.all([1,2].map(()=>transaction(owner,tenant,async trx=>{
      const matching=await prepareConnectionUseGrant(trx,scope(subjectId,fingerprintB));
      if(matching)return matching;
      const id=crypto.randomUUID();await insert(trx,id,subjectId,fingerprintB);return id;
    })));
    expect(attempts[0]).toBe(attempts[1]);
    const rows: {id:string;revoked_at:Date|null;definition_fingerprint:string}[]=await db`select id,revoked_at,definition_fingerprint from platform.connection_use_grants where subject_id=${subjectId}::uuid`;
    expect(rows).toHaveLength(2);
    expect(rows.find(row=>row.id===oldId)!.revoked_at).not.toBeNull();
    expect(rows.filter(row=>row.revoked_at===null)).toHaveLength(1);
    expect(rows.find(row=>row.revoked_at===null)!.definition_fingerprint).toBe(fingerprintB);
  });
  test('repeat consent retains only the identical owner, issuer, lifetime and input limits',async()=>{
    const subjectId=crypto.randomUUID(),id=crypto.randomUUID();
    await transaction(owner,tenant,trx=>insert(trx,id,subjectId,fingerprintA));
    expect(await transaction(owner,tenant,trx=>prepareConnectionUseGrant(trx,scope(subjectId,fingerprintA)))).toBe(id);
    const changed=scope(subjectId,fingerprintA);changed.consent.inputSchema={type:'object',additionalProperties:false};
    await transaction(owner,tenant,async trx=>{
      expect(await prepareConnectionUseGrant(trx,changed)).toBeUndefined();
      throw Error('rollback explicit changed limits');
    }).catch(error=>expect(error.message).toBe('rollback explicit changed limits'));
    expect((await db`select revoked_at from platform.connection_use_grants where id=${id}::uuid`)[0].revoked_at).toBeNull();
  });
  test('a failed replacement and foreign or non-owner calls cannot withdraw existing consent', async()=>{
    const subjectId=crypto.randomUUID(),oldId=crypto.randomUUID(),replacementId=crypto.randomUUID();
    await transaction(owner,tenant,trx=>insert(trx,oldId,subjectId,fingerprintA));
    await expect(transaction(owner,tenant,async trx=>{
      await prepareConnectionUseGrant(trx,scope(subjectId,fingerprintB));
      await insert(trx,replacementId,subjectId,fingerprintB);
      throw Error('owning consent transaction rolled back');
    })).rejects.toThrow('owning consent transaction rolled back');
    for(const [person,organization] of [[service,tenant],[owner,foreignTenant]]) {
      await expect(transaction(person!,organization!,async trx=>{
        await prepareConnectionUseGrant(trx,scope(subjectId,fingerprintB));
        await insert(trx,crypto.randomUUID(),subjectId,fingerprintB);
      })).rejects.toThrow('row-level security');
    }
    const rows=await db`select id,revoked_at from platform.connection_use_grants where subject_id=${subjectId}::uuid`;
    expect(rows).toHaveLength(1);expect(rows[0].id).toBe(oldId);expect(rows[0].revoked_at).toBeNull();
  });
  test('expired consent can be renewed even when its Service fingerprint is unchanged', async()=>{
    const subjectId=crypto.randomUUID(),oldId=crypto.randomUUID();
    await transaction(owner,tenant,trx=>insert(trx,oldId,subjectId,fingerprintA,new Date(Date.now()-1000).toISOString()));
    await transaction(owner,tenant,async trx=>{
      await prepareConnectionUseGrant(trx,scope(subjectId,fingerprintA));
      await insert(trx,crypto.randomUUID(),subjectId,fingerprintA);
    });
    expect((await db`select revoked_at from platform.connection_use_grants where id=${oldId}::uuid`)[0].revoked_at).not.toBeNull();
  });
  test('membership withdrawal uses the live-identity index among unrelated grants', async()=>{
    const otherIdentity=crypto.randomUUID(),otherActor=crypto.randomUUID();
    await db`insert into platform.identities(id,issuer,subject) values(${otherIdentity}::uuid,'https://identity.example.test',${otherActor})`;
    await db`insert into platform.connection_use_grants
      (id,tenant_id,connection_table,values_column,connection_id,owner_relation_id,consumer_operation,subject_entity,subject_id,service_definition,definition_fingerprint,input_schema,issued_by,issued_identity_id)
      select gen_random_uuid(),${tenant}::uuid,'integration.connections','configuration_values',${connection}::uuid,${owner}::uuid,
        'calendar.availability','Calendar',gen_random_uuid(),${JSON.stringify({id:adapter})}::text::jsonb,${fingerprintA},'{}'::jsonb,${otherActor}::uuid,${otherIdentity}::uuid
      from generate_series(1,2000)`;
    await db`analyze platform.connection_use_grants`;
    const plan=await db`explain(format json) select id from platform.connection_use_grants
      where tenant_id=${tenant}::uuid and issued_identity_id=${identity}::uuid and revoked_at is null`;
    expect(JSON.stringify(plan)).toContain('connection_use_grants_issued_identity_idx');
  });

});
