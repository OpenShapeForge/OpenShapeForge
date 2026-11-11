// SPDX-License-Identifier: BUSL-1.1
import type {
  WebAppEntriesV1,
  WebAppEntry,
  WebPage,
  WebCollectionView,
  WebEntityInterface,
  WebManifestV1,
  WebRecordView,
  WebViewMode,
} from "./contract.js";

export type WebRouteMatch = {
  entity: WebEntityInterface;
  view: WebCollectionView | WebRecordView;
  mode: WebViewMode;
  params: Readonly<Record<string, string>>;
};

function segments(path: string): string[] {
  return path.split("?")[0]!.split("/").filter(Boolean);
}

function matchPattern(pattern: string, pathname: string): Readonly<Record<string, string>> | null {
  const expectedParts = segments(pattern);
  const actualParts = segments(pathname);
  if (expectedParts.length !== actualParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expectedParts.length; index += 1) {
    const expected = expectedParts[index]!;
    const actual = actualParts[index]!;
    if (expected.startsWith(":")) {
      try { params[expected.slice(1)] = decodeURIComponent(actual); }
      catch { return null; }
    }
    else if (expected !== actual) return null;
  }
  return params;
}

/** Match static create routes before parameterized record routes. */
export function matchWebRoute(manifest: WebManifestV1, pathname: string): WebRouteMatch | null {
  const entities = Object.values(manifest.entities)
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  for (const entity of entities) {
    const record = entity.views.record;
    if (record?.routes.create) {
      const params = matchPattern(record.routes.create, pathname);
      if (params) return { entity, view: record, mode: "create", params };
    }
    const collectionParams = matchPattern(entity.views.collection.route, pathname);
    if (collectionParams) {
      return { entity, view: entity.views.collection, mode: "read", params: collectionParams };
    }
    for (const view of Object.values(entity.views.named ?? {})) {
      if (view.kind !== "collection" || !("route" in view)) continue;
      const params = matchPattern(view.route, pathname);
      if (params) return { entity: { ...entity, title: view.title, views: { ...entity.views, collection: view } }, view, mode: "read", params };
    }
    if (record?.routes.read) {
      const params = matchPattern(record.routes.read, pathname);
      if (params) return { entity, view: record, mode: "read", params };
    }
  }
  return null;
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/** The browser path of a page: its authored route beneath the runtime base path. */
export function pageRoute(page: Pick<WebPage, "route">, basePath = ""): string {
  const base = basePath.replace(/\/+$/, "");
  const route = trimSlashes(page.route);
  return `${base}${route ? `/${route}` : ""}` || "/";
}

/** Pages in display order: authored order first, unordered pages last, ties by id. */
export function sortedPages(manifest: Pick<WebManifestV1, "pages">): WebPage[] {
  return Object.values(manifest.pages ?? {}).sort((left, right) =>
    (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
}

/** The page whose route is the base-path-relative pathname; a query string and trailing slash are ignored. */
export function matchPageRoute(manifest: Pick<WebManifestV1, "pages">, pathname: string): WebPage | null {
  const actual = trimSlashes(pathname.split("?")[0] ?? "");
  return sortedPages(manifest).find((page) => trimSlashes(page.route) === actual) ?? null;
}

/** What a pathname opens. Each kind carries its own target; none is inferred from the path text. */
export type WebRouteTarget =
  | ({ kind: "entityView" } & WebRouteMatch)
  | { kind: "operationPage"; page: WebPage }
  | { kind: "hostPage"; entry: WebAppEntry };

/**
 * The one resolver for browser and embedded hosts. Pages of standalone
 * Operations are matched before entity routes, as the runtime renders them;
 * a host page resolves only through an entry the application declares.
 * Resolution is navigation: the Operations behind the target still authorize.
 */
export function resolveWebTarget(
  manifest: WebManifestV1,
  pathname: string,
  entries?: Pick<WebAppEntriesV1, "entries">,
): WebRouteTarget | null {
  const page = matchPageRoute(manifest, pathname);
  if (page) return { kind: "operationPage", page };
  const match = matchWebRoute(manifest, pathname);
  if (match) return { kind: "entityView", ...match };
  const actual = trimSlashes(pathname.split("?")[0] ?? "");
  const entry = Object.values(entries?.entries ?? {})
    .find((candidate) => candidate.target.kind === "hostPage" && trimSlashes(candidate.route) === actual);
  return entry ? { kind: "hostPage", entry } : null;
}

/** The entry a target was opened from, when the application declares one for it. */
export function webAppEntryForRoute(
  entries: Pick<WebAppEntriesV1, "entries">,
  pathname: string,
): WebAppEntry | null {
  const actual = trimSlashes(pathname.split("?")[0] ?? "");
  return Object.values(entries.entries).find((entry) => trimSlashes(entry.route) === actual) ?? null;
}

export type WebLocation = { tenantBase: string; pathname: string; search: string };

/** URL prefixes are navigation only, never evidence of tenant authorization. */
export function resolveWebLocation(
  manifest: WebManifestV1,
  pathname: string,
  search = "",
  options: { defaultRoute: string; allowTenantPrefix?: boolean },
): WebLocation {
  const cleanPath = pathname.split("?")[0] || "/";
  if (cleanPath === "/") return { tenantBase: "", pathname: options.defaultRoute, search };
  if (matchWebRoute(manifest, cleanPath)) return { tenantBase: "", pathname: cleanPath, search };
  const parts = cleanPath.split("/").filter(Boolean);
  if (options.allowTenantPrefix && parts.length > 1) {
    const nestedPath = `/${parts.slice(1).join("/")}`;
    // Only a recognized route establishes a navigation prefix. Unknown paths
    // must not invent an organization or silently select the home entity.
    if (matchWebRoute(manifest, nestedPath)) {
      return { tenantBase: `/${parts[0]}`, pathname: nestedPath, search };
    }
  }
  return { tenantBase: "", pathname: cleanPath, search };
}

export function webLocationPath(basePath: string, pathname: string, search = "") {
  const alreadyScoped = basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`));
  return `${alreadyScoped ? "" : basePath}${pathname}${search}`;
}
