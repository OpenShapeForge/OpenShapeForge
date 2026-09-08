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
import { resolveLocale } from "../locale.js";

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
      {
        key: "changes",
        valueType: "object",
        validation: { minProperties: 1 },
        children: [{ key: "title", valueType: "string" }],
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
        changes: {
          type: "object",
          properties: { title: { type: "string" } },
          additionalProperties: false,
          minProperties: 1,
        },
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

/**
 * A Service and its field definitions are stored rows, so unlike the compiled
 * entity catalog they still carry the authored `{ en, nl }` map at run time.
 * This is therefore the one projection on this transport that can put a
 * person's own language in front of them — and the one place where getting the
 * order wrong is invisible, because either answer is a fluent sentence.
 */
describe("the language a Service is projected in", () => {
  const nl = resolveLocale({ user: "nl", realmDefault: "en", hostDefault: "en" });
  const en = resolveLocale({ user: "en", realmDefault: "nl", hostDefault: "nl" });
  const entry = {
    entity: "Service",
    table: "integration.services",
    roles: ["viewer"],
    keyField: "key",
    titleField: "name",
    descriptionField: "description",
    inputFieldsField: "inputFields",
  };
  const row = {
    id: "a",
    key: "approve-scope",
    name: { en: "Record the client's scope approval", nl: "Scope-akkoord van de klant vastleggen" },
    description: { en: "Records that the client agreed.", nl: "Legt vast dat de klant akkoord is." },
    inputFields: [
      {
        key: "decision",
        valueType: "string",
        required: true,
        label: { en: "Decision", nl: "Besluit" },
        description: { en: "What the client said.", nl: "Wat de klant heeft gezegd." },
      },
    ],
  };

  it("gives a Dutch reader the Dutch title, description and field label", () => {
    const [tool] = derivedToolsFromRows(entry, [row], new Set(), ["viewer"], nl);
    expect(tool!.title).toBe("Scope-akkoord van de klant vastleggen");
    expect(tool!.description).toBe("Legt vast dat de klant akkoord is.");
    const decision = (tool!.inputSchema.properties as Record<string, Record<string, unknown>>)
      .decision!;
    expect(decision.title).toBe("Besluit");
    expect(decision.description).toBe("Wat de klant heeft gezegd.");
  });

  it("gives an English reader the English ones, from the same row", () => {
    const [tool] = derivedToolsFromRows(entry, [row], new Set(), ["viewer"], en);
    expect(tool!.title).toBe("Record the client's scope approval");
    const decision = (tool!.inputSchema.properties as Record<string, Record<string, unknown>>)
      .decision!;
    expect(decision.title).toBe("Decision");
  });

  it("keeps keys, types and required-ness identical in both languages", () => {
    const dutch = derivedToolsFromRows(entry, [row], new Set(), ["viewer"], nl)[0]!;
    const english = derivedToolsFromRows(entry, [row], new Set(), ["viewer"], en)[0]!;
    expect(dutch.name).toBe(english.name);
    const strip = (schema: Record<string, unknown>) =>
      JSON.parse(
        JSON.stringify(schema, (key, value) =>
          key === "title" || key === "description" ? undefined : value,
        ),
      );
    expect(strip(dutch.inputSchema)).toEqual(strip(english.inputSchema));
  });

  it("without a session language, falls back to English then to what exists", () => {
    const [tool] = derivedToolsFromRows(entry, [row], new Set(), ["viewer"]);
    expect(tool!.title).toBe("Record the client's scope approval");
    const onlyDutch = derivedToolsFromRows(
      entry,
      [{ ...row, name: { nl: "Alleen Nederlands" } }],
      new Set(),
      ["viewer"],
    )[0]!;
    expect(onlyDutch.title).toBe("Alleen Nederlands");
  });

  it("passes the language into a nested object's field labels too", () => {
    const schema = inputSchemaFromStoredFields(
      [
        {
          key: "client",
          valueType: "object",
          children: [{ key: "name", valueType: "string", label: { en: "Name", nl: "Naam" } }],
        },
      ],
      nl,
    );
    const client = (schema.properties as Record<string, Record<string, unknown>>).client!;
    const name = (client.properties as Record<string, Record<string, unknown>>).name!;
    expect(name.title).toBe("Naam");
  });
});
