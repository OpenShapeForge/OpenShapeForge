// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { collectionManagedFields, collectionMutationError, withoutCollectionInputs } from "./collection-policy.js";
import type { GeneratedCrudTable } from "./types.js";

const columns = (keys: string[]) => keys.map((name) => ({ name, type: "uuid", primaryKey: name === "id", required: false, generated: null }));
const parent: GeneratedCrudTable = {
  name: "erp.pages", schema: "erp", table: "pages", tenantScoped: true, domainInternal: false, generatedCrud: true, primaryKey: "id",
  columns: columns(["id", "tenant_id"]),
  source: { authoringVersion: 3, graphql: {
    typeName: "Page", singleQueryName: "page", listQueryName: "pages", createMutationName: "createPage", updateMutationName: "updatePage", deleteMutationName: "deletePage",
    relationships: [{ name: "blocks", fieldKey: "blocks", target: "Block", type: "[Block!]!", resolve: "hasMany", kind: "hasMany", ownership: "owned", foreignKey: "page_id", sortable: true, positionColumn: "page_id_position", cardinality: { min: 1, max: 5 } }],
  } },
};
const child: GeneratedCrudTable = {
  ...parent, name: "erp.blocks", table: "blocks",
  columns: [...columns(["id", "tenant_id"]), { ...columns(["page_id"])[0]!, sourceField: "page" }, { ...columns(["page_id_position"])[0]!, type: "integer", required: true }],
  source: { authoringVersion: 3, graphql: { ...parent.source!.graphql!, typeName: "Block", relationships: [] } },
};

describe("unsupported collection mutation boundary", () => {
  test("excludes collection fields and both authored/storage inverse keys including internal position", () => {
    expect([...collectionManagedFields(parent, [parent, child])]).toEqual(["blocks"]);
    expect([...collectionManagedFields(child, [parent, child])]).toEqual(["page_id", "page", "page_id_position", "pageIdPosition"]);
  });
  test("refuses explicit arrays, inverse assignments and direct position writes", () => {
    for (const [table, values] of [[parent, { blocks: [] }], [child, { page: "id" }], [child, { pageIdPosition: 2 }]] as const) {
      expect(collectionMutationError(table, "update", [parent, child], values)?.code).toBe("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    }
  });
  test("required collections cannot be created empty and collection-affecting deletes are refused", () => {
    expect(collectionMutationError(parent, "create", [parent, child])?.code).toBe("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    expect(collectionMutationError(parent, "delete", [parent, child])?.code).toBe("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    expect(collectionMutationError(child, "delete", [parent, child])?.code).toBe("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
    expect(collectionMutationError(parent, "update", [parent, child], { title: "Safe scalar update" })).toBeUndefined();
    expect(collectionMutationError(parent, "get", [parent, child])).toBeUndefined();
  });
  test("reference collections do not take ownership of standalone child mutations", () => {
    const referenceParent = structuredClone(parent);
    referenceParent.source!.graphql!.relationships![0]!.ownership = "reference";
    expect([...collectionManagedFields(child, [referenceParent, child])]).toEqual([]);
    expect(collectionMutationError(child, "create", [referenceParent, child])).toBeUndefined();
    expect(collectionMutationError(child, "delete", [referenceParent, child])).toBeUndefined();
  });
  test("transport projection removes unsupported properties and required entries without mutating input", () => {
    const schema = { type: "object", properties: { values: { type: "object", properties: { blocks: { type: "array" }, title: { type: "string" } }, required: ["blocks", "title"], additionalProperties: false } } };
    const result = withoutCollectionInputs(schema, new Set(["blocks"]));
    expect(result).toEqual({ type: "object", properties: { values: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } } });
    expect(schema.properties.values.properties.blocks).toBeDefined();
  });
  test("legacy scalar updates remain unchanged", () => {
    const legacy = { ...parent, source: { authoringVersion: 2 as const } };
    expect(collectionMutationError(legacy, "create", [legacy], { title: "Example" })).toBeUndefined();
    const schema = { type: "object" };
    expect(withoutCollectionInputs(schema, new Set())).toBe(schema);
  });
});
