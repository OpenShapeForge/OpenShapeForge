// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { createRuntimeFieldSchemaCompiler, runtimeJsonSchemas, storedFieldBaseType } from "../field-schemas.js";
import generatedCatalog from "../../generated/operations/catalog.json" with { type: "json" };

const compiler = createRuntimeFieldSchemaCompiler({
  version: 1,
  fieldDefinitionSchema: {
    type: "object",
    required: ["key", "osfType"],
    additionalProperties: false,
    properties: {
      key: { type: "string", minLength: 1 },
      osfType: { enum: ["string", "integer", "object", "code", "fieldDefinition"] },
      required: { type: "boolean" },
      cardinality: { enum: ["single", "collection"] },
    },
  },
  osfTypes: {
    code: {
      baseType: "string",
      label: { en: "Code" },
      validation: { minLength: 2, maxLength: 12 },
    },
    fieldDefinition: { baseType: "object", label: { en: "Field" }, schema: { $ref: "#/$defs/fieldDefinition" } },
  },
  fieldDefinitionDefinitions: {
    fieldDefinition: {
      type: "object", required: ["key", "osfType"], additionalProperties: false,
      properties: {
        key: { type: "string", minLength: 1 },
        osfType: { enum: ["string", "object"] },
        children: { type: "array", items: { $ref: "#/$defs/fieldDefinition" } },
      },
    },
  },
});

