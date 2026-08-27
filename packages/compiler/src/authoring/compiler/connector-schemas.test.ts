// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  buildOperationSchemas,
  connectorFieldSchema,
} from "./connector-schemas.js";
import { constraintsForField } from "../../field-json-schema.js";
import type { FieldDefinition } from "../types/field-definition.js";

describe("connector field schemas", () => {
  it("maps authored validation bounds into the schema", () => {
    const field = {
      key: "prefix",
      valueType: "string",
      validation: {
        minLength: 1,
        maxLength: { value: 100 },
        pattern: "^[a-z/]+$",
      },
    } as FieldDefinition;

    expect(connectorFieldSchema(field)).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-z/]+$",
    });
  });

  it("maps value types and formats", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["boolean", { type: "boolean" }],
      ["integer", { type: "integer" }],
      ["number", { type: "number" }],
      ["date", { type: "string", format: "date" }],
      ["datetime", { type: "string", format: "date-time" }],
      ["object", { type: "object" }],
    ];
    for (const [valueType, expected] of cases) {
      expect(connectorFieldSchema({ key: "f", valueType } as FieldDefinition)).toEqual(
        expected,
      );
    }
  });

  it("turns static options into an enum", () => {
    const field = {
      key: "mode",
      valueType: "string",
      options: {
        type: "static",
        items: [{ value: "fast" }, { value: "safe" }],
      },
    } as FieldDefinition;
    expect(connectorFieldSchema(field).enum).toEqual(["fast", "safe"]);
  });

  // Referentiedata is an entity concept. A connector's wire contract with a
  // remote system has no business inheriting this platform's code tables.
  it("ignores referentiedata options", () => {
    const field = {
      key: "kind",
      valueType: "string",
      options: { type: "referentiedata", referentieGroep: "RELATIESOORT" },
    } as FieldDefinition;
    expect(connectorFieldSchema(field).enum).toBeUndefined();
  });

  it("wraps collections as arrays and lifts the description out of items", () => {
    const field = {
      key: "keys",
      valueType: "string",
      cardinality: "collection",
      description: { en: "Object keys" },
      validation: { minItems: 1, maxLength: 50 },
    } as FieldDefinition;

    expect(connectorFieldSchema(field)).toEqual({
      type: "array",
      items: { type: "string", maxLength: 50 },
      description: "Object keys",
      minItems: 1,
    });
  });

  it("reuses the canonical recursive schema for field-definition values", () => {
    const schema = connectorFieldSchema({
      key: "definitions",
      valueType: "object",
      cardinality: "collection",
      semanticType: "fieldDefinition",
    });

    expect(schema).toMatchObject({
      type: "array",
      items: { $ref: "#/$defs/fieldDefinition" },
      $defs: { fieldDefinition: expect.any(Object) },
    });
  });
});

describe("operation schemas", () => {
  const input = [
    { key: "prefix", valueType: "string" },
    { key: "limit", valueType: "integer", required: true },
  ] as FieldDefinition[];

  it("builds an input object that rejects unknown properties", () => {
    const { input: schema } = buildOperationSchemas(input, {
      cardinality: "one",
      fields: [],
    });
    expect(schema).toMatchObject({
      type: "object",
      required: ["limit"],
      additionalProperties: false,
    });
  });

  it("keeps required connector fields required even when they advertise a default", () => {
    const { input: schema } = buildOperationSchemas(
      [
        {
          key: "region",
          valueType: "string",
          required: true,
          defaultValue: "eu",
        },
      ] as FieldV2[],
      { cardinality: "one", fields: [] },
    );
    expect(schema.required).toEqual(["region"]);
  });

  it("wraps a many-cardinality output in an array", () => {
    const { output } = buildOperationSchemas(input, {
      cardinality: "many",
      fields: [
        { key: "key", valueType: "string", required: true },
      ] as FieldDefinition[],
    });
    expect(output).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    });
  });

  it("hoists recursive definitions when a many output wraps its row schema", () => {
    const { output } = buildOperationSchemas([], {
      cardinality: "many",
      fields: [
        {
          key: "definition",
          valueType: "object",
          semanticType: "fieldDefinition",
        },
      ],
    });
    const row = output.items as Record<string, unknown>;
    const definition = (row.properties as Record<string, Record<string, unknown>>).definition;

    expect(definition?.$ref).toBe("#/$defs/fieldDefinition");
    expect(row.$defs).toBeUndefined();
    expect(output.$defs).toMatchObject({ fieldDefinition: expect.any(Object) });
  });

  it("leaves a one-cardinality output as the bare object", () => {
    const { output } = buildOperationSchemas([], {
      cardinality: "one",
      fields: [{ key: "key", valueType: "string" }] as FieldDefinition[],
    });
    expect(output).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });
});

// The reason field-json-schema.ts exists: if the two surfaces mapped
// constraints differently, a value could be advertised as acceptable on one and
// rejected on the other. This asserts they share the mapping rather than
// happening to agree today.
describe("shared constraint mapping", () => {
  it("derives connector constraints from the same core the MCP catalog uses", () => {
    const field = {
      key: "amount",
      valueType: "integer",
      validation: { min: 1, max: 10, format: "int64" },
    } as FieldDefinition;

    const shared = constraintsForField(field);
    const connectorSchema = connectorFieldSchema(field);

    for (const [key, value] of Object.entries(shared)) {
      expect(connectorSchema[key]).toEqual(value);
    }
    expect(shared).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 10,
      format: "int64",
    });
  });
});
