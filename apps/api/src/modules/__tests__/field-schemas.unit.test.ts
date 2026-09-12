// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { createRuntimeFieldSchemaCompiler } from "../field-schemas.js";

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
