// SPDX-License-Identifier: BUSL-1.1
import { fieldNameForColumn } from "./columns.js";
import { entityValuePhysicalColumns } from "./entity-value-io.js";
import { generatedEntityValues } from "../../modules/entity-value-registry.js";
import { decimalText } from "@openshapeforge/operations";
import type {
  EntityOperationResult,
  GeneratedCrudTable,
  GeneratedEntityRow,
} from "./types.js";

/**
 * The wire text of every numeric and bigint column: a JSON number would round
 * money and 64-bit counters, so both cross as decimal strings, as the scalar
 * table (@openshapeforge/operations) declares them and the record schemas
 * say. The driver already hands them over as text; a handler or a fixture
 * that produced a number or a bigint is printed exactly.
 */
export function normalizeEntityStorageRow(
  table: GeneratedCrudTable,
  row: GeneratedEntityRow,
): GeneratedEntityRow {
  let normalized = row;
  for (const column of table.columns) {
    if ((column.type !== "bigint" && column.type !== "numeric") || !Object.hasOwn(row, column.name)) continue;
    const value = row[column.name];
    const text = value === null || value === undefined ? value : decimalText(value);
    if (text === value) continue;
    if (normalized === row) normalized = { ...row };
    normalized[column.name] = text;
  }
  return normalized;
}

/** Shared authored-field projection for every public entity result boundary. */
export function serializeEntityRow(
  table: GeneratedCrudTable,
  row: GeneratedEntityRow,
  entityValues = generatedEntityValues,
): Record<string, unknown> {
  const normalized = normalizeEntityStorageRow(table, row);
  const hidden = entityValuePhysicalColumns(table, entityValues);
  const result = Object.fromEntries(
    table.columns.filter((column) => !hidden.has(column.name)).map((column) => [fieldNameForColumn(column), normalized[column.name]]),
  );
  for (const field of table.source?.computedFields ?? []) result[field.field] = row[field.field];
  return result;
}

/** Keep offers, failures and pagination intact; never expose undeclared row data. */
export function serializeEntityResult(
  table: GeneratedCrudTable,
  result: EntityOperationResult,
): EntityOperationResult {
  if ("error" in result || result.intent === "delete") return result;
  if (result.intent === "list")
    return {
      ...result,
      data: {
        ...result.data,
        items: result.data.items.map((item) => ({
          ...item,
          data: serializeEntityRow(table, item.data),
        })),
      },
    };
  return { ...result, data: result.data === null ? null : serializeEntityRow(table, result.data) };
}
