// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeEntityValueCarrier, RuntimeEntityValueRegistry } from "@openshapeforge/plugin-runtime";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionInput } from "../../db/session.js";
import { generatedEntityValues } from "../../modules/entity-value-registry.js";
import { projectEntityValue, splitEntityValueInput } from "../../modules/entity-value-input.js";
import { runtimeJsonSchemas } from "../../modules/field-schemas.js";
import fieldSchemaRegistry from "../../generated/operations/field-schema-registry.json" with { type: "json" };
import { fieldNameForColumn } from "./columns.js";
import { generatedCrudError, getGeneratedCrudTables, isGeneratedCrudOperationEnabled, requireEntityOperation } from "./catalog.js";
import { assertRecordPermissionInTransaction } from "./record-permissions.js";
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

/** Server-owned injection only; never accepted in a request body. */
export type EntityValueIOContext = { registry?: RuntimeEntityValueRegistry; tables?: readonly GeneratedCrudTable[] };

/** Same unsupported policies as the compiler, including inherited/nested fields. */
export function assertEntityValueFieldPolicy(
  field: Readonly<Record<string, unknown>>,
  semanticTypes: Readonly<Record<string, unknown>> = fieldSchemaRegistry.semanticTypes,
  depth = 0,
): void {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const invalid = (): never => { throw generatedCrudError("Guarded or malformed entity-value fields require a dedicated adapter.", "INVALID_DEFINITION"); };
  if (!record(field) || depth > 32) invalid();
  if (field.semanticType !== undefined && typeof field.semanticType !== "string") invalid();
  const semantic = typeof field.semanticType === "string" && Object.hasOwn(semanticTypes, field.semanticType) ? semanticTypes[field.semanticType] : undefined;
  if (typeof field.semanticType === "string" && semantic === undefined) invalid();
  if (semantic !== undefined && !record(semantic)) invalid();
  if (depth > 0 && (field.relationship !== undefined || record(semantic) && semantic.kind === "entity")) invalid();
  for (const key of ["classification", "authorization", "permissions", "writtenBy", "secureInput", "immutable"]) {
    const authored = field[key], inherited = record(semantic) ? semantic[key] : undefined;
    if (key === "immutable" ? authored === true || inherited === true : authored !== undefined || inherited !== undefined) invalid();
  }
  // The target shape of an entity reference is not embedded content. Its record
  // permissions are checked against the real referenced row in the transaction.
  for (const node of [field, ...(record(semantic) && semantic.kind !== "entity" ? [semantic] : [])]) {
    for (const key of ["children", "shape"]) {
      if (node[key] === undefined) continue;
      if (!Array.isArray(node[key])) invalid();
      for (const child of node[key] as unknown[]) {
        if (!record(child)) invalid();
        assertEntityValueFieldPolicy(child as Record<string, unknown>, semanticTypes, depth + 1);
      }
    }
    if (node.item !== undefined) {
      if (!record(node.item)) invalid();
      assertEntityValueFieldPolicy(node.item as Record<string, unknown>, semanticTypes, depth + 1);
    }
  }
}

export function entityValueCarriers(table: GeneratedCrudTable, registry = generatedEntityValues): RuntimeEntityValueCarrier[] {
  const carriers = table.columns.flatMap((column) => {
    const carrier = registry.get(table.source?.authoringEntityName ?? "", fieldNameForColumn(column));
    return carrier ? [carrier] : [];
  });
  for (const carrier of carriers) {
    const definition = table.columns.find((column) => column.name === carrier.definitionColumn);
    if (carrier.schema !== table.schema || carrier.table !== table.table || !definition || fieldNameForColumn(definition) !== carrier.definitionField ||
        !table.columns.some((column) => column.name === carrier.valuesColumn && column.type === "jsonb" && fieldNameForColumn(column) === carrier.fieldKey)) {
      throw generatedCrudError("Entity-value carrier metadata does not match its table.", "INVALID_DEFINITION");
    }
    const protectedColumns = new Set([carrier.valuesColumn, carrier.definitionColumn, table.primaryKey, "tenant_id", "created_at", "updated_at"]);
    for (const descriptor of Object.values(carrier.definitions)) {
      // Older or malformed registries must not reintroduce policies the normal
      // entity field runtime cannot enforce inside a dynamic JSON object.
      for (const field of descriptor.fields) assertEntityValueFieldPolicy(field);
      for (const reference of descriptor.references) {
        const physical = table.columns.find((column) => column.name === reference.column);
        if (!physical || physical.type !== "uuid" || physical.sourceField || physical.immutable || physical.writtenBy?.length || protectedColumns.has(physical.name)) {
          throw generatedCrudError("Entity-value reference storage metadata is invalid.", "INVALID_DEFINITION");
        }
      }
    }
  }
  return carriers;
}

