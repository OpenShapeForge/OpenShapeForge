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
      osfType: "string",
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
      "x-osf-type": "string",
    });
  });

  it("resolves a catalog osf type through the catalog and refuses one it cannot resolve", () => {
    const osfTypes = { amount: { valueType: "number" as const, label: { en: "Amount" } } };
    const field = { key: "total", osfType: "amount", validation: { min: 0 } } as FieldDefinition;
    expect(connectorFieldSchema(field, osfTypes)).toEqual({ type: "number", minimum: 0, "x-osf-type": "amount" });
    // Without the catalog the base is unknown; a silent string would misdescribe the wire contract.
    expect(() => connectorFieldSchema(field)).toThrow("Connector field total: unknown osfType amount.");
    expect(() => buildOperationSchemas([field], { cardinality: "one", fields: [] })).toThrow("unknown osfType amount");
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
    for (const [osfType, expected] of cases) {
      expect(connectorFieldSchema({ key: "f", osfType } as FieldDefinition)).toEqual(
        { ...expected, "x-osf-type": osfType },
      );
    }
  });

  it("turns static options into an enum", () => {
    const field = {
      key: "mode",
      osfType: "string",
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
      osfType: "string",
      options: { type: "referentiedata", referentieGroep: "RELATIESOORT" },
    } as FieldDefinition;
    expect(connectorFieldSchema(field).enum).toBeUndefined();
  });

  it("wraps collections as arrays and lifts the description out of items", () => {
    const field = {
      key: "keys",
      osfType: "string",
      cardinality: "collection",
      description: { en: "Object keys" },
      validation: { minItems: 1, maxLength: 50 },
    } as FieldDefinition;

    // The collection is a use of the same type as its rows: both carry it.
    expect(connectorFieldSchema(field)).toEqual({
      type: "array",
      items: { type: "string", maxLength: 50, "x-osf-type": "string" },
      "x-osf-type": "string",
      description: "Object keys",
      minItems: 1,
    });
  });

  it("reuses the canonical recursive schema for field-definition values", () => {
    const schema = connectorFieldSchema({
      key: "definitions",
      cardinality: "collection",
      osfType: "fieldDefinition",
    });

    expect(schema).toMatchObject({
      type: "array",
      items: { $ref: "#/$defs/fieldDefinition" },
      $defs: { fieldDefinition: expect.any(Object) },
    });
  });

  it("does not bundle definitions that the connector projection never references", () => {
    const schema = connectorFieldSchema({
      key: "wrapper",
      osfType: "object",
      children: [
        {
          key: "definition",
          osfType: "fieldDefinition",
        },
      ],
    });

    expect(schema).toEqual({ type: "object", "x-osf-type": "object" });
  });
});

describe("operation schemas", () => {
  const input = [
    { key: "prefix", osfType: "string" },
    { key: "limit", osfType: "integer", required: true },
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
          osfType: "string",
          required: true,
          defaultValue: "eu",
        },
      ] as FieldDefinition[],
      { cardinality: "one", fields: [] },
    );
    expect(schema.required).toEqual(["region"]);
  });

  it("wraps a many-cardinality output in an array", () => {
    const { output } = buildOperationSchemas(input, {
      cardinality: "many",
      fields: [
        { key: "key", osfType: "string", required: true },
      ] as FieldDefinition[],
    });
    expect(output).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string", "x-osf-type": "string" } },
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
          osfType: "fieldDefinition",
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
      fields: [{ key: "key", osfType: "string" }] as FieldDefinition[],
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
      osfType: "integer",
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
