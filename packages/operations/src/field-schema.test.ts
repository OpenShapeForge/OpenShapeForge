// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { operationFieldObjectSchema } from "./field-schema.js";

test("entity semantic types retain their inferred target in parameter schemas", () => {
  const schema = operationFieldObjectSchema([{ key: "record", osfType: "ExampleRecord", required: true }], {
    osfTypes: { ExampleRecord: { kind: "entity", entity: "ExampleRecord", valueType: "string", validation: { format: "uuid" } } },
  });
  expect(schema).toMatchObject({ required: ["record"], properties: { record: { type: "string", format: "uuid", "x-osf-reference": { entity: "ExampleRecord" }, "x-osf-type": "ExampleRecord" } } });
});

test("cardinality bounds with max one preserve a scalar value", () => {
  for (const cardinality of [{ min: 0, max: 1 }, { min: 1, max: 1 }, {}]) {
    const schema = operationFieldObjectSchema([{
      key: "email", osfType: "email", cardinality, required: true,
    }], { osfTypes: { email: { valueType: "string", validation: { format: "email" } } } });
    expect(schema).toMatchObject({
      properties: { email: { type: "string", format: "email" } }, required: ["email"],
    });
    expect((schema.properties as Record<string, Record<string, unknown>>).email!.items).toBeUndefined();
  }
});

test("explicit collection and larger or unbounded maxima preserve arrays", () => {
  for (const cardinality of ["collection", { min: 0, max: 2 }, { min: 0, max: "unbounded" }] as const) {
    const schema = operationFieldObjectSchema([{ key: "emails", osfType: "string", cardinality }], {});
    expect(schema).toMatchObject({ properties: { emails: { type: "array", "x-osf-type": "string", items: { type: "string", "x-osf-type": "string" } } } });
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
    osfTypes: {
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
    osfTypes: {
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
    osfTypes: {
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

test("an enumeration on a typed field carries its values in that type", () => {
  const schema = operationFieldObjectSchema([
    { key: "priority", osfType: "integer", options: { type: "static", items: [{ value: "1", label: "Low" }, { value: "2", label: "High" }] } },
    { key: "ratio", osfType: "number", options: { type: "static", items: [{ value: "0.5", label: "Half" }] } },
    { key: "flag", osfType: "boolean", options: { type: "static", items: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] } },
    { key: "code", osfType: "string", options: { type: "static", items: [{ value: "1", label: "One" }] } },
  ], {});
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  expect(properties.priority).toMatchObject({ type: "integer", enum: [1, 2] });
  expect(properties.ratio).toMatchObject({ type: "number", enum: [0.5] });
  expect(properties.flag).toMatchObject({ type: "boolean", enum: [true, false] });
  expect(properties.code).toMatchObject({ type: "string", enum: ["1"] });
});

test("an enumeration value that does not convert exactly to the field's type is refused", () => {
  const withOptions = (osfType: string, value: string) => () => operationFieldObjectSchema([{ key: "v", osfType, options: { type: "static", items: [{ value, label: "x" }] } }], {});
  expect(withOptions("boolean", "yes")).toThrow("is not a boolean");
  expect(withOptions("integer", "1.5")).toThrow("is not a safe integer");
  expect(withOptions("integer", "9007199254740993")).toThrow("is not a safe integer");
  expect(withOptions("number", "abc")).toThrow("is not a finite number");
  expect(withOptions("integer", " 7 ")).not.toThrow();
});

test("an empty English label does not hide the Dutch one", () => {
  const schema = operationFieldObjectSchema([{ key: "kind", osfType: "string", label: { en: "", nl: "Soort" } }], {});
  expect((schema.properties as Record<string, Record<string, unknown>>).kind!.title).toBe("Soort");
});
