// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { migrateColumnBlocks } from "@openshapeforge/documents/migrations/column-blocks";
import { fingerprintSnapshot, parseSnapshot, type PublishedSnapshot } from "@openshapeforge/versioning/snapshot";
import type { VersionedMigration } from "../versioned-runner.js";

/** Representation-only upgrade: retain text, style, locks and divergent copies. */
const migration: VersionedMigration = {
  version: "0029_text-columns-blocks",
  fileUrl: import.meta.url,
  async up(db) {
    await sql`select set_config('app.bypass_rls', 'true', true)`.execute(db);
    const counts: Record<string, number> = {};
    for (const table of ["blocks", "template_versions", "document_versions"] as const) {
      counts[table] = 0;
      const present = await sql<{ present: boolean }>`select to_regclass(${`erp.${table}`}) is not null as present`.execute(db);
      if (!present.rows[0]?.present) continue;
      const column = table === "blocks" ? "values" : "snapshot";
      const rows = await sql<{ id: string; tenant_id: string; payload: unknown; definition_key?: string }>`select id, tenant_id, ${sql.id(column)} as payload,
        ${table === "blocks" ? sql`definition_key` : sql`null::text`} as definition_key
        from ${sql.id("erp", table)} where ${sql.id(column)} is not null for update`.execute(db);
      for (const row of rows.rows) {
        const input = table === "blocks" ? { definition_key: row.definition_key, values: row.payload } : row.payload;
        const converted = await migrateColumnBlocks(input) as Record<string, unknown>;
        const after = table === "blocks" ? converted.values : converted;
        if (JSON.stringify(row.payload) === JSON.stringify(after)) continue;
        if (table === "blocks") {
          await sql`update erp.blocks set "values" = ${JSON.stringify(after)}::text::jsonb
            where id = ${row.id}::uuid and tenant_id = ${row.tenant_id}::uuid`.execute(db);
        } else {
          // Validate the core shape without projecting away captured extensions.
          parseSnapshot(after);
          const frozen = fingerprintSnapshot(after as PublishedSnapshot);
          await sql`update ${sql.id("erp", table)} set snapshot = ${frozen.canonical}::text::jsonb, content_hash = ${frozen.contentHash}
            where id = ${row.id}::uuid and tenant_id = ${row.tenant_id}::uuid`.execute(db);
        }
        counts[table]++;
      }
    }
    // Aggregate evidence only; authored content and tenant identifiers stay private.
    console.log(JSON.stringify({ migration: "0029_text-columns-blocks", converted: counts }));
  },
};
export default migration;
