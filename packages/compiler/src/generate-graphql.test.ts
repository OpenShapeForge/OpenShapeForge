// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";
import {
  buildGraphqlDocumentationCatalog,
  renderGraphqlDocumentationCatalog,
  sanitizeGraphqlDescription,
} from "./generate-graphql.js";

function field(
  key: string,
  overrides: Partial<CompiledField> = {},
): CompiledField {
  return {
    key,
    valueType: "string",
    cardinality: "single",
    required: false,
    label: { en: key },
    render: { component: "Input" },
    ...overrides,
  };
}

const contract = {
  entity: { name: "Widget" },
  model: {
    fields: [
      field("name", { description: { en: "Widget name." } }),
      field("status", {
        description: { en: "Lifecycle state." },
        options: {
          type: "static",
          items: [{ value: "active", label: { en: "Active" } }],
        },
      }),
      field("classifiedCore", {
        classification: { sensitivity: "confidential" },
      }),
    ],
    relationships: [
      { key: "owner", kind: "belongsTo", target: "Relation" },
    ],
  },
  graphql: {
    typeName: "Widget",
    description: "Widget description \ud83d with a truncated emoji.",
    fields: [
      { name: "name", type: "String", source: "core" },
      { name: "status", type: "String", source: "core" },
      { name: "ownerId", type: "ID", source: "core" },
      { name: "classifiedCore", type: "String", source: "core" },
    ],
    profileTypes: {
      sector: {
        typeName: "WidgetSectorProfile",
        fieldName: "sector",
        fields: [
          { name: "status", type: "String", description: "Must not clobber core." },
          {
            name: "classifiedCore",
            type: "String",
            description: "Must not publish a classified core field.",
          },
          { name: "sectorNote", type: "String", description: "Sector-specific note." },
          {
            name: "secret",
            type: "String",
            description: "Must stay private.",
            classification: { sensitivity: "confidential" },
          },
        ],
      },
    },
  },
} as unknown as CompiledEntityContract;

describe("generated GraphQL documentation", () => {
  test("projects canonical descriptions compactly and covers synthetic relationship IDs", () => {
    const entity = buildGraphqlDocumentationCatalog([contract], "fixture").entities[0]!;
    const fields = new Map(entity.fields.map((entry) => [entry.name, entry]));

    expect(entity.description).toBe(
      "Widget description \ufffd with a truncated emoji.",
    );
    expect(fields.get("name")).toEqual({ name: "name", description: "Widget name." });
    expect(fields.get("status")).toEqual({
      name: "status",
      description: "Lifecycle state. Allowed values: active (Active).",
      substringFilterDescription: "Lifecycle state.",
    });
    expect(fields.get("ownerId")?.description).toBe("References the Relation entity.");
    expect(fields.get("sectorNote")).toEqual({
      name: "sectorNote",
      description: "Sector-specific note.",
    });
    expect(fields.has("secret")).toBe(false);
    expect(fields.has("classifiedCore")).toBe(false);
  });

  test("renders deterministic JSON that parses back to the projected catalog", () => {
    const rendered = renderGraphqlDocumentationCatalog([contract], "fixture");
    expect(JSON.parse(rendered)).toEqual(
      buildGraphqlDocumentationCatalog([contract], "fixture"),
    );
  });

  test("replaces only unpaired surrogates", () => {
    expect(sanitizeGraphqlDescription("ok 😀 low \udc00 high \ud800"))
      .toBe("ok 😀 low \ufffd high \ufffd");
  });
});
