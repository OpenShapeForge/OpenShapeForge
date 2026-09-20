// SPDX-License-Identifier: BUSL-1.1
/**
 * Where an authored entity lives, read from the generated manifest.
 *
 * The engine names entities, never tables: a migration that references the
 * Relation table, a login that creates a ContactDetail, a policy that reads
 * Tenant.tenantKind all ask the manifest which physical table and column the
 * compiler gave that entity and field. The answer comes from the same
 * artifact the schema was built from, so a renamed table or column moves
 * every caller at once and a misspelled entity fails at import time.
 *
 * This reads the raw manifest rather than the CRUD catalogue, because a
 * migration needs registry and domain-internal tables the catalogue hides.
 */
import manifest from "../generated/db/manifest.json" with { type: "json" };

export type ManifestColumn = {
  name: string;
  type: string;
  required?: boolean;
  primaryKey?: boolean;
  sourceField?: string;
};

export type ManifestTable = {
  /** `schema.table`, as SQL names it. */
  name: string;
  schema: string;
  table: string;
  tenantScoped: boolean;
  columns: readonly ManifestColumn[];
  source?: { authoringEntityName?: string };
};

const tables = (manifest as { tables: ManifestTable[] }).tables;

function fieldOf(column: ManifestColumn): string {
  return column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/** The manifest table of an authored entity; throws when the manifest has none. */
export function manifestTableForEntity(entityName: string): ManifestTable {
  const table = tables.find((candidate) => candidate.source?.authoringEntityName === entityName);
  if (!table) {
    throw new Error(`The generated manifest has no table for entity ${entityName}.`);
  }
  return table;
}

/** The `schema.table` name of an authored entity. */
export function entityTableName(entityName: string): string {
  return manifestTableForEntity(entityName).name;
}

/** The physical column an authored field is stored in; throws when the entity has no such field. */
export function entityColumnName(entityName: string, fieldKey: string): string {
  const table = manifestTableForEntity(entityName);
  const column = table.columns.find((candidate) => fieldOf(candidate) === fieldKey);
  if (!column) {
    throw new Error(`Entity ${entityName} stores no field ${fieldKey} (table ${table.name}).`);
  }
  return column.name;
}
