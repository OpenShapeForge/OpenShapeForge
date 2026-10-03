// SPDX-License-Identifier: BUSL-1.1
/**
 * Runtime function-level and field-level authorization for generated entities.
 *
 * The compiler carries each entity's per-operation role lists and per-column
 * data-classification into the runtime manifest (see
 * packages/compiler/src/generate.ts + backend-manifest.ts). This module is the
 * hand-written engine that CONSUMES that metadata:
 *
 *   - `assertOperationAllowed` — fail-closed function-level authorization
 *     (issue #94). A caller must hold at least one role listed for the
 *     operation it invokes (read/create/update/delete). Missing metadata or a
 *     non-intersecting role set is a FORBIDDEN error thrown BEFORE the DB call.
 *     Called by the generated GraphQL resolvers; the CRUD core enforces the
 *     same rule independently in requireEntityOperation.
 *
 *   - `redactRow` / `canReadClassifiedColumns` — field-level data protection
 *     (issues #96/#101). Columns classified pii/bsn/confidential are redacted
 *     (set to null) for readers who lack a write grant on the entity. Holding a
 *     write role (any of create/update/delete's roles — the "ReadWrite" tier)
 *     is what authorizes reading sensitive columns; a read-only grant sees the
 *     row with sensitive columns nulled out.
 *
 *   - `assertClassifiedQueryFieldsAllowed` — the companion oracle guard: a
 *     reader who cannot see a classified value must not be able to recover it
 *     by filtering or sorting on it.
 *
 * The two classification controls are invoked from the shared generated CRUD
 * core (generated-crud.ts), not from a transport, so GraphQL, REST and any
 * future transport inherit them by construction (issue #164).
 *
 * Tenant/row RLS is enforced independently at the DB layer; this is the
 * declared operation/field permission model layered on top.
 */
import { operationFailure } from "@openshapeforge/operations";
import { columnFieldPolicy, hasUnreadableField, redactFieldValue } from "../operations/entity/field-policy.js";
import { canReadClassifiedColumns } from "../operations/entity/classification.js";
export { canReadClassifiedColumns } from "../operations/entity/classification.js";
import type {
  GeneratedCrudAuthorization,
  GeneratedCrudOperation,
} from "./generated-crud.js";

type Column = {
  name: string;
  classification?: "confidential" | "pii" | "bsn";
  sourceField?: string;
  fieldPolicy?: import("@openshapeforge/operations").FieldValuePolicy;
};

type QuerySort = { field?: string | null; direction?: string | null } | null | undefined;

// `readonly` because callers pass session objects assembled from immutable
// resolved-identity data (DbSessionInput.roles); nothing here mutates.
type AuthzSession = {
  roles?: readonly string[] | null;
} | null | undefined;

function intersects(granted: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0) return false;
  const grantedSet = new Set(granted);
  return required.some((role) => grantedSet.has(role));
}

function fieldNameForColumn(column: Column): string {
  return column.sourceField ?? column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function classifiedColumnForFilterField(
  columns: readonly Column[],
  field: string,
): Column | undefined {
  const filterField = field.endsWith("In") ? field.slice(0, -2) : field;
  return columns.find((column) => fieldNameForColumn(column) === filterField);
}

function classifiedColumnForSortField(
  columns: readonly Column[],
  field: string,
): Column | undefined {
  // Sort names are always direct field names; unlike filter keys, a trailing
  // `In` has no alias meaning and must never be stripped.
  return columns.find((column) => fieldNameForColumn(column) === field);
}

/**
 * Fail-closed function-level authorization. Throws FORBIDDEN when the entity
 * declares no authorization metadata (an entity reaching the runtime without
 * compiled roles is a configuration error, denied by default) or when the
 * session holds none of the roles required for `operation`.
 */
export function assertOperationAllowed(
  authorization: GeneratedCrudAuthorization | undefined,
  session: AuthzSession,
  operation: GeneratedCrudOperation,
  typeName: string,
): void {
  const required = authorization?.roles?.[operation];
  if (!required || required.length === 0) {
    throw operationFailure({
      code: "FORBIDDEN",
      message: `Not authorized: ${typeName} declares no roles for "${operation}"; access is denied by default.`,
    });
  }
  const granted = session?.roles ?? [];
  if (!intersects(granted, required)) {
    throw operationFailure({
      code: "FORBIDDEN",
      message: `Not authorized to ${operation} ${typeName}.`,
    });
  }
}

/**
 * Prevent a reader who cannot see classified values from using them as an
 * oracle through list filters or ordering. Unknown fields are intentionally
 * ignored here so the existing generated CRUD validation can continue to
 * report BAD_USER_INPUT for them.
 */
export function assertClassifiedQueryFieldsAllowed(
  columns: readonly Column[],
  authorization: GeneratedCrudAuthorization | undefined,
  session: AuthzSession,
  typeName: string,
  filter?: Record<string, unknown> | null,
  sort?: QuerySort,
): void {
  // Every list request runs this; entities without a classified column (the
  // common case) must not pay for the role intersection.
  if (!columns.some((column) => column.classification || column.fieldPolicy)) return;
  const classified = canReadClassifiedColumns(authorization, session);

  const requestedFields = [
    ...Object.keys(filter ?? {}).map((field) => ({
      field,
      column: classifiedColumnForFilterField(columns, field),
    })),
    ...(sort?.field
      ? [{ field: sort.field, column: classifiedColumnForSortField(columns, sort.field) }]
      : []),
  ];
  const classifiedField = requestedFields
    .find(({ column }) => column && hasUnreadableField(columnFieldPolicy(column), session, classified));

  if (!classifiedField?.column) return;
  const { field } = classifiedField;
  throw operationFailure({
    code: "FORBIDDEN",
    message: `Not authorized to filter or sort by classified field "${field}" on ${typeName}.`,
  });
}

/**
 * Redact a row for a reader lacking a write grant: every column carrying a
 * restricting classification is nulled out. Returns the row unchanged when the
 * reader is authorized for classified columns or the entity has no classified
 * columns (no allocation in the common path).
 */
export function redactRow<T extends Record<string, unknown>>(
  row: T,
  columns: readonly Column[],
  authorization: GeneratedCrudAuthorization | undefined,
  session: AuthzSession,
): T {
  const classified = canReadClassifiedColumns(authorization, session);
  const restricted = columns.filter((column) =>
    (column.classification || column.fieldPolicy) && hasUnreadableField(columnFieldPolicy(column), session, classified));
  if (restricted.length === 0) return row;
  const redacted: Record<string, unknown> = { ...row };
  for (const column of restricted) {
    redacted[column.name] = redactFieldValue(row[column.name], columnFieldPolicy(column), session, classified);
  }
  return redacted as T;
}
