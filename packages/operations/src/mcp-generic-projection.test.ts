// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  compactGenericInputSchema,
  describeToolDefinition,
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
});
