// SPDX-License-Identifier: BUSL-1.1
import { fieldNameForColumn } from "../operations/entity/columns.js";
import type {
  GeneratedCrudTable,
  GeneratedEntityRow,
} from "../operations/entity/types.js";

/**
 * Serialize only fields declared by the compiled entity contract.
 *
 * Stored columns are mapped to their authored field names. Computed fields
 * are already projected and authorized by the shared entity operation
 * runtime, so transports preserve those declared outputs without exposing
 * unrelated runtime values that may also be present on a row object.
 */
export function serializeGeneratedRestRow(
  table: GeneratedCrudTable,
  row: GeneratedEntityRow,
): Record<string, unknown> {
  const serialized = Object.fromEntries(
    table.columns.map((column) => [fieldNameForColumn(column), row[column.name]]),
  );

  for (const computedField of table.source?.computedFields ?? []) {
    serialized[computedField.field] = row[computedField.field];
  }

  return serialized;
}
