// SPDX-License-Identifier: BUSL-1.1
import { FIELD_BINDINGS_COLUMN, fieldBindingMap, operationFailure } from "@openshapeforge/operations";
import type { DbSessionInput } from "../../db/session.js";
import { canReadClassifiedColumns } from "./classification.js";
import { fieldNameForColumn } from "./columns.js";
import { columnFieldPolicy, hasUnreadableField } from "./field-policy.js";
import type { GeneratedCrudColumn, GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

/** A source must be readable before resolution; a redacted null is not a value. */
export function bindingColumnReadable(table: GeneratedCrudTable, column: GeneratedCrudColumn, session: DbSessionInput): boolean {
  const elicited = table.source?.secureInputOnCreate?.into ?? table.source?.mcp?.elicitOnCreate?.into;
  return fieldNameForColumn(column) !== elicited &&
    !hasUnreadableField(columnFieldPolicy(column), session, canReadClassifiedColumns(table.source?.authorization, session));
}

/** A hidden destination also withholds its authored template and source reference. */
export function projectVisibleFieldBindings(table: GeneratedCrudTable, session: DbSessionInput, row: GeneratedEntityRow): GeneratedEntityRow {
  const column = table.columns.find((candidate) => candidate.fieldBindings);
  if (!column || !Object.hasOwn(row, column.name) || row[column.name] === null) return row;
  const bindings = fieldBindingMap(row[column.name]);
  if (column.name !== FIELD_BINDINGS_COLUMN || !bindings) {
    throw operationFailure({ code: "INVALID_DEFINITION", message: "The stored field bindings are not valid.", retryable: false });
  }
  const visible = Object.entries(bindings).filter(([field]) => {
    const declaration = column.fieldBindings!.fields.find((candidate) => candidate.field === field);
    const destination = declaration && table.columns.find((candidate) => candidate.name === declaration.column);
    if (!destination) throw operationFailure({ code: "INVALID_DEFINITION", message: "The stored field bindings do not match their table.", retryable: false });
    return bindingColumnReadable(table, destination, session);
  });
  return { ...row, [column.name]: visible.length ? Object.fromEntries(visible) : null };
}
