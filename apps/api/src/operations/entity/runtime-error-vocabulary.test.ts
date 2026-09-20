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

/** The modules of the generic entity path that answer a client, and the codes in them that are not refusals of a request. */
const RUNTIME_MODULES = [
  "runtime.ts",
  "mutations.ts",
  "queries.ts",
  "record-permissions.ts",
  "input-validation.ts",
  "write-policy.ts",
  "catalog.ts",
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
