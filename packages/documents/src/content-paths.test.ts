// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { EntityGraph } from "@openshapeforge/operations";
import type { ModuleOperationContext, RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { canonicalReader, pathResolver } from "./content-runtime.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const label = (en: string) => ({ en });
const graph: EntityGraph = {
  version: 1,
  entities: {
    Deal: {
      label: label("Deal"), operations: { get: "Deal.get", list: "Deal.list" },
      fields: [{ key: "name", label: label("Name"), osfType: "string", baseType: "string", cardinality: "single" }],
      relationships: [
        { key: "relationId", kind: "belongsTo", target: "Relation", field: "relationId", label: label("Customer"), constraints: { relationType: { eq: "organization" } } },
        { key: "dealProducts", kind: "hasMany", target: "DealProduct", field: "dealId", label: label("Lines") },
      ],
    },
    Relation: {
      label: label("Relation"), operations: { get: "Relation.get", list: "Relation.list" },
      fields: [{ key: "name", label: label("Name"), osfType: "string", baseType: "string", cardinality: "single" },
        { key: "notes", label: label("Notes"), osfType: "string", baseType: "string", cardinality: "single" }],
      relationships: [],
    },
    DealProduct: {
      label: label("Line"), operations: { get: "DealProduct.get", list: "DealProduct.list" },
      fields: [{ key: "quantity", label: label("Quantity"), osfType: "decimal", baseType: "number", cardinality: "single" }],
      relationships: [],
    },
  },
};
const records: Record<string, Record<string, Record<string, unknown>>> = {
  Deal: { "deal-1": { id: "deal-1", tenantId, updatedAt: "d1", name: "Pentest", relationId: "rel-1" }, "deal-2": { id: "deal-2", tenantId, updatedAt: "d2", relationId: "rel-2" } },
  // The reader may not see `notes`: the canonical read leaves it out.
  Relation: { "rel-1": { id: "rel-1", tenantId, updatedAt: "r1", name: "Nova Harbor", relationType: "organization" }, "rel-2": { id: "rel-2", tenantId, updatedAt: "r2", name: "Jan", relationType: "person" } },
  DealProduct: {
    "line-1": { id: "line-1", tenantId, updatedAt: "l1", dealId: "deal-1", quantity: 17 },
    "line-2": { id: "line-2", tenantId, updatedAt: "l2", dealId: "deal-1", quantity: 2 },
    "line-3": { id: "line-3", tenantId, updatedAt: "l3", dealId: "deal-2", quantity: 9 },
  },
};
const operations = Object.keys(graph.entities).flatMap((entityName) => (["get", "list"] as const).map((intent) => ({
  id: `${entityName}.${intent}`, entityName, intent, effects: { data: "read", external: "none" },
}))) as unknown as RuntimeOperationDefinition[];

function context(denied: ReadonlySet<string> = new Set(), entityGraph: EntityGraph | undefined = graph) {
  const listed: unknown[] = [];
  const value = {
    session: { tenantId, userId: tenantId, credential: "bearer", roles: [], groups: [], scope: "tenant" },
    platform: {
      schemas: { entityGraph },
      records: {
        async assertAccess(_session: unknown, request: { entityName: string; id: string }) {
          if (denied.has(`${request.entityName}:${request.id}`)) throw Object.assign(new Error("denied"), { code: "FORBIDDEN" });
        },
      },
      operations: {
        async execute(_session: unknown, request: { operation: { entityName: string; intent: string }; input: Record<string, unknown> }) {
          const table = records[request.operation.entityName] ?? {};
          if (request.operation.intent === "get") return { data: table[request.input.id as string] ?? null };
          listed.push(request.input.filter);
          const [field, rule] = Object.entries(request.input.filter as Record<string, { in: string[] }>)[0]!;
          return { data: { items: Object.values(table).filter((row) => rule!.in.includes(row[field!] as string) && !denied.has(`${request.operation.entityName}:${row.id}`)) } };
        },
      },
    },
  } as unknown as ModuleOperationContext;
  const resolve = pathResolver(value, operations, canonicalReader(value, operations));
  return { resolve: resolve!, listed };
}

describe("following a record parameter on the server", () => {
  test("reads belongsTo steps through the canonical get and records every source", async () => {
    const { resolve } = context();
    const read = await resolve({ entity: "Deal", id: "deal-1" }, "relationId.name", { tenantId });
    expect(read).toMatchObject({ value: "Nova Harbor", shape: { osfType: "string", cardinality: "single" } });
    expect(read!.sources).toEqual([{ entity: "Deal", id: "deal-1", versionId: "d1" }, { entity: "Relation", id: "rel-1", versionId: "r1" }]);
  });

  test("reads a hasMany step with one filtered list and returns a list", async () => {
    const { resolve, listed } = context();
    const read = await resolve({ entity: "Deal", id: "deal-1" }, "dealProducts.quantity", { tenantId });
    expect(read).toMatchObject({ value: [17, 2], shape: { cardinality: "collection" } });
    expect(listed).toEqual([{ dealId: { in: ["deal-1"] } }]);
  });

  test("a relationship constraint the target does not meet reads as nothing", async () => {
    const { resolve } = context();
    expect((await resolve({ entity: "Deal", id: "deal-2" }, "relationId.name", { tenantId }))!.value).toBeNull();
  });

  test("a record the reader may not open refuses the variable", async () => {
    const { resolve } = context(new Set(["Relation:rel-1"]));
    await expect(resolve({ entity: "Deal", id: "deal-1" }, "relationId.name", { tenantId })).rejects.toThrow();
  });

  test("a field the canonical read withholds refuses rather than reading as empty", async () => {
    const { resolve } = context();
    await expect(resolve({ entity: "Deal", id: "deal-1" }, "relationId.notes", { tenantId })).rejects.toMatchObject({ operationError: { code: "DEPENDENCY_INVALID" } });
  });

  test("a path the graph does not allow is refused before anything is read", async () => {
    const { resolve, listed } = context();
    await expect(resolve({ entity: "Deal", id: "deal-1" }, "relationId.missing", { tenantId })).rejects.toMatchObject({ operationError: { code: "INVALID_VALUE" } });
    expect(listed).toEqual([]);
  });

  test("no entity graph, no resolver", () => {
    const value = { session: { tenantId }, platform: { schemas: {} } } as unknown as ModuleOperationContext;
    expect(pathResolver(value, operations, canonicalReader(value, operations))).toBeUndefined();
  });
});
