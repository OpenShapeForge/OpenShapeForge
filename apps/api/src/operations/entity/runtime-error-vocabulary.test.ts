// SPDX-License-Identifier: BUSL-1.1
/**
 * The compiler declares an entity Operation's errors from
 * ENTITY_RUNTIME_ERRORS. This holds that table to the runtime: every code
 * the generic entity path throws to a client is declared with the status the
 * transports answer, and nothing is declared that no path throws.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ENTITY_RUNTIME_ERROR_STATUS } from "@openshapeforge/operations";
import { httpStatusForCode } from "../../connectors/provider-outcome.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { collectionManagedFields, collectionMutationError } from "./collection-policy.js";
import { getEntityOperationContracts, tableForEntityOperation } from "./runtime.js";
import type { EntityOperationContract } from "./types.js";

/** The modules of the generic entity path that answer a client, and the codes in them that are not refusals of a request. */
const RUNTIME_MODULES = [
  "runtime.ts",
  "mutations.ts",
  "queries.ts",
  "record-permissions.ts",
  "input-validation.ts",
  "write-policy.ts",
  "catalog.ts",
  "collection-policy.ts",
  "edit-leases.ts",
  "confirmation-challenges.ts",
  "../../db/database-refusals.ts",
];
const NOT_A_REQUEST_REFUSAL = new Set([
  // Server faults and misconfiguration, never a declared answer.
  "INTERNAL_SERVER_ERROR",
  "GENERATED_CRUD_NOT_ENABLED",
  "GENERATED_CRUD_OPERATION_NOT_ENABLED",
  // Refusals of the lease and confirmation tools themselves, not of a CRUD Operation.
  "LEASE_NOT_SUPPORTED",
  "LEASE_ACQUIRE_FAILED",
  "CONFIRMATION_NOT_SUPPORTED",
  // Field-level violation kinds nested inside a VALIDATION answer.
  "INVALID_TYPE",
  "INVALID_DATETIME",
  "REQUIRED",
]);

function thrownCodes(): Set<string> {
  const codes = new Set<string>();
  for (const module of RUNTIME_MODULES) {
    const source = readFileSync(new URL(module, import.meta.url), "utf8");
    for (const match of source.matchAll(/\b(?:code|kind): "([A-Z][A-Z0-9_]+)"/g)) codes.add(match[1]!);
    for (const match of source.matchAll(/generatedCrudError\([^)]*?"([A-Z][A-Z0-9_]+)"\)/gs)) codes.add(match[1]!);
    for (const match of source.matchAll(/^\s+([A-Z][A-Z0-9_]+): \d{3},$/gm)) codes.add(match[1]!);
  }
  return codes;
}

describe("entity runtime error vocabulary", () => {
  const thrown = thrownCodes();

  test("every code the generic entity path throws to a client is declared", () => {
    const undeclared = [...thrown]
      .filter((code) => !NOT_A_REQUEST_REFUSAL.has(code) && !ENTITY_RUNTIME_ERROR_STATUS.has(code))
      .sort();
    expect(undeclared).toEqual([]);
  });

  test("every declared code is one a runtime path throws", () => {
    const unthrown = [...ENTITY_RUNTIME_ERROR_STATUS.keys()].filter((code) => !thrown.has(code)).sort();
    // UNAUTHENTICATED is answered by the session layer before the entity path.
    expect(unthrown).toEqual(["UNAUTHENTICATED"]);
  });

  test("every declared status is the one the transports answer", () => {
    for (const [code, status] of ENTITY_RUNTIME_ERROR_STATUS) {
      expect(`${code} ${httpStatusForCode(code)}`).toBe(`${code} ${status}`);
    }
  });
});

/**
 * Per Operation: the codes the compiler derived from a policy flag are
 * declared exactly where the runtime path that throws them is reachable.
 */
describe("declared errors per entity Operation", () => {
  const tables = getGeneratedCrudTables();
  const byName = new Map(tables.map((table) => [table.name, table]));
  const codes = (operation: EntityOperationContract) => new Set(operation.errors.map((error) => error.code));

  test("collection refusal: entities with collection fields and members of owned collections, writes only", () => {
    for (const operation of getEntityOperationContracts()) {
      const table = byName.get(tableForEntityOperation({ id: operation.id, intent: operation.intent }).name)!;
      const write = operation.intent !== "list" && operation.intent !== "get";
      // A write names a collection field (refused explicitly) or the entity
      // is the member of an owned collection (its delete is refused).
      const collections = collectionManagedFields(table, tables).size > 0;
      const member = collectionMutationError(table, "delete", tables) !== undefined;
      const reachable = write && (collections || member);
      expect(`${operation.id} ${codes(operation).has("RELATION_COLLECTION_MUTATION_UNSUPPORTED")}`)
        .toBe(`${operation.id} ${reachable}`);
    }
  });

  test("control refusals follow the Operation's own concurrency and confirmation flags", () => {
    for (const operation of getEntityOperationContracts()) {
      const declared = codes(operation);
      const expect_ = (code: string, reachable: boolean) =>
        expect(`${operation.id} ${code} ${declared.has(code)}`).toBe(`${operation.id} ${code} ${reachable}`);
      expect_("VERSION_CONFLICT", operation.concurrency?.version !== undefined);
      expect_("LOCKED", operation.concurrency?.editLease !== undefined);
      expect_("LEASE_INVALID", operation.concurrency?.editLease !== undefined);
      expect_("CONFIRMATION_REQUIRED", operation.interaction.confirmation.mode !== "none");
      expect_("CONFIRMATION_MISMATCH", operation.interaction.confirmation.mode === "challenge");
      expect_("CONFIRMATION_STALE", operation.interaction.confirmation.mode === "challenge");
      expect_("INTERACTION_REQUIRED", operation.intent === "create" && operation.interaction.secureInput !== undefined);
      expect_("REFERENCE_IN_USE", operation.intent === "delete");
      expect_("NOT_FOUND", operation.intent !== "list" && operation.intent !== "create");
    }
  });
});