export function entityValuePhysicalColumns(table: GeneratedCrudTable, registry = generatedEntityValues): Set<string> {
  return new Set(entityValueCarriers(table, registry).flatMap((carrier) => Object.values(carrier.definitions).flatMap((definition) => definition.references.map((reference) => reference.column))));
}

/** Called before normalization, so protected inputs cannot be silently discarded. */
export function assertEntityValueInput(table: GeneratedCrudTable, input: Record<string, unknown>, operation: "create" | "update", registry = generatedEntityValues): void {
  for (const name of entityValuePhysicalColumns(table, registry)) {
    const column = table.columns.find((column) => column.name === name)!;
    if (Object.hasOwn(input, name) || Object.hasOwn(input, fieldNameForColumn(column))) throw generatedCrudError("Physical entity-value columns are server-owned.", "BAD_USER_INPUT");
  }
  for (const carrier of entityValueCarriers(table, registry)) {
    if (carrier.valuesColumn !== carrier.fieldKey && Object.hasOwn(input, carrier.valuesColumn)) throw generatedCrudError("Use the logical entity-value field.", "BAD_USER_INPUT");
    if (carrier.definitionColumn !== carrier.definitionField && Object.hasOwn(input, carrier.definitionColumn)) throw generatedCrudError("Use the logical definition field.", "BAD_USER_INPUT");
    if (operation === "update" && Object.hasOwn(input, carrier.definitionField)) throw generatedCrudError("The entity-value definition is immutable.", "BAD_USER_INPUT");
  }
}

/** Validate and authorize every reference while holding its row against edits/deletes. */
export async function prepareEntityValueWriteInTransaction(
  trx: Transaction<DB>, session: DbSessionInput, table: GeneratedCrudTable,
  values: ReadonlyMap<GeneratedCrudColumn, unknown>, operation: "create" | "update",
  current: GeneratedEntityRow | undefined, context: EntityValueIOContext = {},
): Promise<Map<GeneratedCrudColumn, unknown>> {
  const result = new Map(values);
  const references: Array<{ entityName: string; id: string; schema: string; table: string }> = [];
  for (const carrier of entityValueCarriers(table, context.registry)) {
    const valueColumn = table.columns.find((column) => column.name === carrier.valuesColumn)!;
    const definitionColumn = table.columns.find((column) => column.name === carrier.definitionColumn)!;
    if (operation === "update" && !values.has(valueColumn)) continue;
    if (operation === "update" && !current) throw generatedCrudError("Entity-value updates require a locked current row.", "INTERNAL_SERVER_ERROR");
    const key = operation === "create" ? values.get(definitionColumn) : current![carrier.definitionColumn];
    const split = splitEntityValueInput(carrier, key, values.get(valueColumn), runtimeJsonSchemas);
    result.set(valueColumn, split.values);
    for (const [name, value] of Object.entries(split.columns)) result.set(table.columns.find((column) => column.name === name)!, value);
    const definition = carrier.definitions[String(key)]!;
    for (const reference of split.references) {
      const descriptor = definition.references.find((item) => item.fieldKey === reference.fieldKey)!;
      references.push({ ...reference, schema: descriptor.schema, table: descriptor.table });
    }
  }
  // Stable order bounds ordinary multi-reference deadlocks. The DB remains the
  // final integrity boundary, including the generated tenant-composite FK.
  references.sort((a, b) => a.entityName.localeCompare(b.entityName) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.entityName}/${reference.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const targets = (context.tables ?? getGeneratedCrudTables()).filter((candidate) => candidate.source?.authoringEntityName === reference.entityName);
    const target = targets.length === 1 ? targets[0] : undefined;
    if (!target || target.schema !== reference.schema || target.table !== reference.table || target.primaryKey !== "id" || !target.tenantScoped || !table.tenantScoped) throw generatedCrudError("A tenant-scoped reference target is required.", "INVALID_DEFINITION");
    requireEntityOperation(target, isGeneratedCrudOperationEnabled(target, "get") ? "get" : "list", session);
    const visible = await sql<{ id: string }>`select id from ${sql.id(target.schema, target.table)}
      where id=${reference.id}::uuid and tenant_id=${session.tenantId}::uuid for share`.execute(trx);
    if (!visible.rows.length) throw generatedCrudError("A referenced record is unavailable.", "FORBIDDEN");
    if (target.source?.authorization?.recordPermissions) await assertRecordPermissionInTransaction(trx, session, target, reference.id, "view");
  }
  return result;
}

/** Projection is deliberately before classification redaction, never after it. */
export function projectEntityValueRow(table: GeneratedCrudTable, row: GeneratedEntityRow, registry = generatedEntityValues): GeneratedEntityRow {
  const carriers = entityValueCarriers(table, registry);
  if (!carriers.length) return row;
  const result = { ...row };
  for (const carrier of carriers) {
    const logical = projectEntityValue(carrier, row);
    result[carrier.valuesColumn] = logical;
  }
  for (const name of entityValuePhysicalColumns(table, registry)) delete result[name];
  return result;
}
