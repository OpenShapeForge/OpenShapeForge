// SPDX-License-Identifier: BUSL-1.1
import { test, expect } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { createDatabaseRuntime } from '../connection.js';
import { makeConfigurationCodesUnique } from '../migrations/versioned/0023_unique-configuration-codes.js';

async function scratch(run: (db: Kysely<any>) => Promise<void>) {
  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? 'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
  const name = 'configuration_codes_' + randomUUID().replaceAll('-', '');
  const admin = new SQL(adminUrl, { max: 1 });
  let runtime: ReturnType<typeof createDatabaseRuntime> | undefined;
  try {
    await admin.unsafe(`create database "${name}"`);
    const url = new URL(adminUrl); url.pathname = '/' + name;
    runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    await sql`create schema erp`.execute(runtime.db);
    await sql`create table erp.case_types(id uuid primary key, tenant_id uuid not null, created_at timestamptz not null, code text not null, name text)`.execute(runtime.db);
    await sql`create table erp.work_queues(id uuid primary key, tenant_id uuid not null, key text)`.execute(runtime.db);
    await run(runtime.db);
  } finally {
    await runtime?.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}

const codes = async (db: Kysely<any>) =>
  (await sql<{ id: string; tenant_id: string; code: string }>`select id::text, tenant_id::text, code from erp.case_types order by created_at`.execute(db)).rows;

test('the oldest row keeps a duplicated code, later ones get their id as suffix, and the index can then be built', async () => scratch(async (db) => {
  const [tenant, other] = [randomUUID(), randomUUID()];
  const [first, second, third, foreign] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await sql`insert into erp.case_types values
    (${second}::uuid, ${tenant}::uuid, '2026-02-01', 'complaint', 'Second'),
    (${first}::uuid, ${tenant}::uuid, '2026-01-01', 'complaint', 'First'),
    (${third}::uuid, ${tenant}::uuid, '2026-03-01', 'question', 'Third'),
    (${foreign}::uuid, ${other}::uuid, '2026-04-01', 'complaint', 'Other tenant')`.execute(db);
  await sql`insert into erp.work_queues values (${randomUUID()}::uuid, ${tenant}::uuid, 'triage'), (${randomUUID()}::uuid, ${tenant}::uuid, 'triage')`.execute(db);
  await db.transaction().execute((tx) => makeConfigurationCodesUnique(tx));
  const rows = Object.fromEntries((await codes(db)).map((row) => [row.id, row.code]));
  expect(rows).toEqual({
    [first]: 'complaint',
    [second]: `complaint-${second.slice(0, 8)}`,
    [third]: 'question',
    [foreign]: 'complaint',
  });
  await sql`create unique index case_types_tenant_code_uidx on erp.case_types (tenant_id, code)`.execute(db);
  await sql`create unique index work_queues_tenant_key_uidx on erp.work_queues (tenant_id, key)`.execute(db);
  // A second run changes nothing; a table that does not exist is skipped.
  await db.transaction().execute((tx) => makeConfigurationCodesUnique(tx));
  expect(Object.fromEntries((await codes(db)).map((row) => [row.id, row.code]))).toEqual(rows);
}), 30000);
