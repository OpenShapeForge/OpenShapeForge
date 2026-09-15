// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compile } from "./compiler/index.js";
import { loadEntity } from "./loader.js";
import { buildWebManifest } from "./web-manifest.js";
import { writableEntityFields } from "../entity-operation-json-schema.js";

const authoring = join(import.meta.dir, "../../config/authoring");
const slugs = ["template", "template-version", "template-variant", "block"];
const allSlugs = [...slugs, "text-block", "youtube-embed", "template-block"];
const entries = allSlugs.map((slug) => {
  const loaded = loadEntity(authoring, slug);
  return { slug, path: `entities/core/${slug}.yaml`, origin: "core" as const, contract: compile(loaded) };
});

describe("the authored template chain", () => {
  test("uses only field relationships and preserves administrator writes", () => {
    for (const slug of slugs) {
      const entity = loadEntity(authoring, slug).coreEntity;
      expect(entity.schemaVersion).toBe(3);
      expect(entity.relationships).toBeUndefined();
      expect(entity.authorization?.roles.create).toEqual(["Organization.All.ReadWrite"]);
    }
  });
  test("projects four real routes without advertising unsupported child creation", () => {
    const web = buildWebManifest(entries);
    expect(Object.keys(web.entities).sort()).toEqual(["Block", "Template", "TemplateVariant", "TemplateVersion"]);
    expect(web.entities.Template?.views.record?.routes.create).toBe("/templates/new");
    expect(web.entities.Template?.fields.key?.supports).toEqual({ read: true, create: false, update: false });
    expect(JSON.stringify(web.entities.Template?.views.record?.formGroups)).not.toContain('"key"');
    for (const name of ["Block", "TemplateVariant", "TemplateVersion"]) {
      expect(web.entities[name]?.unsupportedOperations?.create?.code).toBe("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
      expect(web.entities[name]?.operations.create).toBeUndefined();
    }
  });
  test("derives the internal template key once from its name", () => {
    const template = entries.find((entry) => entry.slug === "template")!.contract;
    expect(template.model.fields.find((field) => field.key === "key")?.deriveOnCreate).toEqual({
      from: "name",
      transform: "slug",
      onConflict: "suffix",
    });
    expect(writableEntityFields(template.model.fields, "create").map((field) => field.key)).not.toContain("key");
    expect(writableEntityFields(template.model.fields, "update").map((field) => field.key)).not.toContain("key");
  });
  test("block order is a relation property, never an array stored on a variant", () => {
    const variant = entries.find((entry) => entry.slug === "template-variant")!.contract;
    expect(variant.storage.columns.some((column) => column.field === "blocks")).toBe(false);
    expect(variant.model.relationships.find((relationship) => relationship.key === "blocks")).toMatchObject({
      kind: "hasMany", target: "Block", inverse: "variant", sortable: true, ownership: "owned",
    });
  });
});
