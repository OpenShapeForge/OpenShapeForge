// SPDX-License-Identifier: BUSL-1.1
/**
 * The refusals the generic entity runtime answers with, one row per code.
 *
 * The runtime refuses in a fixed vocabulary: the role gate and the record
 * permission, the mutation controls (version, edit lease, confirmation),
 * the input validation, and the database refusals it translates (a RAISE in
 * an authored guard, a foreign key, a unique index, a check). Which of those
 * an entity Operation can meet follows from its policy flags, so the
 * compiler derives each Operation's declared errors from this table and the
 * runtime's own tests hold the table to the codes the runtime throws.
 *
 * Statuses are the ones the transports answer with
 * (apps/api/src/connectors/provider-outcome.ts).
 */

export type EntityRuntimeError = { status: number; code: string; description: string };

const row = (status: number, code: string, description: string): EntityRuntimeError => ({
  status,
  code,
  description,
});

/** Every code, keyed by the situation the compiler derives it from. */
export const ENTITY_RUNTIME_ERRORS = {
  /** Every Operation. */
  session: [
    row(401, "UNAUTHENTICATED", "Missing or invalid credentials."),
    row(403, "FORBIDDEN", "The caller lacks a required role or record permission."),
  ],
  /** A list. */
  list: [row(400, "BAD_USER_INPUT", "Invalid filter, sort, or pagination input.")],
  /** A record Operation (get, update, delete). */
  record: [row(404, "NOT_FOUND", "The record does not exist or is not visible.")],
  /** A write (create, update, delete): the request shape and what the database refuses. */
  write: [
    row(400, "BAD_USER_INPUT", "Invalid request body or mutation controls."),
    row(403, "FORBIDDEN", "An authored guard refused the write for this caller."),
    row(409, "OPERATION_REFUSED", "An authored guard refused the write."),
    row(422, "VALIDATION", "The values or mutation controls violate a declared rule."),
  ],
  /** A write that stores values (create, update). */
  values: [
    row(404, "REFERENCE_NOT_FOUND", "A referenced record does not exist in this tenant."),
    row(409, "ALREADY_EXISTS", "A record with the same unique values exists."),
  ],
  /** A create whose entity collects a secure input through an interaction adapter. */
  secureInput: [
    row(409, "INTERACTION_REQUIRED", "A secure input must be collected before the create can run."),
  ],
  /** A delete. */
  delete: [row(409, "REFERENCE_IN_USE", "The record is still referenced by other records.")],
  /**
   * A write on an entity with a collection field, or on the member of an
   * owned collection: a generic write does not change a collection, its own
   * Operation does.
   */
  collection: [
    row(409, "RELATION_COLLECTION_MUTATION_UNSUPPORTED", "The write would change a collection; use the collection's own Operation."),
  ],
  /** concurrency.version. */
  version: [
    row(409, "VERSION_CONFLICT", "expectedVersion does not match the current record version."),
  ],
  /** concurrency.editLease. */
  editLease: [
    row(423, "LOCKED", "Another identity currently holds the record edit lease."),
    row(409, "LEASE_INVALID", "The edit lease is invalid, expired, or belongs to another identity."),
    row(409, "LEASE_EXPIRED", "The edit lease expired before the write."),
  ],
  /** confirmation.mode other than none. */
  confirmation: [
    row(428, "CONFIRMATION_REQUIRED", "This Operation requires confirmation controls."),
  ],
  /** confirmation.mode challenge. */
  challenge: [
    row(400, "CONFIRMATION_MISMATCH", "The confirmation answer does not match the challenge."),
    row(409, "CONFIRMATION_VALUE_UNAVAILABLE", "The record holds no value the challenge could ask for."),
    row(409, "CONFIRMATION_ALREADY_USED", "The confirmation challenge was already used."),
    row(409, "CONFIRMATION_EXPIRED", "The confirmation challenge expired."),
    row(409, "CONFIRMATION_STALE", "The record changed after the confirmation challenge was issued."),
  ],
} as const satisfies Record<string, readonly EntityRuntimeError[]>;

export type EntityRuntimeErrorSituation = keyof typeof ENTITY_RUNTIME_ERRORS;

/** Every code in the vocabulary, with its status, for the runtime's own tests. */
export const ENTITY_RUNTIME_ERROR_STATUS: ReadonlyMap<string, number> = new Map(
  Object.values(ENTITY_RUNTIME_ERRORS).flat().map((error) => [error.code, error.status]),
);
