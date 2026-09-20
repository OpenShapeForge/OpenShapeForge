// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for loading derived-tool bindings from either a JSON field
 * on the owner or an owned collection of binding rows.
 */
import { describe, expect, it } from "bun:test";
import {
  loadOrderedBindings,
  loadOrderedBindingsByOwner,
  readBindingRows,
} from "../execution-bindings.js";
import type { ExecutionCatalogEntry } from "../declarative-execution.js";

const jsonExecution: ExecutionCatalogEntry = {
  bindingsField: "bindings",
  operationRef: "capabilityId",
  operationEntity: "Capability",
  operationTable: "capabilities",
  providerRef: "adapterId",
  providerEntity: "Adapter",
  providerTable: "adapters",
  connectionEntity: "Connection",
  connectionTable: "connections",
  connectionProviderRef: "adapterId",
  connectionValuesField: "values",
};

const relationExecution: ExecutionCatalogEntry = {
  bindingsRelation: "capabilityBindings",
  bindingsEntity: "ServiceCapabilityBinding",
  bindingsTable: "service_capability_bindings",
  parentRef: "serviceId",
  operationRef: "capabilityId",
  operationEntity: "Capability",
  operationTable: "capabilities",
  providerRef: "adapterId",
  providerEntity: "Adapter",
  providerTable: "adapters",
  connectionEntity: "Connection",
  connectionTable: "connections",
  connectionProviderRef: "adapterId",
  connectionValuesField: "values",
};

describe("loadOrderedBindings", () => {
  it("reads a JSON collection off the owner row", async () => {
    const bindings = await loadOrderedBindings(jsonExecution, {
      id: "svc-1",
      bindings: [
        { order: 2, capabilityId: "b" },
        { order: 1, capabilityId: "a" },
      ],
    });
    expect(bindings.map((binding) => binding.capabilityId)).toEqual(["a", "b"]);
  });

  it("joins an owned collection, ordered by order", async () => {
    const rows: Record<string, unknown>[] = [
      { id: "bind-2", serviceId: "svc-1", order: 2, capabilityId: "b" },
      { id: "bind-1", serviceId: "svc-1", order: 1, capabilityId: "a" },
      { id: "bind-other", serviceId: "svc-2", order: 1, capabilityId: "c" },
    ];
    const seen: Array<{ table: string; filter: Record<string, unknown> }> = [];
    const bindings = await loadOrderedBindings(
      relationExecution,
      { id: "svc-1" },
      async (table, filter) => {
        seen.push({ table, filter });
        return rows.filter((row) =>
          Object.entries(filter).every(([key, value]) => row[key] === value),
        );
      },
    );
    expect(seen).toEqual([
      {
        table: "service_capability_bindings",
        filter: { serviceId: "svc-1" },
      },
    ]);
    expect(bindings.map((binding) => binding.capabilityId)).toEqual(["a", "b"]);
  });

  it("refuses an empty relation the same way as an empty JSON collection", async () => {
    await expect(
      loadOrderedBindings(relationExecution, { id: "svc-1" }, async () => []),
    ).rejects.toThrow(/no bindings/);
  });
});

describe("loadOrderedBindingsByOwner", () => {
  it("groups relation rows by parent and keeps JSON rows on the owner", async () => {
    const json = await loadOrderedBindingsByOwner(
      jsonExecution,
      [
        {
          id: "svc-1",
          bindings: [{ order: 1, capabilityId: "a" }],
        },
      ],
      async () => [],
    );
    expect(json.get("svc-1")?.map((binding) => binding.capabilityId)).toEqual(["a"]);

    const relation = await loadOrderedBindingsByOwner(
      relationExecution,
      [{ id: "svc-1" }, { id: "svc-2" }],
      async (_table, filter) => {
        const ids = filter.serviceIdIn as string[];
        expect(ids).toEqual(["svc-1", "svc-2"]);
        return [
          { id: "bind-2", serviceId: "svc-1", order: 2, capabilityId: "b" },
          { id: "bind-1", serviceId: "svc-1", order: 1, capabilityId: "a" },
          { id: "bind-3", serviceId: "svc-2", order: 1, capabilityId: "c" },
        ];
      },
    );
    expect(relation.get("svc-1")?.map((binding) => binding.capabilityId)).toEqual([
      "a",
      "b",
    ]);
    expect(relation.get("svc-2")?.map((binding) => binding.capabilityId)).toEqual([
      "c",
    ]);
  });
});

describe("readBindingRows", () => {
  it("returns an empty list for publication when the collection is missing", async () => {
    expect(await readBindingRows(jsonExecution, { id: "svc-1" })).toEqual([]);
    expect(
      await readBindingRows(relationExecution, { id: "svc-1" }, async () => []),
    ).toEqual([]);
  });
});
