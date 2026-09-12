// SPDX-License-Identifier: BUSL-1.1
import { fieldNameForColumn } from "./columns.js";
import type { EntityOperationResult, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

/** Shared authored-field projection for every public entity result boundary. */
export function serializeEntityRow(table: GeneratedCrudTable, row: GeneratedEntityRow): Record<string, unknown> {
  const result = Object.fromEntries(table.columns.map((column) => [fieldNameForColumn(column), row[column.name]]));
  for (const field of table.source?.computedFields ?? []) result[field.field] = row[field.field];
  return result;
}

/** Keep offers, failures and pagination intact; never expose undeclared row data. */
export function serializeEntityResult(table: GeneratedCrudTable, result: EntityOperationResult): EntityOperationResult {
  if ("error" in result || result.intent === "delete") return result;
  if (result.intent === "list") return { ...result, data: { ...result.data,
    items: result.data.items.map((item) => ({ ...item, data: serializeEntityRow(table, item.data) })),
  } };
  return { ...result, data: result.data === null ? null : serializeEntityRow(table, result.data) };
}
