// SPDX-License-Identifier: BUSL-1.1
import { withAuditContext } from "../../platform/audit-context.js";
import type { DbSessionInput } from "../../db/session.js";
import { assertBoundFieldQueryAllowed } from "./field-bindings.js";
import { assertClassifiedQueryAllowed, assertElicitedQueryAllowed, generatedCrudError } from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

/** Apply the normal query access policy to a stored dependency. */
export function assertFieldReadable(table: GeneratedCrudTable, session: DbSessionInput, column: GeneratedCrudColumn) {
  const key = fieldNameForColumn(column);
  if (column.typedBy || table.source?.computedFields?.some(field => field.field === key)) {
    throw generatedCrudError("A stored, non-computed field is required.", "FORBIDDEN");
  }
  const input = { filter: { [key]: { eq: null } } };
  withAuditContext(`${table.source?.authoringEntityName}.list`, undefined, () => {
    assertClassifiedQueryAllowed(table, session, input, true);
    assertElicitedQueryAllowed(table, input, true);
    assertBoundFieldQueryAllowed(table, input, true);
  });
}
