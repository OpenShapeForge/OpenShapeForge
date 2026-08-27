// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for the derived-tools projection: name derivation and
 * collision policy, the stored-FieldDefinition → JSON Schema translation, and
 * the audience gate. The database read feeding rows into the projection is
 * the shared CRUD list path, proven elsewhere.
 */
import { describe, expect, it } from "bun:test";
import {
  deriveToolName,
  derivedToolsFromRows,
  inputSchemaFromStoredFields,
  sessionInAudience,
} from "../derived-tools.js";

describe("deriveToolName", () => {
  it("snake_cases stored keys and refuses unsafe ones", () => {
    expect(deriveToolName("find-tickets")).toBe("find_tickets");
    expect(deriveToolName("Find Tickets")).toBeNull();
    expect(deriveToolName("1-bad")).toBeNull();
    expect(deriveToolName(42)).toBeNull();
  });
});

describe("inputSchemaFromStoredFields", () => {
  it("translates the stored FieldDefinition subset", () => {
    const schema = inputSchemaFromStoredFields([
      {
        key: "query",
        valueType: "string",
        required: true,
        label: { en: "Query" },
        description: { en: "Free-text search." },
        validation: { minLength: 1, maxLength: 200 },
      },
      {
        key: "status",
        valueType: "string",
        options: { items: [{ value: "open" }, { value: "closed" }] },
      },
      {
        key: "tags",
        valueType: "string",
        cardinality: "collection",
      },
    ]);
    expect(schema).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          title: "Query",
          description: "Free-text search.",
        },
        status: { type: "string", enum: ["open", "closed"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    });
  });

  it("returns an empty object schema for absent or malformed definitions", () => {
    expect(inputSchemaFromStoredFields(null)).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(inputSchemaFromStoredFields([{ valueType: "string" }])).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});

describe("sessionInAudience", () => {
  it("admits only sessions holding one of the audience roles", () => {
    const entry = { roles: ["viewer", "editor"] };
    expect(sessionInAudience(entry, ["viewer"])).toBe(true);
    expect(sessionInAudience(entry, ["other"])).toBe(false);
    expect(sessionInAudience(entry, undefined)).toBe(false);
    expect(sessionInAudience(entry, null)).toBe(false);
  });
});

describe("derivedToolsFromRows", () => {
  const entry = {
    entity: "Service",
    table: "erp.services",
    roles: ["viewer"],
    keyField: "key",
    titleField: "name",
    descriptionField: "description",
    inputFieldsField: "inputFields",
  };

  it("maps rows to tools and skips unsafe or colliding names", () => {
    const rows = [
      {
        id: "a",
        key: "find-tickets",
        name: "Find tickets",
        description: "Find tickets.",
        inputFields: [{ key: "query", valueType: "string", required: true }],
      },
      { id: "b", key: "reserved_name", name: "x", description: "y", inputFields: [] },
      { id: "c", key: "Bad Key", name: "x", description: "y", inputFields: [] },
      { id: "d", key: "find-tickets", name: "dup", description: "dup", inputFields: [] },
    ];
    const tools = derivedToolsFromRows(entry, rows, new Set(["reserved_name"]));
    expect(tools.map((tool) => tool.name)).toEqual(["find_tickets"]);
    expect(tools[0]).toMatchObject({
      title: "Find tickets",
      description: "Find tickets.",
      entity: "Service",
      rowId: "a",
    });
    expect((tools[0]?.inputSchema.properties as Record<string, unknown>).query).toBeDefined();
  });
});
