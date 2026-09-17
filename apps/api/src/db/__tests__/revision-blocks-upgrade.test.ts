// SPDX-License-Identifier: BUSL-1.1
/**
 * Upgrading a database built before document revisions existed. There
 * erp.blocks.variant_id is NOT NULL and revision_id is absent; the generated
 * roll-forward classifies a nullability change as non-additive drift and
 * refuses. The chain's pre-step (migrations/document-revisions.ts,
 * prepareRevisionOwnedBlocks) relaxes the constraint first, under the owner
 * check, so the roll-forward sees only additive drift.
 *
 * The previous shape is produced by rewinding a freshly built scratch
 * database: drop the revision column and the owner check, restore NOT NULL,
 * and mark the recorded checksum stale, with block rows present.
 *
 * Run (cwd apps/api):
 *   SCRATCH_ADMIN_DATABASE_URL=postgres://openshapeforge:openshapeforge@127.0.0.1:5435/postgres \
 *     bun test src/db/__tests__/revision-blocks-upgrade.test.ts
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
  const name = `revision_upgrade_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
    where table_schema = 'erp' and table_name = 'blocks' and column_name in ('variant_id', 'revision_id') order by column_name`.execute(db);
  const check = await sql<{ expression: string }>`
    select pg_get_constraintdef(oid) as expression from pg_constraint where conname = ${OWNER_CHECK}`.execute(db);
  return { columns: columns.rows, ownerCheck: check.rows[0]?.expression ?? null };
}

describe("upgrading blocks from a pre-revision database", () => {
  test("the chain relaxes variant_id under the owner check and the roll-forward passes", async () => {
    await withScratchDb(async (db) => {
      const tenant = randomUUID(), template = randomUUID(), variant = randomUUID(), block = randomUUID();
      await sql`insert into erp.templates (id, tenant_id, key, name) values (${template}::uuid, ${tenant}::uuid, 'welcome', 'Welcome')`.execute(db);
      await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${variant}::uuid, ${tenant}::uuid, ${template}::uuid, 'document', 'nl')`.execute(db);
      await sql`insert into erp.blocks (id, tenant_id, variant_id, definition_key, "values") values (${block}::uuid, ${tenant}::uuid, ${variant}::uuid, 'TextBlock', '{"text":"Hello"}'::jsonb)`.execute(db);

      // Rewind erp.blocks to the shape a deployment had before revisions.
      await sql.raw(`
        alter table erp.blocks drop constraint if exists "${OWNER_CHECK}";
        drop policy if exists blocks_owner_read on erp.blocks;
        drop trigger if exists blocks_revision_guard on erp.blocks;
        alter table erp.blocks drop column revision_id;
        alter table erp.blocks alter column variant_id set not null;
        update platform.schema_migrations set checksum = 'pre-revision' where version = '${generatedSchemaMigrationVersion}';
        delete from platform.schema_migrations where version like '%${OWNER_CHECK.replace("erp_blocks_values_", "")}%';
      `).execute(db);
      expect(await blocksShape(db)).toEqual({ columns: [{ column_name: "variant_id", is_nullable: "NO" }], ownerCheck: null });

      const rolled = await db.connection().execute((conn) => runMigrationChain(conn));
      expect(rolled.applied).toBe(true);
      expect(await blocksShape(db)).toEqual({
        columns: [{ column_name: "revision_id", is_nullable: "YES" }, { column_name: "variant_id", is_nullable: "YES" }],
        ownerCheck: 'CHECK ((num_nonnulls(revision_id, variant_id) = 1))',
      });
      const rows = await sql<{ id: string; variant_id: string; revision_id: string | null; text: string }>`
        select id, variant_id, revision_id, "values"->>'text' as text from erp.blocks`.execute(db);
      expect(rows.rows).toEqual([{ id: block, variant_id: variant, revision_id: null, text: "Hello" }]);
      // No row may lose both owners.
      await expect(sql`update erp.blocks set variant_id = null where id = ${block}::uuid`.execute(db)).rejects.toThrow(OWNER_CHECK);

      // A rerun is a no-op on the now-current shape.
      const again = await db.connection().execute((conn) => runMigrationChain(conn));
      expect(again.applied).toBe(false);
    });
  }, 120_000);
});
