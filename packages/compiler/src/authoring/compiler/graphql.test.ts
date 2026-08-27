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
});
