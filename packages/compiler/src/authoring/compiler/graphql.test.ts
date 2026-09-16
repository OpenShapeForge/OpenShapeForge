// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { buildGraphQL } from "./graphql.js";

describe("GraphQL authoring projection", () => {
  test("carries an authored profile-field description into the compiled profile", () => {
    const graphql = buildGraphQL(
      {
        entity: "Widget",
        description: { en: "Widget entity." },
        fields: [],
      } as any,
      [
        {
          profile: "sector",
          fields: [
            {
              key: "sectorNote",
              valueType: "string",
              description: { en: "Sector-specific note." },
            },
          ],
        } as any,
      ],
      [],
    );

    expect(graphql.description).toBe("Widget entity.");
    expect(graphql.profileTypes.sector?.fields[0]?.description).toBe(
      "Sector-specific note.",
    );
  });

  test("strict v2 defaults to every canonical Operation and keeps exclusions", () => {
    const operation = (action: "list" | "get") => ({
      name: action,
      description: `${action} widgets`,
      implementation: { type: "entity" as const, action },
      effects: { data: "read" as const, external: "none" as const },
      reliability: { idempotency: { mode: "natural" as const } },
      confirmation: { mode: "none" as const },
    });
    const entity = {
      schemaVersion: 2,
      kind: "coreEntity",
      module: "core",
      entity: "Widget",
      title: "Widget",
      language: "en",
      fields: [],
      operations: { list: operation("list"), get: operation("get") },
      interfaces: { graphql: { operations: { get: false } } },
    } as any;

    expect(buildGraphQL(entity, [], []).operations).toEqual({
      list: true,
      get: false,
      create: false,
      update: false,
      delete: false,
    });
  });
});
