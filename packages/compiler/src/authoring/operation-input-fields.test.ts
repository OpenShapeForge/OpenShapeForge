// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { operationInputFieldsKeyword } from "@openshapeforge/operations";
import { loadEntity } from "./loader.js";
import { assertEntityAuthoring } from "./entity-authoring.js";
import { compile } from "./compiler/index.js";
import { buildWebManifest } from "./web-manifest.js";
import { loadActivePlatformCompile, resolveActiveAuthoringDir } from "../active-manifest.js";
import { corpusWebOperations } from "./corpus-web.fixtures.js";

const source = () => {
  const authoringDir = join(import.meta.dir, "../../config/authoring");
  const artifacts = loadEntity(authoringDir, "template-version");
  const template = loadEntity(authoringDir, "template").coreEntity;
  const parameterField = template.fields.find(field => field.key === "parameters")!;
  artifacts.coreEntity.fields.push(structuredClone(parameterField));
  const materializeSchema = artifacts.coreEntity.operations!.materialize!.input!.schema as {
    properties: Record<string, unknown>;
  };
  const materializeParameters = materializeSchema.properties.parameters as Record<string, unknown>;
  materializeParameters["x-osf-inputFields"] = "parameters";
  return artifacts;
};

test("input-field annotation uses the target record's fieldDefinition collection", async () => {
  const artifacts = source();
  expect(() => assertEntityAuthoring(artifacts.coreEntity, "template-version.yaml")).not.toThrow();
  const contract = compile(artifacts);
  const operation = contract.pluginOperations!.find(operation => operation.key === "materialize")!;
  expect((operation.definition.input!.schema.properties as Record<string, unknown>).parameters).toMatchObject({ "x-osf-inputFields": "parameters" });
  const root = join(import.meta.dir, "../../../..");
  const active = await loadActivePlatformCompile(root);
  const web = buildWebManifest(active.entities, { requireTranslations: true }, corpusWebOperations(resolveActiveAuthoringDir(root)));
  expect(web.entities.TemplateVersion!.operations.materialize).toBeDefined();
  expect(web.entities.TemplateVersion!.operations.materialize!.input).toMatchObject({ kind: "json-schema" });
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
    expect(() => assertEntityAuthoring(coreEntity, "test.yaml")).toThrow("fieldDefinition collection on its target record");
  }
});

test("input-field annotation rejects collection-scoped operations and scalar definitions", () => {
  const { coreEntity } = source();
  coreEntity.operations!.materialize!.target = { scope: "collection" };
  expect(() => assertEntityAuthoring(coreEntity, "test.yaml")).toThrow("target record");
  const other = source().coreEntity;
  other.fields.find(field => field.key === "parameters")!.cardinality = "single";
  expect(() => assertEntityAuthoring(other, "test.yaml")).toThrow("fieldDefinition collection");
});

test("shared AJV keyword is presentation only and validates its source-key shape", () => {
  const ajv = new Ajv2020({ strict: true });
  ajv.addKeyword(operationInputFieldsKeyword);
  const validate = ajv.compile({ type: "object", "x-osf-inputFields": "parameters" });
  expect(validate({ arbitrary: "still requires canonical handler validation" })).toBe(true);
  expect(() => ajv.compile({ type: "object", "x-osf-inputFields": ["parameters"] })).toThrow();
});

test("input.field names the collection of the record a sibling reference input picks; the sibling must be a reference", () => {
  const ajv = new Ajv2020({ strict: true });
  ajv.addKeyword(operationInputFieldsKeyword);
  expect(() => ajv.compile({ type: "object", "x-osf-inputFields": "templateVersionId.parameters" })).not.toThrow();
  for (const bad of ["a.b.c", ".parameters", "templateVersionId."]) expect(() => ajv.compile({ type: "object", "x-osf-inputFields": bad })).toThrow();
  const withSibling = (sibling: Record<string, unknown> | undefined) => {
    const { coreEntity } = source();
    const operation = coreEntity.operations!.materialize!;
    operation.target = { scope: "collection" };
    const properties = operation.input!.schema.properties as Record<string, Record<string, unknown>>;
    properties.parameters!["x-osf-inputFields"] = "pick.parameters";
    if (sibling) properties.pick = sibling;
    return coreEntity;
  };
  expect(() => assertEntityAuthoring(withSibling({ type: "string", format: "uuid", "x-osf-reference": { entity: "Template", valueField: "publishedVersionId" } }), "test.yaml")).not.toThrow();
  expect(() => assertEntityAuthoring(withSibling(undefined), "test.yaml")).toThrow("sibling input with an x-osf-reference");
  expect(() => assertEntityAuthoring(withSibling({ type: "string" }), "test.yaml")).toThrow("sibling input with an x-osf-reference");
});
