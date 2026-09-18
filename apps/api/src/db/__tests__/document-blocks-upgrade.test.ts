// SPDX-License-Identifier: BUSL-1.1
/**
 * Upgrading a database from either earlier shape of erp.blocks. Before blocks
 * had a second owner, variant_id is NOT NULL and the generated roll-forward
 * classifies a nullability change as non-additive drift and refuses. The
 * unreleased revision slice left revision_id on blocks, current_revision_id
 * on documents and a document_revisions table the manifest no longer knows,
 * which the roll-forward refuses as well. The chain's pre-step
 * (migrations/document-content.ts, prepareDocumentOwnedBlocks) reshapes
 * both first, under the owner check, so the roll-forward sees only additive
 * drift.
 *
 * Both shapes are produced by rewinding a freshly built scratch database
 * and marking the recorded checksum stale, with block rows present.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/db/__tests__/document-blocks-upgrade.test.ts
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { type Kysely, sql } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { generatedSchemaMigrationVersion } from "../migrations/generated-schema.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const OWNER_CHECK = "erp_blocks_values_owner_check_7e02a4f3b503";

async function withScratchDb<T>(fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const name = `blocks_upgrade_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev" || url.pathname === "/hubble_dev") throw new Error("admin URL must not point at a live database");
  url.pathname = `/${name}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    try {
      await runtime.db.connection().execute((conn) => runMigrationChain(conn));
      return await fn(runtime.db);
    } finally {
      await runtime.close();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function blocksShape(db: Kysely<DB>) {
  const columns = await sql<{ column_name: string; is_nullable: string }>`
    select column_name, is_nullable from information_schema.columns
    where table_schema = 'erp' and table_name = 'blocks' and column_name in ('variant_id', 'document_variant_id', 'revision_id') order by column_name`.execute(db);
  const check = await sql<{ expression: string }>`
    select pg_get_constraintdef(oid) as expression from pg_constraint where conname = ${OWNER_CHECK}`.execute(db);
  return { columns: columns.rows, ownerCheck: check.rows[0]?.expression ?? null };
}

const seed = async (db: Kysely<DB>) => {
  const tenant = randomUUID(), template = randomUUID(), variant = randomUUID(), block = randomUUID();
  await sql`insert into erp.templates (id, tenant_id, key, name) values (${template}::uuid, ${tenant}::uuid, 'welcome', 'Welcome')`.execute(db);
  await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${variant}::uuid, ${tenant}::uuid, ${template}::uuid, 'document', 'nl')`.execute(db);
  await sql`insert into erp.blocks (id, tenant_id, variant_id, definition_key, "values") values (${block}::uuid, ${tenant}::uuid, ${variant}::uuid, 'TextBlock', '{"text":"Hello"}'::jsonb)`.execute(db);
  return { tenant, template, variant, block };
};
const current = {
  columns: [{ column_name: "document_variant_id", is_nullable: "YES" }, { column_name: "variant_id", is_nullable: "YES" }],
  ownerCheck: "CHECK ((num_nonnulls(document_variant_id, variant_id) = 1))",
};
const rollForward = async (db: Kysely<DB>, ids: { block: string; variant: string }) => {
  const rolled = await db.connection().execute((conn) => runMigrationChain(conn));
  expect(rolled.applied).toBe(true);
  expect(await blocksShape(db)).toEqual(current);
  const rows = await sql<{ id: string; variant_id: string; document_variant_id: string | null; text: string }>`
    select id, variant_id, document_variant_id, "values"->>'text' as text from erp.blocks`.execute(db);
  expect(rows.rows).toEqual([{ id: ids.block, variant_id: ids.variant, document_variant_id: null, text: "Hello" }]);
  // No row may lose both owners.
  await expect(sql`update erp.blocks set variant_id = null where id = ${ids.block}::uuid`.execute(db)).rejects.toThrow(OWNER_CHECK);
  // A rerun is a no-op on the now-current shape.
  const again = await db.connection().execute((conn) => runMigrationChain(conn));
  expect(again.applied).toBe(false);
};

describe("upgrading blocks from an earlier database", () => {
  test("a pre-owner database: the chain relaxes variant_id under the owner check and the roll-forward passes", async () => {
    await withScratchDb(async (db) => {
      const ids = await seed(db);
      await sql.raw(`
        alter table erp.blocks drop constraint if exists "${OWNER_CHECK}";
        drop policy if exists blocks_owner_read on erp.blocks;
        drop trigger if exists blocks_document_guard on erp.blocks;
        alter table erp.blocks drop column document_variant_id;
        alter table erp.blocks alter column variant_id set not null;
        update platform.schema_migrations set checksum = 'pre-owner' where version = '${generatedSchemaMigrationVersion}';
        delete from platform.schema_migrations where version like '%${OWNER_CHECK.replace("erp_blocks_values_", "")}%';
      `).execute(db);
      expect(await blocksShape(db)).toEqual({ columns: [{ column_name: "variant_id", is_nullable: "NO" }], ownerCheck: null });
      await rollForward(db, ids);
    });
  }, 120_000);

  test("a revision-slice database: revision columns, table and rows are dropped and the roll-forward passes", async () => {
    await withScratchDb(async (db) => {
      const ids = await seed(db);
      await sql.raw(`
        alter table erp.blocks drop constraint if exists "${OWNER_CHECK}";
        drop policy if exists blocks_owner_read on erp.blocks;
        drop trigger if exists blocks_document_guard on erp.blocks;
        alter table erp.blocks drop column document_variant_id;
        alter table erp.blocks add column revision_id uuid, add column revision_id_position integer;
        alter table erp.blocks add constraint "${OWNER_CHECK}" check (num_nonnulls(revision_id, variant_id) = 1);
        create table erp.document_revisions (id uuid primary key, tenant_id uuid not null);
        alter table erp.documents add column current_revision_id uuid;
        insert into erp.document_revisions (id, tenant_id) values ('${randomUUID()}', '${ids.tenant}');
        insert into erp.blocks (id, tenant_id, revision_id, revision_id_position, definition_key, "values")
          select '${randomUUID()}', tenant_id, id, 0, 'TextBlock', '{"text":"Revision"}'::jsonb from erp.document_revisions;
        update platform.schema_migrations set checksum = 'revision-slice' where version = '${generatedSchemaMigrationVersion}';
      `).execute(db);
      expect((await blocksShape(db)).columns).toEqual([{ column_name: "revision_id", is_nullable: "YES" }, { column_name: "variant_id", is_nullable: "YES" }]);
      await rollForward(db, ids);
      const leftovers = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema = 'erp' and table_name = 'document_revisions'`.execute(db);
      expect(leftovers.rows[0]!.n).toBe(0);
    });
  }, 120_000);
});
