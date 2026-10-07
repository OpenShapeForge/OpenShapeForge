// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  buildRuntimeAuthMetadata,
  resolveGeneratedCrudRoutes,
} from "./generate-ui-artifacts.js";
import { isGeneratedEntityUiEnabled } from "./generators/entity-read-transport.js";

type Contract = Parameters<typeof isGeneratedEntityUiEnabled>[0];

function contract(
  operations: Record<"list" | "get" | "create" | "update" | "delete", boolean>,
) {
  return { crud: { operations } } as Contract;
}

describe("generated entity UI eligibility", () => {
  test("keeps the historical full CRUD pages", () => {
    expect(isGeneratedEntityUiEnabled(contract({
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    }))).toBe(true);
  });

  test("does not emit stock pages for a partial API policy", () => {
    expect(isGeneratedEntityUiEnabled(contract({
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    }))).toBe(false);
  });

  test("renders an Operation-backed source that projects its list Operation to the web", () => {
    const none = { list: false, get: false, create: false, update: false, delete: false };
    const source = (web: Record<string, boolean>) => ({
      ...contract(none),
      source: { kind: "operations" },
      interfaces: { web: { operations: web } },
    }) as Contract;
    expect(isGeneratedEntityUiEnabled(source({ list: true, get: true }))).toBe(true);
    expect(isGeneratedEntityUiEnabled(source({}))).toBe(false);
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

  test("refuses one role name with different composites in two namespaces", () => {
    expect(() => buildRuntimeAuthMetadata({
      clientRoleComposites: {
        "application-api": { Editor: { composites: { "resource-api": ["Data.All.Read"] } } },
        "billing-api": { Editor: { composites: { "resource-api": ["Data.All.ReadWrite"] } } },
      },
    })).toThrow(/Role "Editor" is declared by client "application-api" and client "billing-api"/);
    expect(() => buildRuntimeAuthMetadata({
      realmRoles: { Editor: { composites: { "resource-api": ["Data.All.Read"] } } },
      clientRoleComposites: {
        "billing-api": { Editor: { composites: { "resource-api": ["Data.All.ReadWrite"] } } },
      },
    })).toThrow(/Role "Editor" is declared by the realm and client "billing-api"/);

    const identical = buildRuntimeAuthMetadata({
      realmRoles: { Editor: { composites: { "resource-api": ["Data.All.Read"] } } },
      clientRoleComposites: {
        "billing-api": { Editor: { composites: { "other-api": ["Data.All.Read"] } } },
      },
    });
    expect(identical.realmRoleComposites).toEqual({ Editor: ["Data.All.Read"] });
  });
});
