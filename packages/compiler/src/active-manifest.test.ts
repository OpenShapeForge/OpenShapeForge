// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { mergePromotedTables } from "./active-manifest.js";
import { generateArtifacts } from "./generate.js";
import type { PlatformSchemaManifest } from "./schema.js";

test("active composition retains generated entityValue metadata and cross-module reference registrations", () => {
  const relationship = {
    from: { schema: "erp", table: "placements", column: "typed_reference_id" },
    to: { schema: "library", table: "resources", column: "id" },
  };
  const base: PlatformSchemaManifest = { version: 1, tables: [], relationshipRegister: [relationship] };
  const promoted: PlatformSchemaManifest = {
    version: 1, tables: [], relationshipRegister: [relationship],
    entityValues: { version: 1, carriers: [], collections: [] },
  };
  expect(mergePromotedTables(base, promoted).relationshipRegister).toEqual([relationship]);
  expect(mergePromotedTables({ ...base, relationshipRegister: [] }, promoted).relationshipRegister).toEqual([relationship]);
  const result = mergePromotedTables(base, promoted);
  expect(result.entityValues).toEqual(promoted.entityValues);
  const artifact = generateArtifacts(result).find((entry) => entry.path.endsWith("db/manifest.json"))!;
  expect(JSON.parse(artifact.contents).entityValues).toEqual(promoted.entityValues);
});

test("active composition carries the extension registry into manifest.json, and moves the checksum with it", () => {
  const extensionRegistry = {
    entities: {}, indexProjections: { measurement: { number: "value", text: "unit" } },
    referencedBy: { Product: [{ sourceEntity: "Product", valuesTable: "erp.products_field_values" }] },
    childRelations: {},
    readAccess: { Product: { table: "erp.products", roles: ["Catalogue.Read"] } },
  };
  const base: PlatformSchemaManifest = { version: 1, tables: [] };
  const result = mergePromotedTables(base, { version: 1, tables: [], extensionRegistry });
  expect(result.extensionRegistry).toEqual(extensionRegistry);
  const rendered = (manifest: PlatformSchemaManifest) =>
    JSON.parse(generateArtifacts(manifest).find((entry) => entry.path.endsWith("db/manifest.json"))!.contents);
  expect(rendered(result).extensionRegistry).toEqual(extensionRegistry);
  expect(rendered(mergePromotedTables(base, { version: 1, tables: [] })).extensionRegistry).toBeUndefined();
  expect(rendered(result).checksum).not.toBe(rendered(mergePromotedTables(base, { version: 1, tables: [] })).checksum);
});
