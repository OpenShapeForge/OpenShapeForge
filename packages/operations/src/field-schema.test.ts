// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { cardinalityOf, operationFieldObjectSchema, resolveFieldBaseType } from "./field-schema.js";

test("entity semantic types retain their inferred target in parameter schemas", () => {
  const schema = operationFieldObjectSchema([{ key: "record", osfType: "ExampleRecord", required: true }], {
    osfTypes: { ExampleRecord: { kind: "entity", entity: "ExampleRecord", valueType: "string", validation: { format: "uuid" } } },
  });
  expect(schema).toMatchObject({ required: ["record"], properties: { record: { type: "string", format: "uuid", "x-osf-reference": { entity: "ExampleRecord" } } } });
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

test("an unknown osfType is refused, never projected as a free string", () => {
  expect(() => operationFieldObjectSchema([{ key: "account", osfType: "Acount" }], { osfTypes: {} }))
    .toThrow("account: unknown osfType Acount.");
  expect(() => resolveFieldBaseType({ key: "v", osfType: "shortReason" }, { shortReason: { valueType: "string" } })).not.toThrow();
  expect(() => resolveFieldBaseType({ key: "v", osfType: "toString" }, {})).toThrow("unknown osfType toString");
});

test("cardinalityOf is the one reading of bounds: min >= 1 is required, invalid bounds are refused", () => {
  expect(cardinalityOf(undefined)).toEqual({ cardinality: "single", required: false });
  expect(cardinalityOf("collection")).toEqual({ cardinality: "collection", required: false });
  expect(cardinalityOf({ min: 1, max: 1 })).toEqual({ cardinality: "single", required: true });
  expect(cardinalityOf({ min: 1, max: "unbounded" })).toEqual({ cardinality: "collection", bounds: { min: 1, max: "unbounded" }, required: true });
  expect(cardinalityOf({ max: 3 })).toEqual({ cardinality: "collection", bounds: { max: 3 }, required: false });
  for (const bounds of [{ min: 2, max: 1 }, { min: 2 }, { min: -1 }, { min: 0.5, max: 2 }, { max: 0 }] as const) {
    expect(() => cardinalityOf(bounds, "Entity.field")).toThrow("Entity.field: invalid cardinality bounds.");
  }
  const schema = operationFieldObjectSchema([
    { key: "email", osfType: "string", cardinality: { min: 1, max: 1 } },
    { key: "tags", osfType: "string", cardinality: { min: 1, max: "unbounded" } },
    { key: "note", osfType: "string", cardinality: { min: 0, max: 1 } },
  ]);
  expect(schema.required).toEqual(["email", "tags"]);
  expect((schema.properties as Record<string, Record<string, unknown>>).tags).toMatchObject({ type: "array", minItems: 1 });
});

test("stored definitions carry authored copy in x-osf-i18n and merge catalog validation", () => {
  const schema = operationFieldObjectSchema([
    { key: "reason", osfType: "shortReason", label: { en: "Reason", nl: "Reden" }, help: { en: "Why", nl: "Waarom" }, validation: { minLength: 2 } },
  ], { osfTypes: { shortReason: { valueType: "string", validation: { maxLength: 80 } } } });
  expect((schema.properties as Record<string, unknown>).reason).toEqual({
    type: "string",
    minLength: 2,
    maxLength: 80,
    "x-osf-i18n": { title: { en: "Reason", nl: "Reden" }, description: { en: "Why", nl: "Waarom" } },
    title: "Reason",
    description: "Reason Why",
  });
});

test("entity options and relationship constraints project as the live reference annotation", () => {
  const schema = operationFieldObjectSchema([
    { key: "category", osfType: "string", options: { type: "entity", source: "Category", valueField: "code" } },
    { key: "customer", osfType: "Relation", relationship: { constraints: { relationType: { eq: "organization" } } } },
  ], { osfTypes: { Relation: { kind: "entity", entity: "Relation", valueType: "string", validation: { format: "uuid" } } } });
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  expect(properties.category!["x-osf-reference"]).toEqual({ entity: "Category", valueField: "code" });
  expect(properties.category!.enum).toBeUndefined();
  expect(properties.customer).toMatchObject({
    type: "string", format: "uuid",
    "x-osf-reference": { entity: "Relation", valueField: "id", constraints: { relationType: { eq: "organization" } } },
    description: "customer References the relation entity.",
  });
  expect(() => operationFieldObjectSchema([{ key: "category", osfType: "string", options: { type: "entity" } }])).toThrow("require a source");
});

test("the recursive fieldDefinition definitions are bundled once, at the root, for nested uses", () => {
  const definitions = { fieldDefinition: { type: "object", required: ["key"], properties: { key: { type: "string" } } } };
  const schema = operationFieldObjectSchema([
    { key: "form", osfType: "object", children: [
      { key: "fields", osfType: "fieldDefinition", cardinality: "collection" },
    ] },
    { key: "definition", osfType: "fieldDefinition" },
  ], { osfTypes: { fieldDefinition: { valueType: "object" } }, fieldDefinitionDefinitions: definitions });
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  expect(properties.definition).toEqual({ $ref: "#/$defs/fieldDefinition", "x-osf-i18n": { title: { en: "definition", nl: "definition" } }, title: "definition", description: "definition" });
  expect((properties.form!.properties as Record<string, Record<string, unknown>>).fields!.items).toEqual({ $ref: "#/$defs/fieldDefinition" });
  expect(properties.form!.$defs).toBeUndefined();
  expect(schema.$defs).toEqual(definitions);
});
