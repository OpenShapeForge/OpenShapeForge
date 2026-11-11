// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { resolveWebTarget, webAppEntryTools, type WebEntityInterface, type WebManifestV1 } from "@openshapeforge/interface-web";
import { projectWebAppEntries, type WebAppEntryShell } from "./web-app-entries.js";

const text = (en: string, nl = en) => ({ en, nl });
const collection = (id: string, route: string, read: string, title = text(id)) => ({
  id, kind: "collection" as const, renderer: "entity.collection", modes: ["read" as const], route,
  operations: { read: { id: read, intent: "list" as const } }, title, searchPlaceholder: title, displayField: "name", columns: [],
});
const entity = (entityId: string, slug: string, route: string, named: Record<string, unknown> = {}): WebEntityInterface => ({
  entityId, entitySlug: slug, title: text(entityId, `${entityId}-nl`), fields: {}, operations: {}, relationships: {},
  views: { collection: collection(`${entityId}.collection`, route, `${entityId}.list`), named },
} as unknown as WebEntityInterface);

function manifest(): WebManifestV1 {
  return {
    contract: "openshapeforge.web-manifest", version: 1, locale: "en",
    entities: {
      Product: entity("Product", "product", "/products"),
      Team: entity("Team", "team", "/teams", {
        workforce: { ...collection("Team.workforce", "/workforce", "Team.list", text("Workforce")), collectionLayout: "table" },
        members: { kind: "collection", collectionLayout: "stack" },
        card: { kind: "record", fields: ["name"] },
      }),
      Line: entity("Line", "line", "/products/:productId/lines"),
    },
    pages: { imports: { id: "imports", title: text("Imports", "Importeren"), route: "imports", operations: ["imports.run", "imports.status"] } },
  };
}
const item = (key: string, rest: Record<string, unknown>) => ({ key, label: text(key), icon: "Cube", ...rest });
const shell = (...children: ReturnType<typeof item>[]): WebAppEntryShell =>
  ({ navigation: { sidebarItems: [{ key: "main", label: text("Main"), children }] } }) as WebAppEntryShell;

