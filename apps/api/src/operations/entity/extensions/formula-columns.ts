// SPDX-License-Identifier: BUSL-1.1
/**
 * The authored columns a tenant formula may read, from column metadata alone:
 * a scalar the typed index can hold, never classified, field-policed, typed
 * by a stored definition or a document. The formula environment narrows this
 * further to the fields the entity's read contract names (formulas.ts); the
 * worker's column grants (db/migrations/worker-role.ts) are exactly this
 * list, so a formula backfill reads what a formula may read and nothing more.
 * No imports beyond types: the migration chain loads it.
 */
import type { GeneratedCrudColumn, GeneratedCrudTable } from "../types.js";

const SCALAR_COLUMN_TYPES = new Set([
  "text", "varchar", "numeric", "integer", "bigint", "smallint", "real", "double precision",
  "boolean", "date", "timestamptz", "timestamp", "uuid",
]);

/**
 * Never a formula input: the tenant, the tenant field source itself, and the
 * write clock — a formula over `updatedAt` would be stale the moment its own
 * result was written (the same reason time functions are refused).
 */
const SERVER_COLUMNS = new Set(["tenant_id", "extension_values", "updated_at"]);

export function formulaColumns(table: Pick<GeneratedCrudTable, "columns">): GeneratedCrudColumn[] {
  return table.columns.filter((column) => SCALAR_COLUMN_TYPES.has(column.type) && !SERVER_COLUMNS.has(column.name) &&
    !column.classification && !column.fieldPolicy && !column.typedBy && !column.document);
}
