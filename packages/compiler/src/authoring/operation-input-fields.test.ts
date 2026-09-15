// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { operationInputFieldsKeyword } from "@openshapeforge/operations";
import { loadEntity } from "./loader.js";
import { assertV2Authoring } from "./entity-v2.js";
import { compile } from "./compiler/index.js";
import { buildWebManifest } from "./web-manifest.js";
import { loadActivePlatformCompile } from "../active-manifest.js";

const source = () => loadEntity(join(import.meta.dir, "../../config/authoring"), "template-version");

test("input-field annotation uses the target record's fieldDefinition collection", async () => {
  const artifacts = source();
  expect(() => assertV2Authoring(artifacts.coreEntity, "template-version.yaml")).not.toThrow();
  const contract = compile(artifacts);
  const operation = contract.pluginOperations!.find(operation => operation.key === "materialize")!;
  expect((operation.definition.input!.schema.properties as Record<string, unknown>).parameters).toMatchObject({ "x-osf-inputFields": "parameters" });
  const active = await loadActivePlatformCompile(join(import.meta.dir, "../../../.."));
  const web = buildWebManifest(active.entities, { requireTranslations: true });
  expect(web.entities.TemplateVersion!.operations.materialize).toBeDefined();
  expect(web.entities.LabelRule!.views.record!.badges).toEqual(["variant", "active"]);
  expect(web.entities.LabelRule!.views.record!.variableSources).toEqual([
    { key: "entityFields", resolver: "entityFields", params: { sourceField: "entityType" } },
    { key: "chips", resolver: "chips" },
  ]);
}, 30_000);

test("input-field annotation cannot name a missing field or non-definition field", () => {
  for (const name of ["missing", "status", "id", "variants"]) {
    const { coreEntity } = source();
    ((coreEntity.operations!.materialize!.input!.schema.properties as Record<string, unknown>).parameters as Record<string, unknown>)["x-osf-inputFields"] = name;
    expect(() => assertV2Authoring(coreEntity, "test.yaml")).toThrow("fieldDefinition collection on its target record");
  }
});

test("input-field annotation rejects collection-scoped operations and scalar definitions", () => {
  const { coreEntity } = source();
  coreEntity.operations!.materialize!.target = { scope: "collection" };
  expect(() => assertV2Authoring(coreEntity, "test.yaml")).toThrow("target record");
  const other = source().coreEntity;
  other.fields.find(field => field.key === "parameters")!.cardinality = "single";
  expect(() => assertV2Authoring(other, "test.yaml")).toThrow("fieldDefinition collection");
});

test("shared AJV keyword is presentation only and validates its source-key shape", () => {
  const ajv = new Ajv2020({ strict: true });
  ajv.addKeyword(operationInputFieldsKeyword);
  const validate = ajv.compile({ type: "object", "x-osf-inputFields": "parameters" });
  expect(validate({ arbitrary: "still requires canonical handler validation" })).toBe(true);
  expect(() => ajv.compile({ type: "object", "x-osf-inputFields": ["parameters"] })).toThrow();
});
