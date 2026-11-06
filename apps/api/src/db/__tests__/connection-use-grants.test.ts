// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { CONNECTION_USE_GRANTS_SQL } from '../migrations/connection-use-grants.js';
const url = process.env.SCRATCH_ADMIN_DATABASE_URL;
const suffix = crypto.randomUUID().replaceAll('-', '');
const database = `connection_grants_${suffix}`, role = `connection_grants_${suffix}`;
const tenant = crypto.randomUUID(), foreignTenant = crypto.randomUUID(), owner = crypto.randomUUID(), actor = crypto.randomUUID(), service = crypto.randomUUID();
const connection = crypto.randomUUID(), grant = crypto.randomUUID(), subject = crypto.randomUUID();
let admin: SQL, db: SQL;
(url ? describe : describe.skip)('owner-issued connection use grants', () => {
  beforeAll(async () => {
    admin = new SQL(url!); await admin.unsafe(`create role "${role}" nologin`); await admin.unsafe(`create database "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`; db = new SQL(target.href);
    await db.unsafe(`create schema app; create schema platform; create schema integration;
      create function app.current_tenant() returns uuid language sql stable as $$ select nullif(current_setting('app.tenant_id',true),'')::uuid $$;
      create function app.current_user_id() returns uuid language sql stable as $$ select nullif(current_setting('app.user_id',true),'')::uuid $$;
      create function app.current_relation_id() returns uuid language sql stable as $$ select nullif(current_setting('app.relation_id',true),'')::uuid $$;
      create function app.bypass_rls() returns boolean language sql stable as $$ select coalesce(current_setting('app.bypass_rls',true),'')='true' $$;
      create table platform.connection_use_grants(id uuid primary key, tenant_id uuid not null, connection_table text not null, values_column text not null,
        connection_id uuid not null, owner_relation_id uuid not null, consumer_operation text not null, subject_entity text not null, subject_id uuid not null,
        service_definition jsonb not null, definition_fingerprint text not null, input_schema jsonb not null, issued_by uuid not null,
        issued_at timestamptz default now(), expires_at timestamptz, revoked_at timestamptz);
      alter table platform.connection_use_grants enable row level security; alter table platform.connection_use_grants force row level security;
      create policy connection_use_grants_tenant_isolation on platform.connection_use_grants using(tenant_id=app.current_tenant()) with check(tenant_id=app.current_tenant());
      create table integration.connections(id uuid primary key,tenant_id uuid not null,owner_user_id uuid,configuration_values jsonb);
      alter table integration.connections enable row level security; alter table integration.connections force row level security;
      create policy connections_scope on integration.connections using(app.bypass_rls() or (tenant_id=app.current_tenant() and owner_user_id=app.current_relation_id()));
      grant usage on schema app,platform,integration to "${role}";
      grant select,insert,update,delete on platform.connection_use_grants,integration.connections to "${role}";`);
    await db.unsafe(CONNECTION_USE_GRANTS_SQL);
    await db`insert into integration.connections values(${connection}::uuid,${tenant}::uuid,${owner}::uuid,'{"accessToken":"ciphertext-fixture"}'::jsonb)`;
  });
  afterAll(async () => { await db?.close(); if (admin) { await admin.unsafe(`drop database "${database}" with(force)`); await admin.unsafe(`drop role "${role}"`); await admin.close(); } });
  async function as<T>(person: string, user: string, organization: string, operation: string, run: (tx: SQL) => Promise<T>) {
    return db.begin(async tx => {
      await tx.unsafe(`set local role "${role}"`);
      await tx`select set_config('app.tenant_id',${organization},true),set_config('app.relation_id',${person},true),set_config('app.user_id',${user},true),set_config('app.audit_operation',${operation},true)`;
      return run(tx);
    });
  }
  async function issue(tx: SQL, id = grant, ownerId = owner) {
    await tx`insert into platform.connection_use_grants(id,tenant_id,connection_table,values_column,connection_id,owner_relation_id,consumer_operation,subject_entity,subject_id,service_definition,definition_fingerprint,input_schema,issued_by)
      values(${id}::uuid,${tenant}::uuid,'integration.connections','configuration_values',${connection}::uuid,${ownerId}::uuid,'calendar.availability','Calendar',${subject}::uuid,'{}'::jsonb,${'a'.repeat(64)},'{}'::jsonb,${actor}::uuid)`;
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
  test('revocation immediately refuses reads and token writes and cannot be undone', async () => {
    await as(owner,actor,tenant,'calendar.consent',async tx => { await tx`update platform.connection_use_grants set revoked_at=now() where id=${grant}::uuid`; });
    await as(service,service,tenant,'calendar.availability',async tx => {
      expect((await tx`select app.delegated_connection_row(${grant}::uuid,'calendar.availability') as value`)[0].value).toBeNull();
      expect((await tx`select app.delegated_connection_token_update(${grant}::uuid,'calendar.availability','{}'::jsonb) as updated`)[0].updated).toBe(false);
    });
    await expect(as(owner,actor,tenant,'calendar.consent',async tx => { await tx`update platform.connection_use_grants set revoked_at=null where id=${grant}::uuid`; })).rejects.toThrow('scope is immutable');
  });
});
