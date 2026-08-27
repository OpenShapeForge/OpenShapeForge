// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { isGeneratedCrudUiEnabled } from "./generate-ui-artifacts.js";

function contract(
  operations: Record<"list" | "get" | "create" | "update" | "delete", boolean>,
) {
  return { crud: { operations } } as Parameters<typeof isGeneratedCrudUiEnabled>[0];
}

describe("generated CRUD UI eligibility", () => {
  test("keeps the historical full CRUD pages", () => {
    expect(isGeneratedCrudUiEnabled(contract({
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    }))).toBe(true);
  });

  test("does not emit stock pages for a partial API policy", () => {
    expect(isGeneratedCrudUiEnabled(contract({
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    }))).toBe(false);
  });
});