test("stored field values use semantic validation and retain invalid input untouched", () => {
  const fields = [{ key: "code", osfType: "code", required: true }];
  expect(compiler.validateObject(fields, { code: "OK" })).toEqual({ valid: true });
  for (const values of [{}, { code: "X" }, { code: { secret: "PRIVATE_VALUE" } }, { code: 123 }, { code: "OK", extra: true }]) {
    const before = structuredClone(values);
    const result = compiler.validateObject(fields, values);
    expect(result).toMatchObject({ valid: false, error: { code: "VALIDATION_FAILED", retryable: false } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_VALUE");
    expect(values).toEqual(before);
  }
  expect(compiler.validateObject([{ key: "code", osfType: "unknown" }], {}))
    .toMatchObject({ valid: false, error: { code: "INVALID_DEFINITION" } });
});

test("JSON validation covers format, recursive local refs and collection bounds", () => {
  const schema = {
    type: "object", required: ["emails"], additionalProperties: false,
    properties: { emails: { type: "array", minItems: 1, maxItems: 2, items: { $ref: "#/$defs/email" } } },
    $defs: { email: { type: "string", format: "email" } },
  };
  expect(runtimeJsonSchemas.validate(schema, { emails: ["test@example.test"] })).toEqual({ valid: true });
  for (const values of [{ emails: [] }, { emails: ["invalid"] }, { emails: "test@example.test" },
    { emails: ["a@example.test", "b@example.test", "c@example.test"] }]) {
    expect(runtimeJsonSchemas.validate(schema, values)).toMatchObject({ valid: false, error: { code: "VALIDATION_FAILED" } });
  }
});

for (const entity of ["Document", "DocumentVersion"]) {
  test(`actual generated ${entity}.create schema accepts template preflight and verified artifact input`, () => {
    const operation = generatedCatalog.entityOperations.find(operation => operation.id === `${entity}.create`)!;
    expect(operation).toBeDefined();
    const schema = operation.input.schema as Record<string, unknown>;
    expect((schema.properties as Record<string, Record<string, unknown>>).artifact!["x-osf-control"]).toBe("artifact-upload");
    const id = "10000000-0000-4000-8000-000000000001";
    const metadata = {
      ...(entity === "Document" ? { document: { title: "Blokkenproef367", documentType: "memo", status: "draft", confidentiality: "internal" } } : { documentId: id }),
      version: { versionLabel: "1", status: "draft" }, idempotencyKey: "synthetic-materialization-regression",
    };
    const before = structuredClone(metadata);
    expect(runtimeJsonSchemas.validate(schema, metadata)).toEqual({ valid: true });
    expect(metadata).toEqual(before);
    expect(runtimeJsonSchemas.validate(schema, { ...metadata, artifact: { artifactId: id, expectedArtifactVersion: 1 } })).toEqual({ valid: true });
    for (const artifact of [{ artifactId: "invalid", expectedArtifactVersion: 1 }, { artifactId: id, expectedArtifactVersion: 0 },
      { artifactId: id }, { artifactId: id, expectedArtifactVersion: 1, mediaType: "application/json" }]) {
      expect(runtimeJsonSchemas.validate(schema, { ...metadata, artifact }))
        .toMatchObject({ valid: false, error: { code: "VALIDATION_FAILED" } });
    }
  });
}

test("presentation keyword support remains strict and preserves local reference validation", () => {
  const schema = { type: "object", properties: { artifact: { $ref: "#/$defs/artifact", "x-osf-control": "artifact-upload" } },
    $defs: { artifact: { type: "object", required: ["artifactId"], properties: { artifactId: { type: "string", format: "uuid" } } } } };
  expect(runtimeJsonSchemas.validate(schema, { artifact: { artifactId: "invalid" } }))
    .toMatchObject({ valid: false, error: { code: "VALIDATION_FAILED" } });
  for (const invalid of [{ type: "object", "x-osf-contorl": "artifact-upload" }, { type: "object", "x-osf-control": {} }]) {
    expect(runtimeJsonSchemas.validate(invalid, {})).toMatchObject({ valid: false, error: { code: "INVALID_DEFINITION" } });
  }
});

test("host-projected FieldDefinition values retain recursive local references", () => {
  const fields = [{
    key: "formFields", osfType: "fieldDefinition",
    cardinality: "collection", required: true,
  }];
  const values = { formFields: [{
    key: "address", osfType: "object",
    children: [{ key: "street", osfType: "string" }],
  }] };
  expect(compiler.validateObject(fields, values)).toEqual({ valid: true });
  expect(compiler.validateObject(fields, { formFields: [{ key: "address", osfType: "object", children: [{ key: "street" }] }] }))
    .toMatchObject({ valid: false, error: { code: "VALIDATION_FAILED" } });
});

test("JSON validation neither fills defaults nor loads external refs or asynchronous schemas", () => {
  const values = {};
  expect(runtimeJsonSchemas.validate({ type: "object", properties: { code: { type: "string", default: "filled" } } }, values))
    .toEqual({ valid: true });
  expect(values).toEqual({});
  for (const schema of [
    { $ref: "https://invalid.example.test/schema.json" },
    { type: "unknown" },
    { type: "string", format: "unsupported-format" },
    { type: "string", minLenght: 2 },
    { type: "object", properties: { code: { $async: true, type: "string" } } },
    { $ref: "#/$defs/code", $defs: { code: { $async: true, type: "string" } } },
    { $async: true, type: "string" },
  ]) {
    expect(runtimeJsonSchemas.validate(schema, "PRIVATE_VALUE"))
      .toMatchObject({ valid: false, error: { code: "INVALID_DEFINITION", retryable: false } });
  }
});

test("the host validates stored fields before using its active schema registry", () => {
  expect(compiler.object([{
    key: "code",
    osfType: "code",
    required: true,
  }])).toMatchObject({
    required: ["code"],
    properties: {
      code: { type: "string", title: "Code", minLength: 2, maxLength: 12 },
    },
  });

  expect(() => compiler.object([{
    key: "code",
    osfType: "unknown",
  }])).toThrow(/does not match the active authoring schema/);

  expect(() => compiler.object([
    { key: "code", osfType: "string" },
    { key: "code", osfType: "string" },
  ])).toThrow(/key "code" is duplicated/);
});

test("a stored definition resolves its base type through the generated registry; an unknown osfType is refused", () => {
  expect(storedFieldBaseType({ key: "count", osfType: "integer" })).toBe("integer");
  expect(storedFieldBaseType({ key: "definition", osfType: "fieldDefinition" })).toBe("object");
  expect(storedFieldBaseType({ key: "email", osfType: "email" })).toBe("string");
  expect(() => storedFieldBaseType({ key: "account", osfType: "Acount" })).toThrow("account: unknown osfType Acount.");
  expect(() => storedFieldBaseType({})).toThrow("unknown osfType");
});
