// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { compileValuePath, valuePathChoices, ValuePathError, type EntityGraph } from "./value-paths.js";

const label = (en: string) => ({ en, nl: en });
const graph: EntityGraph = {
  version: 1,
  entities: {
    Deal: {
      label: label("Deal"),
      operations: { get: "Deal.get", list: "Deal.list" },
      fields: [
        { key: "name", label: label("Name"), osfType: "string", baseType: "string", cardinality: "single" },
        { key: "relationId", label: label("Customer"), osfType: "Relation", baseType: "string", cardinality: "single", target: "Relation" },
        { key: "tags", label: label("Tags"), osfType: "string", baseType: "string", cardinality: "collection" },
        { key: "pricing", label: label("Pricing"), osfType: "object", baseType: "object", cardinality: "single" },
      ],
      relationships: [
        { key: "relationId", kind: "belongsTo", target: "Relation", field: "relationId", label: label("Customer") },
        { key: "dealProducts", kind: "hasMany", target: "DealProduct", field: "dealId", label: label("Lines") },
        { key: "secretId", kind: "belongsTo", target: "Secret", field: "secretId", label: label("Secret") },
      ],
    },
    Relation: {
      label: label("Relation"),
      operations: { get: "Relation.get", list: "Relation.list" },
      fields: [{ key: "name", label: label("Name"), osfType: "string", baseType: "string", cardinality: "single" }],
      relationships: [{ key: "contactPersonId", kind: "belongsTo", target: "Person", field: "contactPersonId", label: label("Contact") }],
    },
    Person: {
      label: label("Person"),
      operations: { get: "Person.get", list: "Person.list" },
      fields: [{ key: "firstName", label: label("First name"), osfType: "string", baseType: "string", cardinality: "single" }],
      relationships: [],
    },
    DealProduct: {
      label: label("Line"),
      operations: { get: "DealProduct.get", list: "DealProduct.list" },
      fields: [{ key: "quantity", label: label("Quantity"), osfType: "decimal", baseType: "number", cardinality: "single" }],
      relationships: [],
    },
    Secret: { label: label("Secret"), operations: { get: "Secret.get" }, fields: [], relationships: [] },
  },
};

describe("compileValuePath", () => {
  test("follows belongsTo relationships to a scalar field, typed by that field", () => {
    const path = compileValuePath(graph, "Deal", "relationId.contactPersonId.firstName");
    expect(path.steps.map((step) => `${step.from}.${step.relationship.key}`)).toEqual(["Deal.relationId", "Relation.contactPersonId"]);
    expect(path.target).toBe("Person");
    expect(path.shape).toMatchObject({ osfType: "string", cardinality: "single", nullable: true });
  });

  test("a hasMany step makes the value a list", () => {
    expect(compileValuePath(graph, "Deal", "dealProducts.quantity").shape).toMatchObject({ osfType: "decimal", cardinality: "collection" });
  });

  test("a path ending on a relationship is a typed reference", () => {
    expect(compileValuePath(graph, "Deal", "relationId").shape).toMatchObject({ osfType: "Relation", target: "Relation", cardinality: "single" });
  });

  test("refuses what a variable cannot read", () => {
    for (const expression of ["missing", "name.length", "pricing", "relationId.missing", "secretId", "a.b.c.d.e.f", "Bad"]) {
      expect(() => compileValuePath(graph, "Deal", expression)).toThrow(ValuePathError);
    }
    expect(() => compileValuePath(graph, "Nope", "name")).toThrow(ValuePathError);
  });

  test("offers the fields and readable relationships of where a prefix leads", () => {
    const choices = valuePathChoices(graph, "Deal", "relationId");
    expect(choices.entity).toBe("Relation");
    expect(choices.fields.map((field) => field.key)).toEqual(["name"]);
    expect(choices.relationships.map((item) => item.key)).toEqual(["contactPersonId"]);
    expect(valuePathChoices(graph, "Deal", "").relationships.map((item) => item.key)).toEqual(["relationId", "dealProducts"]);
  });
});
