// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { WebAppEntriesV1, WebEntityInterface, WebManifestV1 } from "./contract.js";
import { matchPageRoute, resolveWebTarget, webAppEntryForRoute } from "./routing.js";
import {
  mcpAppEntries, webAppEntryDiscoverable, webAppEntryDiscoverOperations, webAppEntryForTool, webAppEntryToolName, webAppEntryTools,
} from "./app-entry-tools.js";

const text = (en: string, nl = en) => ({ en, nl });
const collection = (id: string, route: string, read: string, title = text(id)) => ({
  id, kind: "collection" as const, renderer: "entity.collection", modes: ["read" as const], route,
  operations: { read: { id: read, intent: "list" as const } }, title, searchPlaceholder: title, displayField: "name", columns: [],
});
const entity = (entityId: string, slug: string, route: string, named: Record<string, unknown> = {}): WebEntityInterface => ({
  entityId, entitySlug: slug, title: text(entityId), fields: {}, operations: {}, relationships: {},
  views: { collection: collection(`${entityId}.collection`, route, `${entityId}.list`), named },
} as unknown as WebEntityInterface);

const manifest: WebManifestV1 = {
  contract: "openshapeforge.web-manifest", version: 1, locale: "en",
  entities: {
    Product: entity("Product", "product", "/products"),
    Team: entity("Team", "team", "/teams", {
      workforce: { ...collection("Team.workforce", "/workforce", "Team.list", text("Workforce")), collectionLayout: "table" },
    }),
  },
  pages: { imports: { id: "imports", title: text("Imports"), route: "imports", operations: ["imports.run", "imports.status"] } },
};
const entries: WebAppEntriesV1 = {
  contract: "openshapeforge.web-app-entries", version: 1,
  entries: {
    dashboard: { id: "dashboard", label: text("Dashboard"), target: { kind: "hostPage" }, route: "/dashboard", discoverOperations: [], mcp: { exposed: false, reason: "host-page" } },
    workforce: { id: "workforce", label: text("Workforce"), target: { kind: "entityView", entityId: "Team", view: "workforce" }, route: "/workforce", discoverOperations: ["Team.list"], mcp: { exposed: true } },
    "products-pricing": { id: "products-pricing", label: text("Products & pricing", "Producten & prijzen"), target: { kind: "entityView", entityId: "Product" }, route: "/products", discoverOperations: ["Product.list"], mcp: { exposed: true } },
    imports: { id: "imports", label: text("Imports"), target: { kind: "operationPage", pageId: "imports" }, route: "/imports", discoverOperations: ["imports.run", "imports.status"], mcp: { exposed: true } },
    internal: { id: "internal", label: text("Internal"), target: { kind: "entityView", entityId: "Team" }, route: "/teams", discoverOperations: ["Team.list"], mcp: { exposed: false, reason: "authored" } },
  },
  navigation: [{ id: "main", entries: ["dashboard"] }, { id: "drivers", label: text("Drivers"), entries: ["workforce", "products-pricing", "imports", "internal"] }],
};

describe("common web target resolver", () => {
  test("distinguishes an entity view, a named collection, an Operation page and a declared host page", () => {
    expect(resolveWebTarget(manifest, "/products", entries)).toMatchObject({ kind: "entityView", mode: "read", entity: { entityId: "Product" } });
    const named = resolveWebTarget(manifest, "/workforce", entries);
    expect(named).toMatchObject({ kind: "entityView", entity: { entityId: "Team" }, view: { id: "Team.workforce" } });
    expect(resolveWebTarget(manifest, "/imports/", entries)).toEqual({ kind: "operationPage", page: manifest.pages!.imports! });
    expect(resolveWebTarget(manifest, "/dashboard", entries)).toEqual({ kind: "hostPage", entry: entries.entries.dashboard! });
  });
  test("an undeclared path resolves to nothing; a host page needs its entry", () => {
    expect(resolveWebTarget(manifest, "/dashboard")).toBeNull();
    expect(resolveWebTarget(manifest, "/missing", entries)).toBeNull();
    expect(resolveWebTarget(manifest, "/products/extra/deep", entries)).toBeNull();
    expect(matchPageRoute(manifest, "/imports?x=1")?.id).toBe("imports");
  });
  test("finds the entry a route was opened from", () => {
    expect(webAppEntryForRoute(entries, "/workforce/")?.id).toBe("workforce");
    expect(webAppEntryForRoute(entries, "/workforce/1")).toBeNull();
  });
});

describe("pure MCP entry descriptors", () => {
  const options = { namePrefix: "open_app_", resourceUri: "ui://app/app.html", locale: "nl" as const,
    description: (_: unknown, title: string) => `Open ${title}.`, meta: { "host/ui": { entrypoints: ["global"] } } };
  test("one stable opener per exposed entry, in navigation order, sharing the resource", () => {
    const tools = webAppEntryTools(entries, options);
    expect(tools.map((tool) => tool.name)).toEqual(["open_app_workforce", "open_app_products_pricing", "open_app_imports"]);
    expect(tools[1]).toEqual({
      name: "open_app_products_pricing", title: "Producten & prijzen", description: "Open Producten & prijzen.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { "host/ui": { entrypoints: ["global"] }, ui: { resourceUri: "ui://app/app.html" } },
    });
    expect(new Set(tools.map((tool) => tool._meta.ui.resourceUri)).size).toBe(1);
  });
  test("logical per-entry resources are a naming choice, not a second artifact", () => {
    const tools = webAppEntryTools(entries, { ...options, resourceUri: (entry) => `ui://app/${entry.id}.html` });
    expect(tools.map((tool) => tool._meta.ui.resourceUri)).toEqual(["ui://app/workforce.html", "ui://app/products-pricing.html", "ui://app/imports.html"]);
  });
  test("host meta can never replace the resource link", () => {
    const [tool] = webAppEntryTools(entries, { ...options, meta: { ui: { resourceUri: "ui://other/x.html" } } });
    expect(tool!._meta.ui.resourceUri).toBe("ui://app/app.html");
  });
  test("an opener name resolves only to an exposed entry", () => {
    expect(webAppEntryForTool(entries, "open_app_", "open_app_products_pricing")?.id).toBe("products-pricing");
    for (const name of ["open_app_dashboard", "open_app_internal", "open_app_missing", "open_app_", "products_pricing", "open_app_products-pricing", 7, undefined]) {
      expect(webAppEntryForTool(entries, "open_app_", name)).toBeNull();
    }
    expect(() => webAppEntryToolName("open_", "Bad_Key")).toThrow("lowercase hyphenated");
  });
  test("discoverability is any-of over canonical Operations, probed once each", () => {
    const exposed = mcpAppEntries(entries);
    expect(webAppEntryDiscoverOperations(exposed)).toEqual(["Product.list", "Team.list", "imports.run", "imports.status"]);
    const allowed = new Set(["imports.status"]);
    expect(exposed.filter((entry) => webAppEntryDiscoverable(entry, allowed)).map((entry) => entry.id)).toEqual(["imports"]);
    expect(webAppEntryDiscoverable(entries.entries.dashboard!, new Set(["Team.list"]))).toBe(false);
  });
});
