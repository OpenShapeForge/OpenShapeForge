// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { WebManifestV1 } from "./contract.js";
import { matchWebRoute, resolveWebLocation, webLocationPath } from "./routing.js";

const text = { en: "Relations", nl: "Relaties" };
const operation = (id: string, intent: "list" | "get" | "create" | "update") => ({ id, intent });
const manifest: WebManifestV1 = {
  contract: "openshapeforge.web-manifest",
  version: 1,
  locale: "nl",
  entities: {
    Relation: {
      entityId: "Relation",
      entitySlug: "relation",
      title: text,
      fields: {},
      operations: {},
      relationships: {},
      views: {
        collection: {
          id: "Relation.collection",
          kind: "collection",
          renderer: "entity.collection",
          modes: ["read"],
          route: "/relations",
          operations: { read: operation("Relation.list", "list") },
          title: text,
          searchPlaceholder: text,
          displayField: "displayName",
          columns: [],
        },
        record: {
          id: "Relation.record",
          kind: "record",
          renderer: "entity.record",
          preset: "inbox-main-context",
          modes: ["read", "create", "update"],
          routes: { read: "/relations/:id", create: "/relations/new" },
          operations: {
            read: operation("Relation.get", "get"),
            create: operation("Relation.create", "create"),
            update: operation("Relation.update", "update"),
          },
          titleTemplate: "{{displayName}}",
          layout: { tabs: [], context: { groups: [], relationships: [] } },
          labels: {},
        },
      },
    },
  },
};

describe("web route matching", () => {
  test("only the root uses the configured home; unknown paths never invent a tenant", () => {
    const options = { defaultRoute: "/relations", allowTenantPrefix: true };
    expect(resolveWebLocation(manifest, "/", "?q=one", options)).toEqual({ tenantBase: "", pathname: "/relations", search: "?q=one" });
    for (const path of ["/missing", "/sample/missing", "/relations/%ZZ"]) {
      expect(resolveWebLocation(manifest, path, "?q=one", options)).toEqual({ tenantBase: "", pathname: path, search: "?q=one" });
    }
  });
  test("tenant prefixes are opt-in and never duplicate on navigation", () => {
    expect(resolveWebLocation(manifest, "/sample/relations", "", { defaultRoute: "/relations", allowTenantPrefix: true }))
      .toEqual({ tenantBase: "/sample", pathname: "/relations", search: "" });
    expect(resolveWebLocation(manifest, "/sample/relations", "", { defaultRoute: "/relations" }).pathname).toBe("/sample/relations");
    expect(webLocationPath("/sample", "/sample/relations", "?q=x")).toBe("/sample/relations?q=x");
  });
  test("matches collection, create and record routes without treating new as an id", () => {
    expect(matchWebRoute(manifest, "/relations")).toMatchObject({ mode: "read", params: {} });
    expect(matchWebRoute(manifest, "/relations/new")).toMatchObject({ mode: "create", params: {} });
    expect(matchWebRoute(manifest, "/relations/r-1")).toMatchObject({
      mode: "read",
      params: { id: "r-1" },
    });
  });
});
