// SPDX-License-Identifier: BUSL-1.1
import type { OperationError } from "@openshapeforge/operations";
import type { GeneratedCrudExposureOperation, GeneratedCrudTable } from "./types.js";
import { fieldNameForColumn } from "./columns.js";

export function collectionManagedFields(table: GeneratedCrudTable, tables: readonly GeneratedCrudTable[]): Set<string> {
  const fields = new Set<string>();
  for (const relationship of table.source?.graphql?.relationships ?? []) {
    if (relationship.fieldKey && relationship.resolve !== "belongsTo") fields.add(relationship.fieldKey);
  }
  for (const owner of tables) {
    for (const relationship of owner.source?.graphql?.relationships ?? []) {
      if (!relationship.fieldKey || relationship.resolve === "belongsTo" ||
        relationship.target !== table.source?.graphql?.typeName || relationship.via ||
        relationship.ownership !== "owned") continue;
      for (const name of [relationship.foreignKey, relationship.positionColumn]) {
        const column = table.columns.find((column) => column.name === name);
        if (column) { fields.add(column.name); fields.add(fieldNameForColumn(column)); }
      }
    }
  }
  return fields;
}

/** No collection mutation is advertised until parent/child permissions and cardinality are atomic. */
export function collectionMutationError(
  table: GeneratedCrudTable,
  operation: GeneratedCrudExposureOperation,
  tables: readonly GeneratedCrudTable[],
  values: Readonly<Record<string, unknown>> = {},
): OperationError | undefined {
  if (operation === "get" || operation === "list") return undefined;
  const collections = (table.source?.graphql?.relationships ?? []).filter((relationship) => relationship.fieldKey && relationship.resolve !== "belongsTo");
  const managed = collectionManagedFields(table, tables);
  const explicit = Object.keys(values).find((field) => managed.has(field));
  const required = operation === "create" && (
    collections.some((relationship) => typeof relationship.cardinality === "object" && (relationship.cardinality.min ?? 0) > 0) ||
    table.columns.some((column) => column.required && managed.has(column.name))
  );
  // Deleting an owned child generically is always refused; deleting an
  // OWNER is refused only while owned children exist, which is a row-level
  // check the delete makes inside its transaction (ownedChildrenExist).
  const affectsCollection = operation === "delete" &&
    tables.some((owner) => owner.source?.graphql?.relationships?.some((relationship) =>
      relationship.fieldKey && relationship.resolve !== "belongsTo" &&
      relationship.target === table.source?.graphql?.typeName && relationship.ownership === "owned"));
  if (!explicit && !required && !affectsCollection) return undefined;
  return {
    code: "RELATION_COLLECTION_MUTATION_UNSUPPORTED",
    message: `Collection mutation${explicit ? ` of ${explicit}` : ""} is not supported by generic ${operation}; an atomic collection Operation is required.`,
    retryable: false,
  };
}

/** The owned collections of `table`: the child table and the child column that points back at the owner. */
export function ownedCollectionsOf(
  table: GeneratedCrudTable,
  tables: readonly GeneratedCrudTable[],
): Array<{ key: string; child: GeneratedCrudTable; column: string }> {
  const owned: Array<{ key: string; child: GeneratedCrudTable; column: string }> = [];
  for (const relationship of table.source?.graphql?.relationships ?? []) {
    if (!relationship.fieldKey || relationship.resolve === "belongsTo" || relationship.ownership !== "owned" || !relationship.foreignKey || relationship.via) continue;
    const child = tables.find((candidate) => candidate.source?.graphql?.typeName === relationship.target);
    if (child) owned.push({ key: relationship.fieldKey, child, column: relationship.foreignKey });
  }
  return owned;
}

/** Remove unsupported values from transport schemas without changing the authored contract. */
export function withoutCollectionInputs(schema: Record<string, unknown>, fields: ReadonlySet<string>): Record<string, unknown> {
  if (fields.size === 0) return schema;
  const projected = { ...schema };
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    projected.properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !fields.has(key)).map(([key, value]) => [
      key, key === "values" && value && typeof value === "object" && !Array.isArray(value)
        ? withoutCollectionInputs(value as Record<string, unknown>, fields) : value,
    ]));
  }
  if (Array.isArray(schema.required)) projected.required = schema.required.filter((key) => typeof key !== "string" || !fields.has(key));
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) projected[key] = schema[key].map((entry) => entry && typeof entry === "object" ? withoutCollectionInputs(entry, fields) : entry);
  }
  return projected;
}
