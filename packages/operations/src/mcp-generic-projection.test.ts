// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  compactGenericInputSchema,
  describeToolDefinition,
  genericTextLanguage,
  genericToolText,
} from "./mcp-generic-projection.js";

const id = { type: "string", format: "uuid", title: "ID" };

const branches = [
  {
    entity: "Address",
    title: "Address",
    inputSchema: {
      type: "object",
      properties: {
        id,
        values: { type: "object", title: "Values", properties: { street: { type: "string" } } },
        expectedVersion: { type: "string" },
        street: { type: "string", description: "Address only" },
      },
      required: ["id", "values", "expectedVersion", "street"],
      additionalProperties: false,
    },
  },
  {
    entity: "Quote",
    title: "Offerte",
    inputSchema: {
      type: "object",
      properties: {
        id,
        values: { type: "object", title: "Values", properties: { number: { type: "string" } } },
        expectedVersion: { type: "string" },
        confirmed: { type: "boolean" },
      },
      required: ["id", "values", "expectedVersion"],
      additionalProperties: false,
    },
  },
];

describe("compactGenericInputSchema", () => {
  test("keeps the entity enum and the properties every entity describes the same way", () => {
    const schema = compactGenericInputSchema("update", branches);
    expect(schema.properties).toMatchObject({
      entity: { type: "string", enum: ["Address", "Quote"] },
      id,
      expectedVersion: { type: "string" },
    });
    expect(schema.required).toEqual(["entity", "id", "values", "expectedVersion"]);
  });

  test("stubs a property every entity has but describes differently, pointing at osf_describe", () => {
    const schema = compactGenericInputSchema("update", branches) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.values).toEqual({
      type: "object",
      title: "Values",
      description: expect.stringContaining('osf_describe { entity, operation: "update" }'),
    });
    expect(JSON.stringify(schema)).not.toContain("street");
  });

  test("leaves an entity's own properties out and keeps the schema open to them", () => {
    const schema = compactGenericInputSchema("update", branches);
    expect(schema.properties).not.toHaveProperty("confirmed");
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.description).toContain("osf_describe");
    // With nothing entity-specific the schema is closed, like the per-entity ones.
    const closed = compactGenericInputSchema("get", [
      { entity: "A", title: "A", inputSchema: { type: "object", properties: { id }, required: ["id"] } },
      { entity: "B", title: "B", inputSchema: { type: "object", properties: { id }, required: ["id"] } },
    ]);
    expect(closed.additionalProperties).toBe(false);
  });

  test("the advertised bytes do not grow with the number of entities' own fields", () => {
    const wide = Array.from({ length: 60 }, (_, index) => ({
      entity: `Entity${index}`,
      title: `Entity ${index}`,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 40 }, (_, field) => [
            `field${index}_${field}`,
            { type: "string", description: "x".repeat(200) },
          ]),
        ),
      },
    }));
    const bytes = JSON.stringify(compactGenericInputSchema("create", wide)).length;
    expect(bytes).toBeLessThan(4096);
  });
});

describe("genericToolText and the describe tool", () => {
  test("names every entity with its title and says where the exact schema comes from", () => {
    const text = genericToolText("create", branches, "osf://schema/entities");
    expect(text.title).toBe("Create record");
    expect(text.description).toContain("Address, Quote (Offerte)");
    expect(text.description).toContain('osf_describe { entity, operation: "create" }');
  });

  test("the describe tool takes the addressable entities as its enum", () => {
    const tool = describeToolDefinition(["Address", "Quote"]);
    expect(tool.name).toBe("osf_describe");
    expect(tool.inputSchema).toMatchObject({
      properties: {
        entity: { enum: ["Address", "Quote"] },
        operation: { enum: ["list", "get", "create", "update", "delete"] },
      },
      required: ["entity"],
      additionalProperties: false,
    });
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  test("names the OSF type on the selectors and keeps the presentation keywords on a stub", () => {
    const annotated = [
      {
        entity: "A", title: "A",
        inputSchema: { type: "object", properties: { values: { type: "object", "x-osf-type": "Address", "x-osf-i18n": { title: { en: "Values", nl: "Waarden" } }, properties: { a: {} } } } },
      },
      {
        entity: "B", title: "B",
        inputSchema: { type: "object", properties: { values: { type: "object", "x-osf-type": "Address", "x-osf-i18n": { title: { en: "Values", nl: "Waarden" } }, properties: { b: {} } } } },
      },
    ];
    const schema = compactGenericInputSchema("update", annotated) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.entity!["x-osf-type"]).toBe("string");
    expect(schema.properties.values).toMatchObject({
      type: "object",
      "x-osf-type": "Address",
      "x-osf-i18n": { title: { en: "Values", nl: "Waarden" } },
    });
    expect(schema.properties.values!.properties).toBeUndefined();
    const describe = describeToolDefinition(["A"]) as unknown as { inputSchema: { properties: Record<string, Record<string, unknown>> } };
    expect(describe.inputSchema.properties.entity!["x-osf-type"]).toBe("string");
    expect(describe.inputSchema.properties.operation!["x-osf-type"]).toBe("string");
  });
});

describe("the generic texts in the session's language", () => {
  test("resolve Dutch, English, and fall back to English for any other language", () => {
    expect(genericTextLanguage("nl-BE")).toBe("nl");
    expect(genericTextLanguage("fr")).toBe("en");
    expect(genericTextLanguage(undefined)).toBe("en");
    const nl = genericToolText("create", branches, "osf://schema/entities", "nl");
    const en = genericToolText("create", branches, "osf://schema/entities", "en");
    const fr = genericToolText("create", branches, "osf://schema/entities", "fr");
    expect(nl.title).toBe("Record aanmaken");
    expect(nl.description).toStartWith("Maakt één record van één entiteit uit de gedeelde catalogus aan.");
    expect(nl.description).toContain("Hier voor jou beschikbaar: Address, Quote (Offerte).");
    expect(en.title).toBe("Create record");
    expect(fr).toEqual(en);
    expect(genericToolText("create", branches, "osf://schema/entities")).toEqual(en);
  });

  test("apply to the schema stubs and to osf_describe as well", () => {
    const nl = compactGenericInputSchema("update", branches, "nl") as { properties: Record<string, Record<string, unknown>>; description: string };
    expect(nl.properties.entity!.title).toBe("Entiteit");
    expect(nl.properties.values!.description).toStartWith("Verschilt per entiteit.");
    expect(nl.description).toStartWith("Eigenschappen die een entiteit");
    const en = compactGenericInputSchema("update", branches, "de") as { properties: Record<string, Record<string, unknown>> };
    expect(en.properties.values!.description).toStartWith("Differs per entity.");
    expect(describeToolDefinition(["Address"], "nl").title).toBe("Argumenten van de gedeelde catalogus beschrijven");
    expect(describeToolDefinition(["Address"], "nl").inputSchema).toMatchObject({
      properties: { operation: { title: "Operatie" } },
    });
    expect(describeToolDefinition(["Address"], "pt").title).toBe("Describe shared-catalog arguments");
  });
});
