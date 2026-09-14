// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import migration from "../migrations/versioned/0011_reconcile-generated-rls-policy-pairs.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 30_000;

function scratchUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (db: Kysely<any>) => Promise<T>): Promise<T> {
  const name = `generated_policy_pairs_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    const runtime = createDatabaseRuntime({ databaseUrl: scratchUrl(name), maxConnections: 1 });
    try {
      return await runtime.db.connection().execute(fn);
    } finally {
      await runtime.close();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function policyNames(
  db: Kysely<any>,
  schema: string,
  table: string,
): Promise<string[]> {
  const result = await sql<{ policyname: string }>`
    select policyname
    from pg_policies
    where schemaname = ${schema} and tablename = ${table}
    order by policyname
  `.execute(db);
  return result.rows.map(({ policyname }) => policyname);
}

describe("0011 generated RLS policy-pair reconciliation", () => {
  test("removes only the tenant-wide half of generated duplicate pairs", async () => {
    await withScratchDb(async (db) => {
      await sql`create schema platform`.execute(db);
      await sql`create schema custom`.execute(db);
      await sql`create table platform.mcp_handoffs (tenant_id uuid not null)`.execute(db);
      await sql`create table platform.entity_events (tenant_id uuid not null)`.execute(db);
      await sql`create table custom.records (tenant_id uuid not null)`.execute(db);

      await sql`create policy mcp_handoffs_row_scope on platform.mcp_handoffs using (false)`.execute(db);
      await sql`create policy mcp_handoffs_tenant_isolation on platform.mcp_handoffs using (true)`.execute(db);
      await sql`create policy mcp_handoffs_custom_audit on platform.mcp_handoffs using (true)`.execute(db);
      await sql`create policy entity_events_tenant_isolation on platform.entity_events using (true)`.execute(db);
      await sql`create policy records_row_scope on custom.records using (false)`.execute(db);
      await sql`create policy records_tenant_isolation on custom.records using (true)`.execute(db);

      await migration.up(db);
      await migration.up(db);

      expect(await policyNames(db, "platform", "mcp_handoffs")).toEqual([
        "mcp_handoffs_custom_audit",
        "mcp_handoffs_row_scope",
      ]);
      expect(await policyNames(db, "platform", "entity_events")).toEqual([
        "entity_events_tenant_isolation",
      ]);
      expect(await policyNames(db, "custom", "records")).toEqual([
        "records_row_scope",
        "records_tenant_isolation",
      ]);
    });
  }, TEST_TIMEOUT);
});
