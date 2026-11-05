// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabaseRuntime } from '../connection.js';
import migration from '../migrations/versioned/0024_remove-task-form.js';

test('remove the obsolete task form from a built database while retaining tasks', async () => {
  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? 'postgres://openshapeforge:openshapeforge@localhost:5434/postgres';
  const name = 'task_form_' + randomUUID().replaceAll('-', '');
  const admin = new SQL(adminUrl, { max: 1 });
  let runtime: ReturnType<typeof createDatabaseRuntime> | undefined;
  try {
    await admin.unsafe(`create database "${name}"`);
    const url = new URL(adminUrl); url.pathname = '/' + name;
    runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    await sql`create schema erp`.execute(runtime.db);
    await sql`create table erp.tasks (id int primary key, title text not null, form_definition jsonb, output jsonb)`.execute(runtime.db);
    await sql`insert into erp.tasks values (1, 'Example', '{}'::jsonb, '{}'::jsonb)`.execute(runtime.db);
    await runtime.db.transaction().execute((tx) => migration.up(tx));
    const rows = await sql<{ id: number; title: string }>`select id, title from erp.tasks`.execute(runtime.db);
    expect(rows.rows).toEqual([{ id: 1, title: 'Example' }]);
    const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'erp' and table_name = 'tasks' order by ordinal_position`.execute(runtime.db);
    expect(columns.rows.map(row => row.column_name)).toEqual(['id', 'title']);
  } finally {
    await runtime?.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}, 30000);
