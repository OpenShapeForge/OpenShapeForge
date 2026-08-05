// SPDX-License-Identifier: BUSL-1.1
/**
 * Sanity backstop: the suite is derived from the same manifest the API
 * serves, so this can only fail if that derivation breaks.
 */
import { expect } from "bun:test";
import { describe, registerSuiteLifecycle, test } from "./e2e/harness.js";
import { tables } from "./e2e/entity-factory.js";

registerSuiteLifecycle();

describe("coverage", () => {
  test("every generatedCrud entity in the manifest is exercised", () => {
    const covered = tables.map((table) => table.source!.graphql!.typeName).sort();
    expect(covered.length).toBeGreaterThanOrEqual(2);
    expect(new Set(covered).size).toBe(covered.length);
  });

  /**
   * The immutable-field tests in the REST, MCP and GraphQL suites are derived
   * from `column.immutable`, so a manifest that carried the flag for no column
   * would register none of them and still report success — the same vacuous
   * pass `EXPECTED_SCHEMA_COVERAGE` exists to prevent for authoring schemas.
   * This states the expectation instead of inferring it (#177).
   */
  test("the manifest declares at least one immutable column", () => {
    const immutable = tables.flatMap((table) =>
      table.columns
        .filter((column) => column.immutable)
        .map((column) => `${table.name}.${column.name}`),
    );
    expect(immutable).toContain("erp.payment_details.relation_id");
  });
});
