// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import migration from "../migrations/versioned/0010_relation-group-memberships.js";

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
  const name = `relation_group_migration_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

async function createLegacySchema(db: Kysely<any>): Promise<void> {
  await sql`create schema erp`.execute(db);
  await sql`
    create table erp.relation_groups (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      name text not null,
      status text,
      relation_id uuid
    )
  `.execute(db);
  await sql`
    create table erp.relations (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null,
      display_name text not null,
      relation_group_id uuid
    )
  `.execute(db);
}

describe("0010 RelationGroup memberships", () => {
  test("backfills only legacy Relation membership links and preserves group context", async () => {
    await withScratchDb(async (db) => {
      await createLegacySchema(db);
      const tenantId = randomUUID();
      const memberId = randomUUID();
      const ownerContextId = randomUUID();
      const groupId = randomUUID();
      await sql`
        insert into erp.relation_groups (id, tenant_id, name, status, relation_id)
        values (${groupId}, ${tenantId}, 'Team Alpha', null, ${ownerContextId})
      `.execute(db);
      await sql`
        insert into erp.relations (id, tenant_id, display_name, relation_group_id)
        values
          (${memberId}, ${tenantId}, 'Member', ${groupId}),
          (${ownerContextId}, ${tenantId}, 'Owner context', null)
      `.execute(db);

      await migration.up(db);
      await migration.up(db);

      const groups = await sql<{ group_type: string; status: string; relation_id: string }>`
        select group_type, status, relation_id::text
        from erp.relation_groups
        where id = ${groupId}
      `.execute(db);
      expect(groups.rows).toEqual([{
        group_type: "general",
        status: "active",
        relation_id: ownerContextId,
      }]);

      const memberships = await sql<{
        relation_id: string;
        relation_group_id: string;
        status: string;
      }>`
        select relation_id::text, relation_group_id::text, status
        from erp.relation_group_memberships
        order by relation_id
      `.execute(db);
      expect(memberships.rows).toEqual([{
        relation_id: memberId,
        relation_group_id: groupId,
        status: "active",
      }]);
    });
  }, TEST_TIMEOUT);

  test("refuses a legacy cross-tenant group link without copying it", async () => {
    await withScratchDb(async (db) => {
      await createLegacySchema(db);
      const groupId = randomUUID();
      await sql`
        insert into erp.relation_groups (id, tenant_id, name, status)
        values (${groupId}, ${randomUUID()}, 'Other tenant', 'active')
      `.execute(db);
      await sql`
        insert into erp.relations (tenant_id, display_name, relation_group_id)
        values (${randomUUID()}, 'Invalid member', ${groupId})
      `.execute(db);

      await expect(migration.up(db)).rejects.toThrow(/does not reference a group in the same tenant/);
      const memberships = await sql<{ count: string }>`
        select count(*)::text as count from erp.relation_group_memberships
      `.execute(db);
      expect(memberships.rows[0]?.count).toBe("0");
    });
  }, TEST_TIMEOUT);

  test("refuses an unknown existing group lifecycle status", async () => {
    await withScratchDb(async (db) => {
      await createLegacySchema(db);
      await sql`
        insert into erp.relation_groups (tenant_id, name, status)
        values (${randomUUID()}, 'Unknown status', 'archived')
      `.execute(db);

      await expect(migration.up(db)).rejects.toThrow(/status is not active or inactive/);
    });
  }, TEST_TIMEOUT);
});
