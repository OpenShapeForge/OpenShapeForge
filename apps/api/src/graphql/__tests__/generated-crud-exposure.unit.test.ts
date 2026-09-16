// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  getGeneratedCrudTables,
  isGeneratedCrudOperationEnabled,
  isGeneratedCrudTableEligible,
} from "../generated-crud.js";
import {
  renderGeneratedMutationFields,
  renderGeneratedQueryFields,
} from "../generated-entity-schema.js";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

const base = getGeneratedCrudTables().find((table) => table.name === "erp.relations")!;

function withOperations(
  operations: Record<"list" | "get" | "create" | "update" | "delete", boolean>,
): GeneratedTable {
  return {
    ...base,
    source: {
      ...base.source,
      crud: { operations },
    },
  };
}

describe("generated GraphQL CRUD exposure", () => {
  test("partial policies are visible to current runtimes and hidden from legacy ones", () => {
    const table = withOperations({
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    });
    table.generatedCrudEligible = true;
    table.generatedCrud = false;
    expect(isGeneratedCrudTableEligible(table)).toBe(true);
    expect(isGeneratedCrudOperationEnabled(table, "list")).toBe(true);
    expect(isGeneratedCrudOperationEnabled(table, "create")).toBe(false);
  });

  test("current runtimes preserve explicit legacy full-CRUD manifests", () => {
    const legacy = {
      ...base,
      generatedCrud: true,
      generatedCrudEligible: undefined,
      source: { ...base.source, crud: undefined },
    } as unknown as GeneratedTable;
    expect(isGeneratedCrudTableEligible(legacy)).toBe(true);
    expect(isGeneratedCrudOperationEnabled(legacy, "delete")).toBe(true);
  });

  test("a read-only entity emits queries but no mutations", () => {
    const table = withOperations({
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    });
    expect(renderGeneratedQueryFields(table)).toHaveLength(2);
    expect(renderGeneratedMutationFields(table)).toEqual([]);
  });

  test("independent list/get flags emit only the selected read operation", () => {
    const table = withOperations({
      list: false,
      get: true,
      create: false,
      update: false,
      delete: false,
    });
    expect(renderGeneratedQueryFields(table)).toHaveLength(1);
    expect(renderGeneratedQueryFields(table)[0]).toContain("relation(id:");
  });

  test("write operations are emitted independently", () => {
    const table = withOperations({
      list: false,
      get: false,
      create: true,
      update: false,
      delete: false,
    });
    expect(renderGeneratedQueryFields(table)).toEqual([]);
    expect(renderGeneratedMutationFields(table)).toHaveLength(1);
    expect(renderGeneratedMutationFields(table)[0]).toContain("createRelation");
  });
});
