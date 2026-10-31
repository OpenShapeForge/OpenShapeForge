// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import manifest from "../../../generated/db/manifest.json" with { type: "json" };
import type { VersionedMigration } from "../versioned-runner.js";

type ManifestTable = { schema: string; table: string; columns: Array<{ name: string; type: string; required?: boolean }> };

/** Reconcile these existing relation columns only when the host composition
 * requires them. PostgreSQL verifies every row during SET NOT NULL, regardless
 * of RLS; an existing null aborts the enclosing migration transaction rather
 * than deleting, replacing or guessing at user data. Missing tables/columns
 * remain the generated schema step's responsibility.
 */
export async function requireComposedRelationColumns(db: Kysely<any>, tables: readonly ManifestTable[]): Promise<void> {
  for (const table of ["employees", "relation_group_memberships"] as const) {
    const declared = tables.find(t => t.schema === "erp" && t.table === table);
    if (!declared?.columns.some(c => c.name === "relation_id" && c.type === "uuid" && c.required === true)) continue;
    const column = (await sql<{ nullable: boolean; type: string }>`
      select not a.attnotnull as nullable, format_type(a.atttypid,a.atttypmod) as type
      from pg_attribute a where a.attrelid=to_regclass(${'erp.'+table}) and a.attname='relation_id'
        and a.attnum>0 and not a.attisdropped
    `.execute(db)).rows[0];
    if (!column || !column.nullable || column.type !== "uuid") continue;
    try {
      await sql.raw(`alter table "erp"."${table}" alter column "relation_id" set not null`).execute(db);
    } catch (error) {
      if ((error as {code?:unknown}).code === "23502") throw new Error(`erp.${table}.relation_id contains null values; no rows were changed.`, { cause: error });
      throw error;
    }
  }
}

const migration: VersionedMigration = {
  version: "0021_relation-required-columns",
  fileUrl: import.meta.url,
  async up(db) { await requireComposedRelationColumns(db, manifest.tables as ManifestTable[]); },
};
export default migration;
