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
import {
  ENTITY_RUNTIME_ERRORS,
  type EntityRuntimeError,
  type EntityRuntimeErrorSituation,
  type OperationConcurrency,
  type OperationConfirmation,
} from "@openshapeforge/operations";
import type { CompiledEntityContract, CompiledEntityOperation, EntityOperationIntent } from "../types.js";

export type EntityOperationError = NonNullable<CompiledEntityOperation["errors"]>[number];

export type EntityOperationErrorPolicy = {
  concurrency?: OperationConcurrency | undefined;
  confirmation: OperationConfirmation;
  /** The entity carries record-level permissions the caller may lack. */
  recordPermissions: boolean;
  /** The create collects a secure input through an interaction adapter. */
  secureInput?: boolean | undefined;
  /** The entity has a collection field; membership of an owned collection is added by withOwnedChildErrors. */
  collections?: boolean | undefined;
};

/**
 * The situations an entity Operation can meet, each contributing the codes
 * ENTITY_RUNTIME_ERRORS lists for it. The entity name is worked into the
 * descriptions a reader sees per Operation.
 */
export function deriveEntityOperationErrors(
  entityName: string,
  intent: EntityOperationIntent,
  policy: EntityOperationErrorPolicy,
): EntityOperationError[] {
  const reads = intent === "list" || intent === "get";
  const situations: EntityRuntimeErrorSituation[] = ["session"];
  if (intent === "list") situations.push("list");
  if (intent === "get" || intent === "update" || intent === "delete") situations.push("record");
  if (!reads) situations.push("write");
  if (intent === "create" || intent === "update") situations.push("values");
  if (intent === "create" && policy.secureInput) situations.push("secureInput");
  if (intent === "delete") situations.push("delete");
  if (!reads && policy.collections) situations.push("collection");
  if (policy.concurrency?.version) situations.push("version");
  if (policy.concurrency?.editLease) situations.push("editLease");
  if (policy.confirmation.mode !== "none") situations.push("confirmation");
  if (policy.confirmation.mode === "challenge") situations.push("challenge");
  return withDeclaredEntityOperationErrors(
    situations.flatMap((situation) =>
      ENTITY_RUNTIME_ERRORS[situation].map((error) => ({
        ...error,
        description: describe(error, entityName, policy),
      })),
    ),
    undefined,
  );
}

function describe(
  error: EntityRuntimeError,
  entityName: string,
  policy: EntityOperationErrorPolicy,
): string {
  switch (error.code) {
    case "FORBIDDEN":
      return policy.recordPermissions
        ? `The caller lacks a required ${entityName} role or the record permission.`
        : `The caller lacks a required ${entityName} role.`;
    case "NOT_FOUND":
      return `The ${entityName} does not exist or is not visible.`;
    case "ALREADY_EXISTS":
      return `A ${entityName} with the same unique values exists.`;
    case "REFERENCE_IN_USE":
      return `The ${entityName} is still referenced by other records.`;
    default:
      return error.description;
  }
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

/**
 * The member side of an owned collection is only known across entities: a
 * child does not say who owns it. Once every contract is compiled, each
 * write Operation of a child that some owner's owned collection targets
 * gains the collection refusal its generic write meets.
 */
export function withOwnedChildErrors(
  contracts: readonly Pick<CompiledEntityContract, "entity" | "model" | "entityOperations">[],
): void {
  const owned = new Set(
    contracts.flatMap((contract) =>
      contract.model.relationships
        .filter((relationship) => relationship.kind === "hasMany" && relationship.ownership === "owned")
        .map((relationship) => relationship.target),
    ),
  );
  for (const contract of contracts) {
    if (!owned.has(contract.entity.name)) continue;
    for (const operation of Object.values(contract.entityOperations)) {
      if (!operation || operation.intent === "list" || operation.intent === "get") continue;
      operation.errors = withDeclaredEntityOperationErrors(operation.errors, ENTITY_RUNTIME_ERRORS.collection);
    }
  }
}
