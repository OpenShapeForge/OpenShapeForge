// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { createRuntimeFieldSchemaCompiler, runtimeJsonSchemas } from "../field-schemas.js";

const compiler = createRuntimeFieldSchemaCompiler({
  version: 1,
  fieldDefinitionSchema: {
    type: "object",
    required: ["key", "valueType"],
    additionalProperties: false,
    properties: {
      key: { type: "string", minLength: 1 },
      valueType: { enum: ["string", "integer"] },
      semanticType: { type: "string" },
      required: { type: "boolean" },
    },
  },
  semanticTypes: {
    code: {
      valueType: "string",
      label: { en: "Code" },
      validation: { minLength: 2, maxLength: 12 },
    },
  },
});

test("stored field values use semantic validation and retain invalid input untouched", () => {
  const fields = [{ key: "code", valueType: "string", semanticType: "code", required: true }];
  expect(compiler.validateObject(fields, { code: "OK" })).toEqual({ valid: true });
  for (const values of [{}, { code: "X" }, { code: { secret: "PRIVATE_VALUE" } }, { code: 123 }, { code: "OK", extra: true }]) {
    const before = structuredClone(values);
    const result = compiler.validateObject(fields, values);
    expect(result).toMatchObject({ valid: false, error: { code: "VALIDATION_FAILED", retryable: false } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_VALUE");
    expect(values).toEqual(before);
  }
  expect(compiler.validateObject([{ key: "code", valueType: "unknown" }], {}))
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

test("JSON validation neither fills defaults nor loads external refs or asynchronous schemas", () => {
  const values = {};
  expect(runtimeJsonSchemas.validate({ type: "object", properties: { code: { type: "string", default: "filled" } } }, values))
    .toEqual({ valid: true });
  expect(values).toEqual({});
  for (const schema of [{ $ref: "https://invalid.example.test/schema.json" }, { type: "unknown" }, { $async: true, type: "string" }]) {
    expect(runtimeJsonSchemas.validate(schema, "PRIVATE_VALUE"))
      .toMatchObject({ valid: false, error: { code: "INVALID_DEFINITION", retryable: false } });
  }
});

test("the host validates stored fields before using its active schema registry", () => {
  expect(compiler.object([{
    key: "code",
    valueType: "string",
    semanticType: "code",
    required: true,
  }])).toMatchObject({
    required: ["code"],
    properties: {
      code: { type: "string", title: "Code", minLength: 2, maxLength: 12 },
    },
  });

  expect(() => compiler.object([{
    key: "code",
    valueType: "unknown",
  }])).toThrow(/does not match the active authoring schema/);

  expect(() => compiler.object([
    { key: "code", valueType: "string" },
    { key: "code", valueType: "string" },
  ])).toThrow(/key "code" is duplicated/);
});
