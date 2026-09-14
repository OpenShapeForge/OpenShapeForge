// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { deriveEntitySemanticTypes, normalizeEntityFields } from "./entity-fields.js";
import { resolveStorageColumns } from "./compiler/storage.js";
import { resolveRelationships } from "./compiler/relationships.js";
import { resolveModelFields } from "./compiler/model.js";
import type { CoreEntity, Field } from "./types.js";
import type { LoadedArtifacts } from "./loader.js";

const entity = (name: string, fields: Field[]): CoreEntity => ({
  schemaVersion: 3, kind: "coreEntity", module: "core", entity: name, title: name, fields,
} as CoreEntity);
const page = entity("Page", [{ key: "blocks", semanticType: "Block", cardinality: { min: 1, max: "unbounded" }, sortable: true, relationship: { inverse: "page", ownership: "owned" } }]);
const block = entity("Block", [{ key: "page", semanticType: "Page", required: true }]);
const catalog = () => deriveEntitySemanticTypes([page, block], {
  title: { label: { en: "Title" }, valueType: "string" },
});

describe("one relational field contract", () => {
  test("derives an entity type and its presentation from the loaded entity", () => {
    expect(catalog().Block).toMatchObject({ kind: "entity", entity: "Block", valueType: "string", shape: block.fields });
    expect(() => deriveEntitySemanticTypes([block], { Block: catalog().Block! })).toThrow("duplicates");
  });
  test("infers scalar types without duplicate authoring", () => {
    expect(normalizeEntityFields(entity("Article", [{ key: "heading", semanticType: "title" }]), catalog()).fields[0]?.valueType).toBe("string");
  });
  test("makes a single reference a real required uuid column", () => {
    const normalized = normalizeEntityFields(block, catalog());
    const rels = resolveRelationships({ coreEntity: normalized, profiles: [] } as unknown as LoadedArtifacts);
    expect(rels).toMatchObject([{ key: "page", fieldKey: "page", kind: "belongsTo", target: "Page", foreignKey: "page_id" }]);
    expect(resolveStorageColumns(normalized.fields, [], rels)).toEqual([
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
    expect(resolveStorageColumns(normalized.fields, [], rels)).toEqual([]);
    expect(normalized.fields[0]?.required).toBe(true);
  });
  test("unidirectional collections normalize to a deterministic association", () => {
    const source = entity("Article", [{ key: "relatedPages", semanticType: "Page", cardinality: "collection" }]);
    const normalized = normalizeEntityFields(source, catalog());
    const rels = resolveRelationships({ coreEntity: normalized, profiles: [] } as unknown as LoadedArtifacts);
    expect(rels).toMatchObject([{ kind: "manyToMany", via: "articles_related_pages", target: "Page" }]);
  });
  test("rejects a second relationship declaration and invalid inverse", () => {
    expect(() => normalizeEntityFields({ ...page, relationships: [] }, catalog())).toThrow("belong on fields");
    expect(() => normalizeEntityFields(entity("Article", page.fields), catalog())).toThrow("must refer to Article");
  });
  test("rejects relation collections persisted as JSON or entity IDs nested in JSON", () => {
    expect(() => normalizeEntityFields(entity("Page", [{ ...page.fields[0]!, persisted: { column: "blocks", storageClass: "core" } }]), catalog())).toThrow("never a JSON");
    expect(() => normalizeEntityFields(entity("Article", [{ key: "values", valueType: "object", children: [{ key: "page", semanticType: "Page" }] }]), catalog())).toThrow("not IDs inside JSON");
  });
  test("validates cardinality and sortable independently of the interface", () => {
    expect(() => normalizeEntityFields(entity("Article", [{ key: "title", valueType: "string", sortable: true }]), catalog())).toThrow("requires a collection");
    expect(() => normalizeEntityFields(entity("Article", [{ key: "titles", valueType: "string", cardinality: { min: 3, max: 2 } }]), catalog())).toThrow("invalid cardinality");
  });
  test("does not mutate authored inputs and normalizes deterministically", () => {
    const before = structuredClone(page);
    const normalized = normalizeEntityFields(page, catalog());
    expect(normalizeEntityFields(normalized, catalog())).toEqual(normalized);
    expect(page).toEqual(before);
  });
  test("inferred primary identity validation reaches UUID storage", () => {
    const normalized = normalizeEntityFields(entity("Page", [{ key: "id", semanticType: "pageId", persisted: { column: "id", storageClass: "core" } }]), catalog());
    expect(resolveStorageColumns(normalized.fields, [], [])[0]?.type).toBe("uuid");
  });
  test("refuses identity aliases as untracked foreign IDs", () => {
    expect(() => normalizeEntityFields(entity("Article", [{ key: "pageId", semanticType: "pageId", persisted: { column: "page_id", storageClass: "core" } }]), catalog())).toThrow("use the entity semanticType");
  });
  test("cannot hide an entity reference inside an object semantic type", () => {
    const types = { ...catalog(), hiddenReference: { label: { en: "Hidden" }, valueType: "object" as const, shape: [{ key: "page", semanticType: "Page" }] } };
    expect(() => normalizeEntityFields(entity("Article", [{ key: "values", semanticType: "hiddenReference" }]), types)).toThrow("not IDs inside JSON");
  });
  test("validates inherited collection items and refuses recursive item types", () => {
    const types = {
      ...catalog(),
      referenceItems: { label: { en: "Items" }, valueType: "object" as const, cardinality: "collection" as const, item: { key: "item", semanticType: "Page" } },
      recursiveItems: { label: { en: "Recursive" }, valueType: "object" as const, cardinality: "collection" as const, item: { key: "item", semanticType: "recursiveItems" } },
    };
    expect(() => normalizeEntityFields(entity("Article", [{ key: "values", semanticType: "referenceItems" }]), types)).toThrow("not IDs inside JSON");
    expect(() => normalizeEntityFields(entity("Article", [{ key: "values", semanticType: "recursiveItems" }]), types)).toThrow("cyclic inline");
  });
  test("does not accept new relation declarations under an old version's weaker guarantees", () => {
    for (const schemaVersion of [1, 2]) expect(() => normalizeEntityFields({ ...block, schemaVersion }, catalog())).toThrow("require schemaVersion 3");
  });
  test("refuses ownership and one-to-one shapes without a canonical physical owner", () => {
    expect(() => normalizeEntityFields(entity("Block", [{ key: "page", semanticType: "Page", relationship: { ownership: "owned" } }]), catalog())).toThrow("single owned");
    const left = entity("Left", [{ key: "right", semanticType: "Right", relationship: { inverse: "left" } }]);
    const right = entity("Right", [{ key: "left", semanticType: "Left", relationship: { inverse: "right" } }]);
    expect(() => normalizeEntityFields(left, deriveEntitySemanticTypes([left, right], {}))).toThrow("one-to-one");
  });
});
