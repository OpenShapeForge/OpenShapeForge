// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for the derived-tools projection: name derivation and
 * collision policy, the stored-FieldDefinition → JSON Schema translation, and
 * the audience gate. The database read feeding rows into the projection is
 * the shared CRUD list path, proven elsewhere.
 */
import { describe, expect, it } from "bun:test";
import {
  applyPersonalNotes,
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

describe("applyPersonalNotes", () => {
  const entry = {
    personalization: {
      entity: "Preference",
      table: "erp.preferences",
      serviceRef: "serviceId",
      instructionField: "instruction",
      set: { name: "set_my_preferences", description: "d" },
    },
  };
  const tools = [
    { name: "plan_meeting", description: "Plan a meeting.", inputSchema: {}, entity: "Service", table: "erp.services", rowId: "svc-1" },
    { name: "find_notes", description: "Find notes.", inputSchema: {}, entity: "Service", table: "erp.services", rowId: "svc-2" },
  ];

  it("appends general then specific notes under a precedence label, untouched otherwise", () => {
    const personalized = applyPersonalNotes(tools, entry, [
      { serviceId: null, instruction: "Only within working hours." },
      { serviceId: "svc-1", instruction: "Focus blocks stay private." },
      { serviceId: "svc-1", instruction: "   " },
    ]);
    expect(personalized[0]!.description).toBe(
      "Plan a meeting.\n\nPersonal notes from this user (everything above always takes " +
        "precedence): Only within working hours. Focus blocks stay private.",
    );
    expect(personalized[1]!.description).toContain("Only within working hours.");
    expect(personalized[1]!.description).not.toContain("Focus blocks");
    // Original description always survives verbatim at the front.
    expect(personalized[0]!.description.startsWith("Plan a meeting.")).toBe(true);
  });

  it("passes through untouched without personalization or rows", () => {
    expect(applyPersonalNotes(tools, {}, [{ instruction: "x" }])).toBe(tools);
    expect(applyPersonalNotes(tools, entry, [])).toBe(tools);
  });
});
