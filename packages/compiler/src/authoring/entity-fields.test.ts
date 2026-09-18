// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { deriveEntityOsfTypes, deriveProviderOsfTypes, normalizeEntityFields } from "./entity-fields.js";
import { resolveStorageColumns } from "./compiler/storage.js";
import { resolveRelationships } from "./compiler/relationships.js";
import { resolveModelFields } from "./compiler/model.js";
import type { CoreEntity, Field, OperationCatalogDefinition } from "./types.js";
import { assertNoRelationshipsBlock, type LoadedArtifacts } from "./loader.js";

const entity = (name: string, fields: Field[]): CoreEntity => ({
  schemaVersion: 3, kind: "coreEntity", module: "core", entity: name, title: name, fields,
} as CoreEntity);
const page = entity("Page", []);
const block = entity("Block", [{ key: "page", osfType: "Page", required: true, relationship: { inverse: { key: "blocks", ownership: "owned", sortable: true } } }]);
const catalog = () => deriveEntityOsfTypes([page, block], {
  title: { label: { en: "Title" }, valueType: "string" },
});

describe("one relational field contract", () => {
  test("derives an entity type and its presentation from the loaded entity", () => {
    expect(catalog().Block).toMatchObject({ kind: "entity", entity: "Block", valueType: "string", shape: block.fields });
    expect(catalog().Page).toMatchObject({ shape: [{ key: "blocks", osfType: "Block", cardinality: "collection", sortable: true, relationship: { inverse: "page", ownership: "owned" } }] });
    expect(() => deriveEntityOsfTypes([block], { Block: catalog().Block! })).toThrow("PascalCase names are entities");
  });
  test("infers scalar types without duplicate authoring", () => {
    expect(normalizeEntityFields(entity("Article", [{ key: "heading", osfType: "title" }]), catalog()).fields[0]?.baseType).toBe("string");
  });
  test("rejects a missing or unknown osfType for both values and nested leaves", () => {
    expect(() => normalizeEntityFields(entity("Article", [{ key: "content" } as Field]), catalog())).toThrow("osfType is required");
    expect(() => normalizeEntityFields(entity("Article", [{ key: "content", osfType: "nope" }]), catalog())).toThrow("unknown osfType nope");
    expect(() => normalizeEntityFields(entity("Article", [
      { key: "content", osfType: "object", children: [{ key: "heading", osfType: "nope" }] },
    ]), catalog())).toThrow("unknown osfType nope");
  });
  test("makes a single reference a real required uuid column", () => {
    const normalized = normalizeEntityFields(block, catalog());
    const rels = resolveRelationships({ coreEntity: normalized, profiles: [] } as unknown as LoadedArtifacts);
    expect(rels).toMatchObject([{ key: "page", fieldKey: "page", kind: "belongsTo", target: "Page", foreignKey: "page_id" }]);
    expect(resolveStorageColumns(normalized.fields, [])).toEqual([
      { field: "page", column: "page_id", type: "uuid", nullable: false, storageClass: "core" },
    ]);
  });
  test("inverse relationships are references, not infinitely recursive inline shapes", () => {
    const normalized = normalizeEntityFields(page, catalog());
    const fields = resolveModelFields(normalized.fields, { defaults: {}, components: {}, viewDefaults: {}, schemaVersion: 1, kind: "componentCatalog" }, catalog());
    expect(fields[0]?.children).toBeUndefined();
    expect(fields[0]?.relationship?.target).toBe("Block");
  });
  test("ordered owned collections resolve the inverse FK and never emit JSONB", () => {
    const normalized = normalizeEntityFields(page, catalog());
    const rels = resolveRelationships({ coreEntity: normalized, profiles: [] } as unknown as LoadedArtifacts);
    expect(rels).toMatchObject([{ key: "blocks", kind: "hasMany", target: "Block", foreignKey: "page_id", ownership: "owned", sortable: true }]);
    expect(resolveStorageColumns(normalized.fields, [])).toEqual([]);
    expect(normalized.fields.map((field) => field.key)).toEqual(["blocks"]);
  });
  test("refuses an authored collection: the inverse is derived from the referencing field", () => {
    const source = entity("Article", [{ key: "relatedPages", osfType: "Page", cardinality: "collection" }]);
    expect(() => deriveEntityOsfTypes([page, block, source], {})).toThrow("inverse collections are derived from the referencing field");
    expect(() => normalizeEntityFields(source, catalog())).toThrow("names the referencing field on Page as its inverse");
  });
  test("rejects an entity-level relationships block and an invalid inverse", () => {
    expect(() => assertNoRelationshipsBlock({ ...page, relationships: [{ key: "blocks" }] }, "page.yaml")).toThrow("Page declares relationships (blocks); relationships are fields");
    const article = entity("Article", [{ key: "blocks", osfType: "Block", cardinality: "collection", relationship: { inverse: "page", via: "page" } }]);
    expect(() => normalizeEntityFields(article, catalog())).toThrow("via requires");
  });
  test("rejects relation collections persisted as JSON or entity IDs nested in JSON", () => {
    expect(() => normalizeEntityFields(entity("Page", [{ ...catalog().Page!.shape![0]!, persisted: { column: "blocks", storageClass: "core" } }]), catalog())).toThrow("never a JSON");
    expect(() => normalizeEntityFields(entity("Article", [{ key: "values", osfType: "object", children: [{ key: "page", osfType: "Page" }] }]), catalog())).toThrow("not IDs inside JSON");
  });
  test("validates cardinality and sortable independently of the interface", () => {
    expect(() => normalizeEntityFields(entity("Article", [{ key: "title", osfType: "string", sortable: true }]), catalog())).toThrow("requires a collection");
    expect(() => normalizeEntityFields(entity("Article", [{ key: "titles", osfType: "string", cardinality: { min: 3, max: 2 } }]), catalog())).toThrow("invalid cardinality");
  });
  test("does not mutate authored inputs and normalizes deterministically", () => {
    const before = structuredClone(page);
    const normalized = normalizeEntityFields(page, catalog());
    expect(normalizeEntityFields(normalized, catalog())).toEqual(normalized);
    expect(page).toEqual(before);
  });
  test("inferred primary identity validation reaches UUID storage", () => {
    const normalized = normalizeEntityFields(entity("Page", [{ key: "id", osfType: "pageId", persisted: { column: "id", storageClass: "core" } }]), catalog());
    expect(resolveStorageColumns(normalized.fields, [])[0]?.type).toBe("uuid");
  });
  test("refuses identity aliases as untracked foreign IDs", () => {
    expect(() => normalizeEntityFields(entity("Article", [{ key: "pageId", osfType: "pageId", persisted: { column: "page_id", storageClass: "core" } }]), catalog())).toThrow("use the entity osfType");
  });
  test("inline identifier values retain scalar semantics without claiming a foreign key", () => {
    const source = entity("Article", [{ key: "configuration", osfType: "object", children: [{ key: "pageId", osfType: "pageId", options: { type: "remote", remoteUrl: "/pages" } }] }]);
    const normalized = normalizeEntityFields(source, catalog());
    expect(normalized.fields[0]?.children?.[0]).toMatchObject({ osfType: "pageId", baseType: "string", validation: { format: "uuid" }, options: { remoteUrl: "/pages" } });
    expect(normalized.fields[0]?.children?.[0]?.relationship).toBeUndefined();
    expect(normalized.fields[0]?.children?.[0]?.persisted).toBeUndefined();
    for (const invalid of [{ persisted: { column: "page_id", storageClass: "core" } }, { relationship: { ownership: "reference" } }]) {
      const guarded = structuredClone(source);
      Object.assign(guarded.fields[0]!.children![0]!, invalid);
      expect(() => normalizeEntityFields(guarded, catalog())).toThrow("inline identifier values cannot declare relational storage");
    }
    source.fields[0]!.children![0]!.osfType = "Page";
    expect(() => normalizeEntityFields(source, catalog())).toThrow("not IDs inside JSON");
  });
  test("cannot hide an entity reference inside an object semantic type", () => {
    const types = { ...catalog(), hiddenReference: { label: { en: "Hidden" }, valueType: "object" as const, shape: [{ key: "page", osfType: "Page" }] } };
    expect(() => normalizeEntityFields(entity("Article", [{ key: "values", osfType: "hiddenReference" }]), types)).toThrow("not IDs inside JSON");
  });
  test("validates inherited collection items and refuses recursive item types", () => {
    const types = {
      ...catalog(),
      referenceItems: { label: { en: "Items" }, valueType: "object" as const, cardinality: "collection" as const, item: { key: "item", osfType: "Page" } },
      recursiveItems: { label: { en: "Recursive" }, valueType: "object" as const, cardinality: "collection" as const, item: { key: "item", osfType: "recursiveItems" } },
    };
    expect(() => normalizeEntityFields(entity("Article", [{ key: "values", osfType: "referenceItems" }]), types)).toThrow("not IDs inside JSON");
    expect(() => normalizeEntityFields(entity("Article", [{ key: "values", osfType: "recursiveItems" }]), types)).toThrow("cyclic inline");
  });
  test("accepts canonical relation fields from operation-backed version 2 onward", () => {
    expect(() => normalizeEntityFields({ ...block, schemaVersion: 1 }, catalog())).toThrow("require schemaVersion 2 or 3");
    expect(normalizeEntityFields({ ...block, schemaVersion: 2 }, catalog()).fields[0]?.relationship?.target).toBe("Page");
  });
  test("refuses ownership and field-key inverses on a single reference", () => {
    expect(() => normalizeEntityFields(entity("Block", [{ key: "page", osfType: "Page", relationship: { ownership: "owned" } }]), catalog())).toThrow("single owned");
    const left = entity("Left", [{ key: "right", osfType: "Right", relationship: { inverse: "left" } }]);
    const right = entity("Right", [{ key: "left", osfType: "Left", relationship: { inverse: {} } }]);
    expect(() => deriveEntityOsfTypes([left, right], {})).toThrow("a single reference names its inverse collection as an object");
    expect(() => normalizeEntityFields(left, deriveEntityOsfTypes([{ ...left, fields: [] }, { ...right, fields: [] }], {}))).toThrow("declares its inverse collection as an object");
  });
});

