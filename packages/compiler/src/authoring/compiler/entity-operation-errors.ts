// SPDX-License-Identifier: BUSL-1.1
/**
 * The errors a canonical entity CRUD Operation declares.
 *
 * The generic entity runtime refuses in a fixed vocabulary — the role gate,
 * the record permission, the concurrency controls, the confirmation
 * controls, the database refusals it translates — and which refusals an
 * Operation can meet follows from its policy flags alone. They are derived
 * here, once, so every projection (OpenAPI responses, MCP tool errors, the
 * searchable catalogue) advertises the same list instead of reconstructing
 * it from the same flags.
 *
 * Statuses follow the runtime's code-to-status table
 * (apps/api/src/connectors/provider-outcome.ts).
 */
import type { OperationConcurrency, OperationConfirmation } from "@openshapeforge/operations";
import type { CompiledEntityOperation, EntityOperationIntent } from "../types.js";

export type EntityOperationError = NonNullable<CompiledEntityOperation["errors"]>[number];

export type EntityOperationErrorPolicy = {
  concurrency?: OperationConcurrency | undefined;
  confirmation: OperationConfirmation;
  /** The entity carries record-level permissions the caller may lack. */
  recordPermissions: boolean;
};

const error = (status: number, code: string, description: string): EntityOperationError => ({
  status,
  code,
  description,
});

export function deriveEntityOperationErrors(
  entityName: string,
  intent: EntityOperationIntent,
  policy: EntityOperationErrorPolicy,
): EntityOperationError[] {
  const reads = intent === "list" || intent === "get";
  const errors: EntityOperationError[] = [];

  if (intent === "list") {
    errors.push(error(400, "BAD_USER_INPUT", "Invalid filter, sort, or pagination input."));
  } else if (!reads) {
    errors.push(error(400, "BAD_USER_INPUT", "Invalid request body or mutation controls."));
  }
  errors.push(error(401, "UNAUTHENTICATED", "Missing or invalid credentials."));
  errors.push(
    error(
      403,
      "FORBIDDEN",
      policy.recordPermissions
        ? `The caller lacks a required ${entityName} role or the record permission.`
        : `The caller lacks a required ${entityName} role.`,
    ),
  );
  if (intent === "get" || intent === "update" || intent === "delete") {
    errors.push(error(404, "NOT_FOUND", `The ${entityName} does not exist.`));
  }
  if (intent === "create" || intent === "update") {
    errors.push(
      error(404, "REFERENCE_NOT_FOUND", "A referenced record does not exist in this tenant."),
      error(409, "ALREADY_EXISTS", `A ${entityName} with the same unique values exists.`),
      error(422, "VALIDATION", "The values or mutation controls are invalid."),
    );
  }
  if (intent === "delete") {
    errors.push(
      error(409, "REFERENCE_IN_USE", `The ${entityName} is still referenced by other records.`),
    );
  }
  if (policy.concurrency?.version) {
    errors.push(
      error(409, "VERSION_CONFLICT", "expectedVersion does not match the current record version."),
    );
    if (intent === "delete") {
      errors.push(error(422, "VALIDATION", "expectedVersion is not a valid record version."));
    }
  }
  if (policy.concurrency?.editLease) {
    errors.push(
      error(423, "LOCKED", "Another identity currently holds the record edit lease."),
      error(409, "LEASE_INVALID", "The edit lease is missing, expired or held by another identity."),
    );
  }
  if (policy.confirmation.mode !== "none") {
    errors.push(
      error(428, "CONFIRMATION_REQUIRED", "This Operation requires confirmation controls."),
    );
  }
  if (policy.confirmation.mode === "challenge") {
    errors.push(
      error(400, "CONFIRMATION_MISMATCH", "The confirmation answer does not match the challenge."),
      error(409, "CONFIRMATION_EXPIRED", "The confirmation challenge expired or was already used."),
    );
  }
  return errors;
}

/**
 * Declared errors of a plugin-implemented CRUD Operation merged over the
 * derived ones: the same status and code declared by the author wins, and
 * every other declaration is appended. Sorted by status, then code, so the
 * projections are deterministic whatever the authored order.
 */
export function withDeclaredEntityOperationErrors(
  derived: readonly EntityOperationError[],
  declared: readonly EntityOperationError[] | undefined,
): EntityOperationError[] {
  const byKey = new Map<string, EntityOperationError>();
  for (const candidate of [...derived, ...(declared ?? [])]) {
    byKey.set(`${candidate.status}:${candidate.code}`, candidate);
  }
  return [...byKey.values()].sort(
    (left, right) => left.status - right.status || left.code.localeCompare(right.code),
  );
}
