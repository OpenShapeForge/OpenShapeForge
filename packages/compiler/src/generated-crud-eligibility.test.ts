// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { isGeneratedCrudEligible } from "./schema.js";

describe("generated CRUD manifest compatibility", () => {
  test("uses the current eligibility marker when present", () => {
    expect(isGeneratedCrudEligible({ generatedCrudEligible: true, generatedCrud: false }))
      .toBe(true);
    expect(isGeneratedCrudEligible({ generatedCrudEligible: false, generatedCrud: true }))
      .toBe(false);
  });

  test("falls back to the legacy marker only when the current marker is absent", () => {
    expect(isGeneratedCrudEligible({ generatedCrud: true })).toBe(true);
    expect(isGeneratedCrudEligible({ generatedCrud: false })).toBe(false);
  });

  test("domain-internal remains an absolute deny", () => {
    expect(isGeneratedCrudEligible({
      domainInternal: true,
      generatedCrudEligible: true,
      generatedCrud: true,
    })).toBe(false);
  });
});