describe("application entry projection", () => {
  test("projects an entity view, a named collection, an Operation page and a host page by reference", () => {
    const { entries, omitted } = projectWebAppEntries(shell(
      item("dashboard", { route: "/dashboard" }),
      item("products-pricing", { entity: "product", label: text("Products & pricing", "Producten & prijzen") }),
      item("workforce", { entity: "team", view: "workforce" }),
      item("imports", { page: "imports" }),
    ), manifest());
    expect(omitted).toEqual([]);
    expect(entries.navigation).toEqual([{ id: "main", label: text("Main"), entries: ["dashboard", "products-pricing", "workforce", "imports"] }]);
    expect(entries.entries).toEqual({
      dashboard: { id: "dashboard", icon: "Cube", label: text("dashboard"), target: { kind: "hostPage" }, route: "/dashboard", discoverOperations: [], mcp: { exposed: false, reason: "host-page" } },
      "products-pricing": { id: "products-pricing", icon: "Cube", label: text("Products & pricing", "Producten & prijzen"), target: { kind: "entityView", entityId: "Product" }, route: "/products", discoverOperations: ["Product.list"], mcp: { exposed: true } },
      workforce: { id: "workforce", icon: "Cube", label: text("workforce"), target: { kind: "entityView", entityId: "Team", view: "workforce" }, route: "/workforce", discoverOperations: ["Team.list"], mcp: { exposed: true } },
      imports: { id: "imports", icon: "Cube", label: text("imports"), target: { kind: "operationPage", pageId: "imports" }, route: "/imports", discoverOperations: ["imports.run", "imports.status"], mcp: { exposed: true } },
    });
  });
  test("is deterministic and every entry resolves through the common resolver to its own target kind", () => {
    const authored = shell(item("dashboard", { route: "/dashboard" }), item("products", { entity: "product" }),
      item("workforce", { entity: "team", view: "workforce" }), item("imports", { page: "imports" }));
    const first = projectWebAppEntries(authored, manifest()).entries;
    expect(JSON.stringify(projectWebAppEntries(authored, manifest()).entries)).toBe(JSON.stringify(first));
    for (const entry of Object.values(first.entries)) {
      expect(resolveWebTarget(manifest(), entry.route, first)?.kind).toBe(entry.target.kind);
    }
    expect(webAppEntryTools(first, { namePrefix: "open_", resourceUri: "ui://a", locale: "en", description: () => "" }).map((tool) => tool.name))
      .toEqual(["open_products", "open_workforce", "open_imports"]);
  });
  test("the entry id is the authored key, not the label or route", () => {
    const relabeled = projectWebAppEntries(shell(item("catalog", { entity: "product", label: text("Anything else") })), manifest()).entries;
    expect(Object.keys(relabeled.entries)).toEqual(["catalog"]);
    expect(relabeled.entries.catalog!.label).toEqual(text("Anything else"));
  });
  test("authoring can keep an entry out of MCP without removing the browser item", () => {
    const { entries } = projectWebAppEntries(shell(item("products", { entity: "product", mcp: false })), manifest());
    expect(entries.entries.products!.mcp).toEqual({ exposed: false, reason: "authored" });
    expect(entries.navigation[0]!.entries).toEqual(["products"]);
  });
  test("removing an entity's web interface removes its entry: the item fails until it is removed too", () => {
    const withoutProduct = manifest();
    delete withoutProduct.entities.Product;
    expect(() => projectWebAppEntries(shell(item("products", { entity: "product" })), withoutProduct)).toThrow('names entity "product", which is not in the web manifest');
    const elsewhere = projectWebAppEntries(shell(item("products", { entity: "product" }), item("console", { page: "operators" })), withoutProduct,
      { elsewhere: { entities: ["product"], pages: ["operators"] } });
    expect(elsewhere.entries.entries).toEqual({});
    expect(elsewhere.entries.navigation).toEqual([]);
    expect(elsewhere.omitted).toEqual([{ id: "products", reason: "projected-elsewhere" }, { id: "console", reason: "projected-elsewhere" }]);
  });
  test("disabled items are reported, not projected", () => {
    expect(projectWebAppEntries(shell(item("products", { entity: "product", disabled: true })), manifest()).omitted)
      .toEqual([{ id: "products", reason: "disabled" }]);
  });
  test.each([
    ["a missing named view", [item("x", { entity: "team", view: "absent" })], 'names view "absent"'],
    ["a named view without a route", [item("x", { entity: "team", view: "members" })], "not an addressable collection"],
    ["a named record view", [item("x", { entity: "team", view: "card" })], "not an addressable collection"],
    ["a route that needs a record", [item("x", { entity: "line" })], "needs a record to open"],
    ["a missing page", [item("x", { page: "absent" })], 'names page "absent"'],
    ["a view without an entity", [item("x", { route: "/x", view: "workforce" })], "names a view without an entity"],
    ["no target", [item("x", {})], "exactly one of entity, page or route"],
    ["two targets", [item("x", { entity: "product", route: "/products" })], "exactly one of entity, page or route"],
    ["an external route", [item("x", { route: "//evil.example" })], "invalid local route"],
    ["a route with a query", [item("x", { route: "/x?y=1" })], "invalid local route"],
    ["a literal route a compiled view already answers", [item("x", { route: "/workforce" })], "Team.workforce already projects"],
    ["a literal route a page already answers", [item("x", { route: "/imports" })], "page imports already projects"],
    ["duplicate keys", [item("x", { entity: "product" }), item("x", { page: "imports" })], 'key "x" is used more than once'],
    ["duplicate routes", [item("x", { entity: "product" }), item("y", { entity: "product" })], "both open /products"],
    ["an id that is not a stable key", [item("Not Stable", { entity: "product" })], "lowercase hyphenated"],
  ] as const)("rejects %s", (_name, children, message) => {
    expect(() => projectWebAppEntries(shell(...children), manifest())).toThrow(message);
  });
  test("rejects a route more than one top-level view claims", () => {
    const ambiguous = manifest();
    ambiguous.entities.Other = entity("Other", "other", "/products");
    expect(() => projectWebAppEntries(shell(item("x", { entity: "product" })), ambiguous)).toThrow("2 top-level views claim (Product.collection, Other.collection)");
  });
});
