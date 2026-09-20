// SPDX-License-Identifier: BUSL-1.1
/**
 * Reverse catalog mapping: binding-row writes and referenced
 * operation/provider/connection mutations revalidate the published owner
 * they affect. Overlay helpers live in the write engine.
 */
import { describe, expect, it } from "bun:test";
import {
  applyBindingOverlay,
  bindingOwnerIdsFromOverlay,
  derivedToolEntriesForBindingTable,
  derivedToolEntriesForReferencedTable,
  type BindingRowOverlay,
} from "../../operations/entity/derived-execution-guards.js";
import { validateVisibleDefinition } from "../publication-validation.js";
import type { DerivedToolsCatalogEntry } from "../derived-tools.js";

const ENTRY: DerivedToolsCatalogEntry = {
  entity: "Service",
  table: "core.services",
  roles: ["employee"],
  keyField: "key",
  descriptionField: "description",
  inputFieldsField: "inputFields",
  visibleWhen: { field: "status", equals: "published" },
  execution: {
    bindingsRelation: "capabilityBindings",
    bindingsEntity: "Binding",
    bindingsTable: "core.bindings",
    parentRef: "serviceId",
    operationRef: "operationId",
    operationEntity: "Operation",
    operationTable: "core.operations",
    providerRef: "providerId",
    providerEntity: "Provider",
    providerTable: "core.providers",
    connectionEntity: "Connection",
    connectionTable: "core.connections",
    connectionProviderRef: "providerId",
    connectionValuesField: "values",
  },
};

const PROVIDER = {
  id: "prov-1",
  name: "Ticketing",
  auth: { scheme: "bearer", tokenFrom: "token" },
};
const OPERATION = { id: "op-1", key: "search", providerId: "prov-1" };
const CONNECTION = {
  id: "conn-1",
  providerId: "prov-1",
  values: { token: "t" },
};
const OWNER = {
  id: "svc-1",
  key: "find-tickets",
  status: "published",
};
const BINDING = {
  id: "bind-1",
  serviceId: "svc-1",
  order: 1,
  operationId: "op-1",
};

function readerFor(data: Record<string, Record<string, unknown>[]>) {
  return async (table: string, filter: Record<string, unknown>) =>
    (data[table] ?? []).filter((row) =>
      Object.entries(filter).every(([key, value]) => row[key] === value),
    );
}

