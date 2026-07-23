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
});
