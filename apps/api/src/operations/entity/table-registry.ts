// SPDX-License-Identifier: BUSL-1.1
/** Pure manifest registry; safe to use while canonical contracts are being initialized. */
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { GeneratedCrudTable } from "./types.js";
export function isGeneratedCrudTableEligible(table: GeneratedCrudTable): boolean {
  return !table.domainInternal && table.generatedCrudEligible === true;
}

const physicalTables = manifest.tables as GeneratedCrudTable[];
const subtypeTables = ((manifest as { entitySubtypes?: GeneratedCrudTable[] }).entitySubtypes ?? []);

/**
 * A subtype projection is served only when its binding is sound: it names a
 * served base table, its discriminator and hidden columns are columns of that
 * table, and it offers nothing the base does not store. Anything else is a
 * stale or forged manifest and fails at import rather than at the first call.
 */
function assertSubtypeTable(table: GeneratedCrudTable): void {
  const binding = table.subtype;
  if (!binding) throw new Error(`Manifest entitySubtypes entry ${table.name} carries no subtype binding.`);
  const base = physicalTables.find((candidate) => candidate.name === binding.base.table);
  if (!base || base.source?.authoringEntityName !== binding.base.entityName || base.schema !== table.schema || base.table !== table.table) {
    throw new Error(`Subtype ${table.name} is bound to ${binding.base.table}, which the manifest does not serve as ${binding.base.entityName}.`);
  }
  if (physicalTables.some((candidate) => candidate.name === table.name) || table.name === base.name) {
    throw new Error(`Subtype ${table.name} collides with a physical table name.`);
  }
  const baseColumns = new Set(base.columns.map((column) => column.name));
  for (const scope of binding.scope) {
    if (!baseColumns.has(scope.column)) throw new Error(`Subtype ${table.name} scopes on ${scope.column}, which ${base.name} does not store.`);
  }
  for (const hidden of binding.hiddenColumns) {
    if (!baseColumns.has(hidden.column)) throw new Error(`Subtype ${table.name} hides ${hidden.column}, which ${base.name} does not store.`);
    if (table.columns.some((column) => column.name === hidden.column)) throw new Error(`Subtype ${table.name} both serves and hides ${hidden.column}.`);
  }
  for (const column of table.columns) {
    if (!baseColumns.has(column.name)) throw new Error(`Subtype ${table.name} serves ${column.name}, which ${base.name} does not store.`);
  }
}
for (const table of subtypeTables) assertSubtypeTable(table);

export const generatedCrudTables = new Map(
  [...physicalTables, ...subtypeTables]
    .filter((table) => isGeneratedCrudTableEligible(table) && table.primaryKey)
    .map((table) => [table.name, table]),
);
export function getGeneratedCrudTables(): GeneratedCrudTable[] { return [...generatedCrudTables.values()]; }

/**
 * Physical tables that declare a named record action, by AUTHORED entity name.
 *
 * Deliberately a separate registry from `generatedCrudTables`. A named action
 * is not an Entity Operation: it has no intent, it never consults the entity's
 * CRUD roles, and it must stay reachable on an entity whose generated CRUD is
 * switched off entirely — which is exactly the shape an entity acted on only
 * by an application takes. Subtype projections are absent by construction:
 * they share the base row, and the action lookup is keyed on the base entity.
 *
 * Same source as the migration's own registry
 * (`db/migrations/record-actions.ts`), so an entity the SQL lookup does not
 * know is an entity this cannot name either.
 */
export const recordActionTables = new Map(
  physicalTables
    .filter((table) =>
      table.primaryKey &&
      typeof table.source?.authoringEntityName === "string" &&
      (table.source?.authorization?.recordPermissions?.actions?.length ?? 0) > 0)
    .map((table) => [table.source!.authoringEntityName!, table]),
);

export function recordActionTable(entityName: string): GeneratedCrudTable | undefined {
  return recordActionTables.get(entityName);
}