describe("provider-backed reference", () => {
  const accountCatalog = {
    kind: "operationCatalog",
    interfaces: { web: { pages: {}, operations: {}, entities: {
      Account: { title: { en: "Account" }, route: "/accounts", idField: "id", displayField: "email", fields: ["id", "email"], columns: ["email"], operations: { list: { operation: "listAccounts", resultField: "accounts" } } },
    } } },
  } as unknown as OperationCatalogDefinition;
  const withProviders = () => deriveProviderOsfTypes([accountCatalog], catalog());
  const relation = (account: Field) => entity("Relation", [{ key: "id", osfType: "string" }, account]);

  test("registers a catalog's web entities as provider osf types, next to the loaded entities", () => {
    expect(withProviders().Account).toEqual({ kind: "provider", entity: "Account", valueType: "object", label: { en: "Account" } });
    expect(withProviders().Block).toMatchObject({ kind: "entity" });
    expect(() => deriveProviderOsfTypes([accountCatalog], withProviders())).toThrow("duplicates a loaded entity or provider entity");
  });
  test("a single reference becomes a read-only belongsTo without storage, bound from this entity's fields", () => {
    const normalized = normalizeEntityFields(relation({ key: "account", osfType: "Account", provider: { bindings: { relationId: "id" } } }), withProviders());
    const account = normalized.fields.find((field) => field.key === "account")!;
    expect(account).toMatchObject({ readOnly: true, baseType: "object" });
    expect(account.persisted).toBeUndefined();
    expect(resolveRelationships({ coreEntity: normalized, profiles: [] } as unknown as LoadedArtifacts)).toEqual([
      { key: "account", fieldKey: "account", kind: "belongsTo", target: "Account", ownership: "reference", provider: { bindings: { relationId: "id" } } },
    ]);
    expect(resolveStorageColumns(normalized.fields, [])).toEqual([]);
  });
  test("a collection reference becomes a hasMany with the same binding", () => {
    const normalized = normalizeEntityFields(relation({ key: "accounts", osfType: "Account", cardinality: "collection", provider: { bindings: { relationId: "id" } } }), withProviders());
    expect(normalized.fields.find((field) => field.key === "accounts")?.relationship).toMatchObject({ kind: "hasMany", target: "Account", provider: { bindings: { relationId: "id" } } });
  });
  test("refuses storage, relationship metadata, empty or dangling bindings, and provider on a stored entity", () => {
    expect(() => normalizeEntityFields(relation({ key: "account", osfType: "Account", provider: { bindings: { relationId: "id" } }, persisted: { column: "account_id", storageClass: "core" } }), withProviders())).toThrow("has no storage of its own");
    expect(() => normalizeEntityFields(relation({ key: "account", osfType: "Account", provider: { bindings: { relationId: "id" } }, relationship: { ownership: "owned" } }), withProviders())).toThrow("not relationship metadata");
    expect(() => normalizeEntityFields(relation({ key: "account", osfType: "Account" }), withProviders())).toThrow("provider.bindings maps Account Operation input fields");
    expect(() => normalizeEntityFields(relation({ key: "account", osfType: "Account", provider: { bindings: { relationId: "nope" } } }), withProviders())).toThrow("names unknown field Relation.nope");
    expect(() => normalizeEntityFields(relation({ key: "page", osfType: "Page", provider: { bindings: { relationId: "id" } } }), withProviders())).toThrow("provider requires an osfType that names a provider-backed entity");
  });
});
