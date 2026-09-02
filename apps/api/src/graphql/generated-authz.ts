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
import { GraphQLError } from "graphql";
import type {
  GeneratedCrudAuthorization,
  GeneratedCrudOperation,
} from "./generated-crud.js";

type Column = {
  name: string;
  classification?: "confidential" | "pii" | "bsn";
  sourceField?: string;
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
    throw new GraphQLError(
      `Not authorized: ${typeName} declares no roles for "${operation}"; access is denied by default.`,
      { extensions: { code: "FORBIDDEN", status: 403 } },
    );
  }
  const granted = session?.roles ?? [];
  if (!intersects(granted, required)) {
    throw new GraphQLError(
      `Not authorized to ${operation} ${typeName}.`,
      { extensions: { code: "FORBIDDEN", status: 403 } },
    );
  }
}

/**
 * Whether the session may read data-classified (pii/bsn/confidential) columns
 * of this entity. A caller with a write grant (any role listed under
 * create/update/delete — the entity's "ReadWrite" tier) may read sensitive
 * columns; a read-only caller may not.
 */
export function canReadClassifiedColumns(
  authorization: GeneratedCrudAuthorization | undefined,
  session: AuthzSession,
): boolean {
  if (!authorization?.roles) return false;
  // A manifest that predates an operation key (stale artifacts) must degrade to
  // "no write grant", not to a TypeError on a request path.
  const writeRoles = [
    ...(authorization.roles.create ?? []),
    ...(authorization.roles.update ?? []),
    ...(authorization.roles.delete ?? []),
  ];
  return intersects(session?.roles ?? [], writeRoles);
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
  if (!columns.some((column) => column.classification)) return;
  if (canReadClassifiedColumns(authorization, session)) return;

  const requestedFields = [
    ...Object.entries(filter ?? {})
      .filter(([, value]) => hasEffectiveFilterValue(value))
      .map(([field]) => ({
        field,
        column: classifiedColumnForFilterField(columns, field),
      })),
    ...(sort?.field
      ? [{ field: sort.field, column: classifiedColumnForSortField(columns, sort.field) }]
      : []),
  ];
  const classifiedField = requestedFields
    .find(({ column }) => column?.classification);

  if (!classifiedField?.column) return;
  const { field } = classifiedField;
  throw new GraphQLError(
    `Not authorized to filter or sort by classified field "${field}" on ${typeName}.`,
    { extensions: { code: "FORBIDDEN", status: 403 } },
  );
}

/** Values the CRUD predicate treats as no filter must not trip query guards. */
export function hasEffectiveFilterValue(value: unknown): boolean {
  return value != null && value !== "" && (!Array.isArray(value) || value.length > 0);
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
  const classified = columns.filter((column) => column.classification);
  if (classified.length === 0) return row;
  if (canReadClassifiedColumns(authorization, session)) return row;
  const redacted: Record<string, unknown> = { ...row };
  for (const column of classified) {
    redacted[column.name] = null;
  }
  return redacted as T;
}
