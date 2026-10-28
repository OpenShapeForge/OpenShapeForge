// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { sql } from 'kysely';
import { createDatabaseRuntime } from '../db/connection.js';
import { applyAuditHistory } from '../db/migrations/audit-history.js';
import { auditOperationHandler } from './history-operations.js';
import catalog from '../generated/operations/audit.json' with { type: 'json' };
import { jsonbLiteral } from '../db/sql-helpers.js';
import type { GeneratedCrudTable } from '../operations/entity/types.js';

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL;
test.skipIf(!adminUrl)('module-qualified lease events resolve canonical names without rewriting audit facts', async () => {
  const name = `audit_lease_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(adminUrl!, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(adminUrl!); url.pathname = '/' + name;
  const runtime = createDatabaseRuntime({ databaseUrl: String(url), maxConnections: 2 });
  const db = runtime.db;
  const tenant = crypto.randomUUID(), actor = crypto.randomUUID(), record = crypto.randomUUID();
  const qualified = Object.entries(catalog.entityNames).find(([, value]) => value === 'Relation')![0];
  const table = { name: 'probe.records', schema: 'probe', table: 'records', primaryKey: 'id', tenantScoped: true,
    columns: [], source: { authoringEntityName: 'Relation', graphql: { singleQueryName: 'relation' } } } as unknown as GeneratedCrudTable;
  const context = { db, session: { tenantId: tenant, userId: actor, roles: ['Audit.Read'], groups: [] } } as any;
  const get = auditOperationHandler({ handler: 'get', auth: { mode: 'session', roles: ['Audit.Read'] } } as any);
  const list = auditOperationHandler({ handler: 'list', auth: { mode: 'session', roles: ['Audit.Read'] } } as any);
  try {
    await sql.raw(`create schema platform; create schema probe;
      create table platform.identities(id uuid primary key,subject text,issuer text);
      create table platform.identity_relations(identity_id uuid,tenant_id uuid);
      create table platform.entity_events(id uuid primary key default gen_random_uuid(),tenant_id uuid,aggregate_type text,aggregate_id text,event_type text,occurred_at timestamptz default now(),sequence bigserial,delivery_sequence bigint,payload jsonb);
      create table probe.records(id uuid primary key,tenant_id uuid,name text);`).execute(db);
    const old = crypto.randomUUID();
    const payload = { audit: { entityType: qualified, actorId: actor, subjects: [{ entityType: qualified, recordId: record }] } };
    await sql`insert into platform.entity_events(id,tenant_id,aggregate_type,aggregate_id,event_type,payload)
      values(${old}::uuid,${tenant}::uuid,${qualified},${record},'edit_lease_acquired',${jsonbLiteral(payload)})`.execute(db);
    const other = { ...table, name: 'probe.accounts', table: 'accounts', source: { authoringEntityName: 'Account', graphql: { singleQueryName: 'account' } } } as unknown as GeneratedCrudTable;
    await sql.raw('create table probe.accounts(id uuid primary key,tenant_id uuid,name text)').execute(db);
    await applyAuditHistory(db, [table, other], {});
    const accountId = Object.entries(catalog.entityNames).find(([, value]) => value === 'Account')![0];
    expect((await sql<{ name: string }>`select platform.audit_entity_name(${accountId}) as name`.execute(db)).rows[0]!.name).toBe('Account');
    for (const identifier of ['Relation', 'relation', qualified]) {
      expect((await sql<{ name: string }>`select platform.audit_entity_name(${identifier}) as name`.execute(db)).rows[0]!.name).toBe('Relation');
    }
    expect((await sql<{ name: string | null }>`select platform.audit_entity_name('unregistered.Relation') as name`.execute(db)).rows[0]!.name).toBeNull();
    const event = (await get({ id: old }, context) as any).value;
    expect(event.entityType).toBe('Relation');
    expect(event.rawData.audit).toEqual(payload.audit);
    expect((await list({ filter: { entityType: { eq: 'Relation' } } }, context) as any).value.items.map((item: any) => item.id)).toContain(old);
    await expect(get({ id: old }, { ...context, session: { ...context.session, tenantId: crypto.randomUUID() } })).rejects.toThrow();
    await expect(get({ id: old }, { ...context, session: { ...context.session, roles: [] } })).rejects.toThrow();
    // The current writer's module-qualified aggregate also receives a canonical envelope.
    await sql`insert into platform.entity_events(tenant_id,aggregate_type,aggregate_id,event_type,payload)
      values(${tenant}::uuid,${qualified},${record},'edit_lease_released','{}')`.execute(db);
    const fresh = (await list({ filter: { eventType: { eq: 'edit_lease_released' } } }, context) as any).value.items[0];
    expect(fresh.entityType).toBe('Relation');
    expect(fresh.subjects).toEqual([{ entityType: 'Relation', recordId: record }]);
    expect((await sql<{ payload: unknown }>`select payload from platform.entity_events where id=${old}::uuid`.execute(db)).rows[0]!.payload).toEqual(payload);
    await applyAuditHistory(db, [table], {});
    expect((await get({ id: old }, context) as any).value.entityType).toBe('Relation');
  } finally {
    await runtime.close(); await admin.unsafe(`drop database "${name}" with (force)`); await admin.close();
  }
});
