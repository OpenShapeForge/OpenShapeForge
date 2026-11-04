// SPDX-License-Identifier: BUSL-1.1
/**
 * The authored columns a tenant formula may read: a scalar the typed index
 * can hold, never classified, field-policed, typed by a stored definition or
 * a document, never written outside the record's own write, and named by the
 * entity's read contract with a type that is not a reference (related
 * records are a lookup's business). The formula environment is built from
 * exactly this list (formulas.ts), the backfill reads exactly this list
 * (write.ts `formulaRowObject`), and the worker's column grants are exactly
 * this list (db/migrations/worker-role.ts), so a formula backfill reads what
 * a formula may read and nothing more. No imports beyond types and generated
 * JSON: the migration chain loads it.
 */
import rawCatalog from "../../../generated/operations/catalog.json" with { type: "json" };
import fieldSchemaRegistry from "../../../generated/operations/field-schema-registry.json" with { type: "json" };
import type { EntityOperationContract, GeneratedCrudColumn, GeneratedCrudTable } from "../types.js";

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

/**
 * A published-snapshot head's lifecycle and version pointers. They are
 * `writtenBy` the publish Operation, and named here as well so that no
 * authoring of that metadata can make them a formula input: publishing
 * changes them without a write of the record, so a formula over them would
 * be stale, and a recompute would put the head back to draft.
 */
const VERSIONING_COLUMN = /^(lifecycle_status|(latest|published)_version(_id)?)$/;

type FormulaColumnTable = Pick<GeneratedCrudTable, "columns"> & { source?: Pick<NonNullable<GeneratedCrudTable["source"]>, "authoringEntityName" | "versioning"> };

/** The field name of a column, as columns.ts `fieldNameForColumn` derives it. */
const fieldName = (column: GeneratedCrudColumn) =>
  column.sourceField ?? column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

/**
 * Why a formula may not read an authored column of the read contract, for
 * the columns that would otherwise qualify: changed outside the record's own
 * write. Undefined for a column that is no input for any other reason, or none.
 */
export function outOfFormulaScope(table: FormulaColumnTable, column: GeneratedCrudColumn): string | undefined {
  const draftField = table.source?.versioning?.onEdit.field;
  if (SERVER_COLUMNS.has(column.name)) return "it is kept by the platform, not by the record's own write";
  if (VERSIONING_COLUMN.test(column.name) || (draftField !== undefined && fieldName(column) === draftField)) {
    return "it is the publication state, which publishing changes without a write of the record";
  }
  if (column.writtenBy?.length) return `only ${column.writtenBy.map((writer) => writer.operation).join(", ")} writes it, outside the record's own write`;
  return undefined;
}

const entityOperations = (rawCatalog as unknown as { entityOperations: EntityOperationContract[] }).entityOperations;
const osfTypes = fieldSchemaRegistry.osfTypes as Record<string, { kind?: string }>;

/** The record properties the entity's read contract names, with their labels and osfTypes. */
export function readContractProperties(entity: string): Record<string, unknown> {
  for (const intent of ["get", "list"]) {
    const schema = entityOperations.find((operation) => operation.entityName === entity && operation.intent === intent)?.outputSchema;
    const candidates = [schema, ...(Array.isArray(schema?.anyOf) ? schema.anyOf : [])];
    const found = candidates.find((candidate) => isRecord(candidate) && isRecord(candidate.properties));
    if (found) return (found as { properties: Record<string, unknown> }).properties;
  }
  return {};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The read-contract property of a column a formula could read, from column metadata and the contract alone. */
function contractProperty(table: FormulaColumnTable, column: GeneratedCrudColumn, properties: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!SCALAR_COLUMN_TYPES.has(column.type) || column.classification || column.fieldPolicy || column.typedBy || column.document) return undefined;
  const property = properties[fieldName(column)];
  if (!isRecord(property)) return undefined;
  // A foreign key reads as its target entity: a reference, never a formula input.
  const osfType = property["x-osf-type"];
  if (typeof osfType === "string" && osfTypes[osfType]?.kind === "entity") return undefined;
  return property;
}

const cache = new WeakMap<FormulaColumnTable, readonly GeneratedCrudColumn[]>();

export function formulaColumns(table: FormulaColumnTable): readonly GeneratedCrudColumn[] {
  const cached = cache.get(table);
  if (cached) return cached;
  const properties = readContractProperties(table.source?.authoringEntityName ?? "");
  const columns = Object.freeze(table.columns.filter((column) =>
    contractProperty(table, column, properties) !== undefined && outOfFormulaScope(table, column) === undefined));
  cache.set(table, columns);
  return columns;
}

/** The columns of the read contract a formula may not read, each with the reason (formulas.ts refuses them as outOfScope). */
export function outOfScopeFormulaColumns(table: FormulaColumnTable): Array<{ column: GeneratedCrudColumn; reason: string }> {
  const properties = readContractProperties(table.source?.authoringEntityName ?? "");
  return table.columns.flatMap((column) => {
    if (column.name === "tenant_id" || column.name === "extension_values") return [];
    const reason = contractProperty(table, column, properties) ? outOfFormulaScope(table, column) : undefined;
    return reason ? [{ column, reason }] : [];
  });
}
