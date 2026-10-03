// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  buildRuntimeAuthMetadata,
  isGeneratedCrudUiEnabled,
  resolveGeneratedCrudRoutes,
} from "./generate-ui-artifacts.js";

function contract(
  operations: Record<"list" | "get" | "create" | "update" | "delete", boolean>,
) {
  return { crud: { operations } } as Parameters<typeof isGeneratedCrudUiEnabled>[0];
}

describe("generated CRUD UI eligibility", () => {
  test("keeps the historical full CRUD pages", () => {
    expect(isGeneratedCrudUiEnabled(contract({
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    }))).toBe(true);
  });

  test("does not emit stock pages for a partial API policy", () => {
    expect(isGeneratedCrudUiEnabled(contract({
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    }))).toBe(false);
  });
});

describe("generated CRUD UI routes", () => {
  test("uses compiled schema-3 routes when the legacy UI block is absent", () => {
    const compiled = { list: { en: "/accounts", nl: "/accounts" } };
    expect(resolveGeneratedCrudRoutes(undefined, compiled)).toEqual(compiled);
  });

  test("preserves legacy routes while schema-1 authoring remains supported", () => {
    const legacy = { list: { en: "/legacy", nl: "/legacy" } };
    const compiled = { list: { en: "/compiled", nl: "/compiled" } };
    expect(resolveGeneratedCrudRoutes(legacy, compiled)).toEqual(legacy);
  });
});

describe("generated authorization fixture metadata", () => {
  test("expands group-assigned audience client composites for neutral test users", () => {
    const metadata = buildRuntimeAuthMetadata({
      clientRoleComposites: {
        "application-api": {
          "Application.Editor": {
            composites: { "resource-api": ["Data.All.ReadWrite"] },
          },
        },
      },
      groups: [
        {
          name: "test",
          subGroups: [
            {
              name: "editors",
              clientRoles: { "application-api": ["Application.Editor"] },
            },
          ],
        },
      ],
      users: [
        {
          username: "test-editor",
          tid: "tenant-a",
          groups: ["/test/editors"],
        },
      ],
    });

    expect(metadata.realmRoleComposites).toEqual({
      "Application.Editor": ["Data.All.ReadWrite"],
    });
    expect(metadata.personas[0]).toMatchObject({
      username: "test-editor",
      effectiveClientRoles: ["Application.Editor", "Data.All.ReadWrite"],
    });
  });
});
