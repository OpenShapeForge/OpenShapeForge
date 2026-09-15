// SPDX-License-Identifier: BUSL-1.1
import { fieldNameForColumn } from "./columns.js";
import { entityValuePhysicalColumns } from "./entity-value-io.js";
import { generatedEntityValues } from "../../modules/entity-value-registry.js";
import type {
  EntityOperationResult,
  GeneratedCrudColumn,
  GeneratedCrudTable,
  GeneratedEntityRow,
} from "./types.js";

const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const POSTGRES_BIGINT_TEXT = /^-?(?:0|[1-9][0-9]*)$/;

function safeJsonInteger(column: GeneratedCrudColumn, value: unknown): unknown {
  if (column.type !== "bigint") return value;
  if (typeof value === "bigint") {
    return value >= MIN_SAFE_INTEGER && value <= MAX_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  if (typeof value !== "string" || value.length > 20 || !POSTGRES_BIGINT_TEXT.test(value)) {
    return value;
  }
  const integer = BigInt(value);
  return integer >= MIN_SAFE_INTEGER && integer <= MAX_SAFE_INTEGER ? Number(integer) : value;
}

/** Normalize exact PostgreSQL bigint values only when JSON can represent them losslessly. */
export function normalizeEntityStorageRow(
  table: GeneratedCrudTable,
  row: GeneratedEntityRow,
): GeneratedEntityRow {
  let normalized = row;
  for (const column of table.columns) {
    if (column.type !== "bigint" || !Object.hasOwn(row, column.name)) continue;
    const value = safeJsonInteger(column, row[column.name]);
    if (value === row[column.name]) continue;
    if (normalized === row) normalized = { ...row };
    normalized[column.name] = value;
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
