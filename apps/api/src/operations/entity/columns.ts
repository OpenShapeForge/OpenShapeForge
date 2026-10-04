// SPDX-License-Identifier: BUSL-1.1
import { sql, type RawBuilder } from "kysely";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";
import { entityValuePhysicalColumns } from "./entity-value-io.js";

export function fieldNameForColumn(column: GeneratedCrudColumn) {
  return column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export function fieldColumnMap(table: GeneratedCrudTable) {
  const hidden = entityValuePhysicalColumns(table);
  return new Map(table.columns.filter((column) => !hidden.has(column.name)).map((column) => [fieldNameForColumn(column), column]));
}

export function tableColumnMap(table: GeneratedCrudTable) {
  return new Map(table.columns.map((column) => [column.name, column]));
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `<primary key> = id` that leaves the key column uncast, so the primary-key
 * index applies. A uuid key renders as canonical lowercase text only, so any
 * other id matched nothing under the text comparison; it still matches
 * nothing here instead of failing the uuid cast.
 */
export function primaryKeyEquals(
  table: GeneratedCrudTable,
  id: unknown,
  alias?: string,
): RawBuilder<unknown> {
  const primaryKey = table.primaryKey!;
  const column = alias ? sql.id(alias, primaryKey) : sql.id(primaryKey);
  if (table.columns.find((candidate) => candidate.name === primaryKey)?.type !== "uuid") {
    return sql`${column}::text = ${id}`;
  }
  return typeof id === "string" && CANONICAL_UUID.test(id) ? sql`${column} = ${id}::uuid` : sql`false`;
}
