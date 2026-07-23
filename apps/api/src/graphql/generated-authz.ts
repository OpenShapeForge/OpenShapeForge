/**
 * Runtime function-level and field-level authorization for generated entities.
 *
 * The compiler carries each entity's per-operation role lists and per-column
 * data-classification into the runtime manifest (see
 * packages/compiler/src/generate.ts + backend-manifest.ts). This module is the
 * hand-written engine that CONSUMES that metadata and enforces it in the
 * generated GraphQL resolvers:
 *
 *   - `assertOperationAllowed` — fail-closed function-level authorization
 *     (issue #94). A caller must hold at least one role listed for the
 *     operation it invokes (read/create/update/delete). Missing metadata or a
 *     non-intersecting role set is a FORBIDDEN error thrown BEFORE the DB call.
 *
 *   - `redactRow` / `canReadClassification` — field-level data protection
 *     (issues #96/#101). Columns classified pii/bsn/confidential are redacted
 *     (set to null) for readers who lack a write grant on the entity. Holding a
 *     write role (any of create/update/delete's roles — the "ReadWrite" tier)
 *     is what authorizes reading sensitive columns; a read-only grant sees the
 *     row with sensitive columns nulled out.
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
};

type AuthzSession = {
  roles?: string[] | null;
} | null | undefined;

function intersects(granted: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0) return false;
  const grantedSet = new Set(granted);
  return required.some((role) => grantedSet.has(role));
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
  const writeRoles = [
    ...authorization.roles.create,
    ...authorization.roles.update,
    ...authorization.roles.delete,
  ];
  return intersects(session?.roles ?? [], writeRoles);
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
