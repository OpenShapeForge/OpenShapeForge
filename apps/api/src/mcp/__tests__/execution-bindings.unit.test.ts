// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for loading derived-tool bindings from an owned collection.
 */
import { describe, expect, it } from "bun:test";
import {
  BindingOverflowError,
  MAX_BINDINGS_PER_OWNER,
  isMissingRelationError,
  loadOrderedBindings,
  loadOrderedBindingsByOwner,
  readBindingRows,
  type BindingRowReader,
} from "../execution-bindings.js";
import type { ExecutionCatalogEntry } from "../declarative-execution.js";

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

function matching(
  rows: Record<string, unknown>[],
  filter: Record<string, unknown>,
): Record<string, unknown>[] {
  return rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value) && "in" in value) {
        const membership = (value as { in?: unknown }).in;
        return Array.isArray(membership) && membership.includes(row[key]);
      }
      return row[key] === value;
    }),
  );
}

/** Complete array reader: returns every matching row in one shot. */
function completeReader(rows: Record<string, unknown>[]): BindingRowReader {
  return async (_table, filter) => matching(rows, filter);
}

/** Honours limit/cursor so overflow detection cannot be skipped. */
function pagingReader(rows: Record<string, unknown>[]): BindingRowReader {
  return async (_table, filter, options) => {
    const matched = matching(rows, filter);
    const limit = options?.limit ?? MAX_BINDINGS_PER_OWNER;
    const offset =
      typeof options?.cursor === "string" && options.cursor.length > 0
        ? Number.parseInt(options.cursor, 10)
        : 0;
    const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const slice = matched.slice(start, start + limit);
    return {
      rows: slice,
      nextCursor: start + slice.length < matched.length ? String(start + slice.length) : null,
    };
  };
}

function bindingRows(ownerId: string, count: number, start = 1): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const order = start + index;
    return {
      id: `${ownerId}-bind-${order}`,
      serviceId: ownerId,
      order,
      capabilityId: `${ownerId}-${order}`,
    };
  });
}

describe("loadOrderedBindings", () => {
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
        return matching(rows, filter);
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

  it("refuses an empty relation", async () => {
    await expect(
      loadOrderedBindings(relationExecution, { id: "svc-1" }, async () => []),
    ).rejects.toThrow(/no bindings/);
  });

  it("refuses a relation that exceeds the per-owner maximum", async () => {
    const rows = bindingRows("svc-1", MAX_BINDINGS_PER_OWNER + 1);
    await expect(
      loadOrderedBindings(relationExecution, { id: "svc-1" }, completeReader(rows)),
    ).rejects.toBeInstanceOf(BindingOverflowError);
    await expect(
      loadOrderedBindings(relationExecution, { id: "svc-1" }, pagingReader(rows)),
    ).rejects.toMatchObject({
      code: "SERVICE_MISCONFIGURED",
      message: `The service defines more than ${MAX_BINDINGS_PER_OWNER} bindings.`,
    });
  });

  it("pages a complete chain that fills more than one reader page", async () => {
    const rows = bindingRows("svc-1", 150);
    const bindings = await loadOrderedBindings(
      relationExecution,
      { id: "svc-1" },
      pagingReader(rows),
    );
    expect(bindings).toHaveLength(150);
    expect(bindings[0]?.capabilityId).toBe("svc-1-1");
    expect(bindings[149]?.capabilityId).toBe("svc-1-150");
  });

  it("propagates a non-missing-table reader error", async () => {
    await expect(
      loadOrderedBindings(relationExecution, { id: "svc-1" }, async () => {
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("loadOrderedBindingsByOwner", () => {
  it("groups relation rows by parent in one paged query over the owner-id set", async () => {
    const seen: Array<{ filter: Record<string, unknown> }> = [];
    const relation = await loadOrderedBindingsByOwner(
      relationExecution,
      [{ id: "svc-1" }, { id: "svc-2" }],
      async (_table, filter) => {
        seen.push({ filter });
        return matching(
          [
            { id: "bind-2", serviceId: "svc-1", order: 2, capabilityId: "b" },
            { id: "bind-1", serviceId: "svc-1", order: 1, capabilityId: "a" },
            { id: "bind-3", serviceId: "svc-2", order: 1, capabilityId: "c" },
          ],
          filter,
        );
      },
    );
    expect(seen).toEqual([
      { filter: { serviceId: { in: ["svc-1", "svc-2"] } } },
    ]);
    expect(relation.get("svc-1")?.map((binding) => binding.capabilityId)).toEqual([
      "a",
      "b",
    ]);
    expect(relation.get("svc-2")?.map((binding) => binding.capabilityId)).toEqual([
      "c",
    ]);
  });

  it("does not share one page budget across owners", async () => {
    const perOwner = 150;
    const rows = [
      ...bindingRows("svc-1", perOwner),
      ...bindingRows("svc-2", perOwner),
    ];
    const relation = await loadOrderedBindingsByOwner(
      relationExecution,
      [{ id: "svc-1" }, { id: "svc-2" }],
      pagingReader(rows),
    );
    expect(relation.get("svc-1")).toHaveLength(perOwner);
    expect(relation.get("svc-2")).toHaveLength(perOwner);
  });

  it("caps each owner independently and refuses overflow", async () => {
    const rows = [
      ...bindingRows("svc-1", MAX_BINDINGS_PER_OWNER + 1),
      ...bindingRows("svc-2", 2),
    ];
    await expect(
      loadOrderedBindingsByOwner(
        relationExecution,
        [{ id: "svc-1" }, { id: "svc-2" }],
        pagingReader(rows),
      ),
    ).rejects.toBeInstanceOf(BindingOverflowError);
  });
});

describe("readBindingRows", () => {
  it("returns an empty list for publication when the collection is missing", async () => {
    expect(
      await readBindingRows(relationExecution, { id: "svc-1" }, async () => []),
    ).toEqual([]);
  });

  it("reads a missing table as empty and propagates other errors", async () => {
    expect(isMissingRelationError({ code: "42P01" })).toBe(true);
    expect(
      await readBindingRows(relationExecution, { id: "svc-1" }, async () => {
        throw Object.assign(new Error('relation "x" does not exist'), { code: "42P01" });
      }),
    ).toEqual([]);
    await expect(
      readBindingRows(relationExecution, { id: "svc-1" }, async () => {
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      }),
    ).rejects.toMatchObject({ code: "40P01" });
  });

  it("propagates overflow instead of returning a truncated prefix", async () => {
    const rows = bindingRows("svc-1", MAX_BINDINGS_PER_OWNER + 1);
    await expect(
      readBindingRows(relationExecution, { id: "svc-1" }, pagingReader(rows)),
    ).rejects.toBeInstanceOf(BindingOverflowError);
  });
});
