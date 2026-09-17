// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { operationFieldObjectSchema } from "./field-schema.js";

test("entity semantic types retain their inferred target in parameter schemas", () => {
  const schema = operationFieldObjectSchema([{ key: "record", osfType: "ExampleRecord", required: true }], {
    semanticTypes: { ExampleRecord: { kind: "entity", entity: "ExampleRecord", valueType: "string", validation: { format: "uuid" } } },
  });
  expect(schema).toMatchObject({ required: ["record"], properties: { record: { type: "string", format: "uuid", "x-osf-reference": { entity: "ExampleRecord" } } } });
});

test("cardinality bounds with max one preserve a scalar value", () => {
  for (const cardinality of [{ min: 0, max: 1 }, { min: 1, max: 1 }, {}]) {
    const schema = operationFieldObjectSchema([{
      key: "email", osfType: "email", cardinality, required: true,
    }], { semanticTypes: { email: { valueType: "string", validation: { format: "email" } } } });
    expect(schema).toMatchObject({
      properties: { email: { type: "string", format: "email" } }, required: ["email"],
    });
    expect((schema.properties as Record<string, Record<string, unknown>>).email!.items).toBeUndefined();
  }
});

test("explicit collection and larger or unbounded maxima preserve arrays", () => {
  for (const cardinality of ["collection", { min: 0, max: 2 }, { min: 0, max: "unbounded" }] as const) {
    const schema = operationFieldObjectSchema([{ key: "emails", osfType: "string", cardinality }], {});
    expect(schema).toMatchObject({ properties: { emails: { type: "array", items: { type: "string" } } } });
  }
});

test("runtime fields use the host semantic and reference-data registries", () => {
  const schema = operationFieldObjectSchema([{
    key: "reasons",
    osfType: "shortReason",
    cardinality: { min: 2, max: 3 },
    required: true,
    options: { type: "referentiedata", referentieGroep: "REASONS" },
  }], {
    semanticTypes: {
      shortReason: {
        valueType: "string",
        label: { en: "Reason" },
        validation: { maxLength: 80 },
      },
    },
    referentiedata: {
      REASONS: [
        { value: "accepted", label: { en: "Accepted" } },
        { value: "declined", label: { en: "Declined" } },
      ],
    },
  });

  expect(schema).toMatchObject({
    required: ["reasons"],
    properties: {
      reasons: {
        type: "array",
        title: "Reason",
        minItems: 2,
        maxItems: 3,
        items: {
          type: "string",
          maxLength: 80,
          enum: ["accepted", "declined"],
        },
      },
    },
  });
});

test("entity semantic types project an identity reference without recursively inlining their shape", () => {
  const schema = operationFieldObjectSchema([{
    key: "record",
    osfType: "ExampleRecord",
    required: true,
  }], {
    semanticTypes: {
      ExampleRecord: {
        kind: "entity",
        entity: "ExampleRecord",
        valueType: "string",
        validation: { format: "uuid" },
        shape: [{ key: "parent", osfType: "ExampleRecord" }],
      },
    },
  });

  expect(schema).toMatchObject({
    required: ["record"],
    properties: {
      record: {
        type: "string",
        format: "uuid",
        "x-osf-reference": { entity: "ExampleRecord" },
      },
    },
  });
});

test("compiler-authored fields resolve their base from the single osfType axis", () => {
  const schema = operationFieldObjectSchema([
    { key: "count", osfType: "integer", required: true },
    { key: "note", osfType: "shortReason" },
    { key: "record", osfType: "ExampleRecord" },
    { key: "address", osfType: "postalAddress" },
  ], {
    semanticTypes: {
      shortReason: { valueType: "string", validation: { maxLength: 80 } },
      ExampleRecord: { kind: "entity", entity: "ExampleRecord", valueType: "string", validation: { format: "uuid" } },
      postalAddress: { kind: "object", valueType: "object", shape: [{ key: "street", osfType: "string", required: true }] },
    },
  });
  expect(schema).toMatchObject({
    required: ["count"],
    properties: {
      count: { type: "integer" },
      note: { type: "string", maxLength: 80 },
      record: { type: "string", format: "uuid", "x-osf-reference": { entity: "ExampleRecord" } },
      address: { type: "object", properties: { street: { type: "string" } }, required: ["street"] },
    },
  });
});
