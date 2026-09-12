// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import manifest from "../../../generated/db/manifest.json" with { type: "json" };
import type { VersionedMigration } from "../versioned-runner.js";

type GeneratedManifestTable = {
  schema: string;
  table: string;
};

/**
 * 0011_reconcile-generated-rls-policy-pairs
 *
 * Older generated schema SQL replaced a policy without dropping the other
 * compiler-owned policy variant. A table upgraded from tenant-only isolation
 * to row-scoped access could consequently retain both permissive policies;
 * Postgres OR-combines permissive policies, so the tenant-only predicate then
 * widened the intended row restriction.
 *
 * Reconcile only exact generated policy pairs on manifest-owned tables. The
 * row-scope policy is the safe canonical survivor when both names exist.
 * Single policies and every custom policy remain untouched. Fresh installs
 * have no tables yet at this phase and are a no-op; the generated schema that
 * follows creates the current policy directly.
 *
 * Applied migrations are immutable: platform.schema_migrations records the
 * sha256 of THIS FILE and re-verifies it on every migrate run. Once this
 * migration has been applied anywhere, do not edit it — transform forward in
 * a new migration instead.
 */
const migration: VersionedMigration = {
  version: "0011_reconcile-generated-rls-policy-pairs",
  fileUrl: import.meta.url,
  async up(db: Kysely<any>): Promise<void> {
    for (const table of manifest.tables as GeneratedManifestTable[]) {
      const rowScopePolicy = `${table.table}_row_scope`;
      const tenantIsolationPolicy = `${table.table}_tenant_isolation`;
      const live = await sql<{ policyname: string }>`
        select policyname
        from pg_policies
        where schemaname = ${table.schema}
          and tablename = ${table.table}
          and policyname in (${rowScopePolicy}, ${tenantIsolationPolicy})
      `.execute(db);
      const policyNames = new Set(live.rows.map(({ policyname }) => policyname));
      if (
        policyNames.has(rowScopePolicy) &&
        policyNames.has(tenantIsolationPolicy)
      ) {
        await sql`
          drop policy ${sql.id(tenantIsolationPolicy)}
          on ${sql.id(table.schema, table.table)}
        `.execute(db);
      }
    }
  },
};

export default migration;