async function failure(
  input: Parameters<typeof validateVisibleDefinition>[0],
): Promise<string> {
  try {
    await validateVisibleDefinition(input);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected validation to refuse");
}

describe("derivedToolEntriesForBindingTable", () => {
  it("maps a binding table back to published owners", () => {
    expect(
      derivedToolEntriesForBindingTable("core.bindings", [ENTRY]).map(
        (entry) => entry.entity,
      ),
    ).toEqual(["Service"]);
    expect(derivedToolEntriesForBindingTable("core.services", [ENTRY])).toEqual([]);
  });
});

describe("derivedToolEntriesForReferencedTable", () => {
  it("maps operation, provider and connection tables back to published owners", () => {
    expect(
      derivedToolEntriesForReferencedTable("core.operations", [ENTRY]).map(
        (entry) => entry.execution?.operationEntity,
      ),
    ).toEqual(["Operation"]);
    expect(
      derivedToolEntriesForReferencedTable("core.providers", [ENTRY]).map(
        (entry) => entry.execution?.providerEntity,
      ),
    ).toEqual(["Provider"]);
    expect(
      derivedToolEntriesForReferencedTable("core.connections", [ENTRY]).map(
        (entry) => entry.execution?.connectionEntity,
      ),
    ).toEqual(["Connection"]);
  });
});

describe("bindingOwnerIdsFromOverlay", () => {
  it("includes both owners when a binding is moved", () => {
    const overlay: BindingRowOverlay = {
      kind: "update",
      id: "bind-1",
      before: BINDING,
      after: { ...BINDING, serviceId: "svc-2" },
    };
    expect(bindingOwnerIdsFromOverlay(ENTRY.execution!, overlay).sort()).toEqual([
      "svc-1",
      "svc-2",
    ]);
  });
});

describe("applyBindingOverlay", () => {
  it("adds, replaces, and removes the mutated row for one owner", () => {
    expect(
      applyBindingOverlay([], "serviceId", "svc-1", {
        kind: "create",
        row: BINDING,
      }),
    ).toEqual([BINDING]);
    expect(
      applyBindingOverlay([BINDING], "serviceId", "svc-1", {
        kind: "update",
        id: "bind-1",
        before: BINDING,
        after: { ...BINDING, operationId: "op-2" },
      }),
    ).toEqual([{ ...BINDING, operationId: "op-2" }]);
    expect(
      applyBindingOverlay([BINDING], "serviceId", "svc-1", {
        kind: "delete",
        id: "bind-1",
        row: BINDING,
      }),
    ).toEqual([]);
  });
});

describe("published owner revalidation after a binding mutation", () => {
  const data = {
    "core.operations": [OPERATION],
    "core.providers": [PROVIDER],
    "core.connections": [CONNECTION],
    "core.bindings": [BINDING],
    "core.services": [OWNER],
  };

  it("refuses deleting the last binding of a published owner", async () => {
    const remaining = applyBindingOverlay([BINDING], "serviceId", "svc-1", {
      kind: "delete",
      id: "bind-1",
      row: BINDING,
    });
    const message = await failure({
      entry: ENTRY,
      row: OWNER,
      rowId: "svc-1",
      reservedNames: new Set(),
      readRows: readerFor(data),
      readBindingPages: async () => ({ rows: remaining, nextCursor: null }),
    });
    expect(message).toContain("collection is empty");
  });

  it("refuses a binding create that names a missing operation", async () => {
    const created = applyBindingOverlay([BINDING], "serviceId", "svc-1", {
      kind: "create",
      row: {
        id: "bind-2",
        serviceId: "svc-1",
        order: 2,
        operationId: "missing",
      },
    });
    const message = await failure({
      entry: ENTRY,
      row: OWNER,
      rowId: "svc-1",
      reservedNames: new Set(),
      readRows: readerFor(data),
      readBindingPages: async () => ({ rows: created, nextCursor: null }),
    });
    expect(message).toContain("does not exist");
  });

  it("refuses a binding update that names a missing operation", async () => {
    const updated = applyBindingOverlay([BINDING], "serviceId", "svc-1", {
      kind: "update",
      id: "bind-1",
      before: BINDING,
      after: { ...BINDING, operationId: "missing" },
    });
    const message = await failure({
      entry: ENTRY,
      row: OWNER,
      rowId: "svc-1",
      reservedNames: new Set(),
      readRows: readerFor(data),
      readBindingPages: async () => ({ rows: updated, nextCursor: null }),
    });
    expect(message).toContain("does not exist");
  });

  it("refuses deleting an operation a published owner still binds", async () => {
    const message = await failure({
      entry: ENTRY,
      row: OWNER,
      rowId: "svc-1",
      reservedNames: new Set(),
      readRows: async (table, filter) => {
        if (table === "core.operations" && filter.id === "op-1") return [];
        return readerFor(data)(table, filter);
      },
      readBindingPages: async () => ({ rows: [BINDING], nextCursor: null }),
    });
    expect(message).toContain("does not exist");
  });

  it("refuses deleting a provider a published owner still uses", async () => {
    const message = await failure({
      entry: ENTRY,
      row: OWNER,
      rowId: "svc-1",
      reservedNames: new Set(),
      readRows: async (table, filter) => {
        if (table === "core.providers" && filter.id === "prov-1") return [];
        return readerFor(data)(table, filter);
      },
      readBindingPages: async () => ({ rows: [BINDING], nextCursor: null }),
    });
    expect(message).toContain("does not exist");
  });

  it("refuses deleting the tenant connection a published owner still uses", async () => {
    const message = await failure({
      entry: ENTRY,
      row: OWNER,
      rowId: "svc-1",
      reservedNames: new Set(),
      readRows: async (table, filter) => {
        if (table === "core.connections") return [];
        return readerFor(data)(table, filter);
      },
      readBindingPages: async () => ({ rows: [BINDING], nextCursor: null }),
    });
    expect(message).toContain("no Connection is configured");
  });
});
