// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { isGeneratedCrudEligible } from "./schema.js";

describe("generated CRUD eligibility", () => {
  test("reads the explicit marker and treats absence as false", () => {
    expect(isGeneratedCrudEligible({ generatedCrudEligible: true })).toBe(true);
    expect(isGeneratedCrudEligible({ generatedCrudEligible: false })).toBe(false);
    expect(isGeneratedCrudEligible({})).toBe(false);
  });

  test("domain-internal remains an absolute deny", () => {
    expect(isGeneratedCrudEligible({
      domainInternal: true,
      generatedCrudEligible: true,
    })).toBe(false);
  });
});
