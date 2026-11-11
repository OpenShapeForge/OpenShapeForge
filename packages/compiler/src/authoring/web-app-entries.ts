// SPDX-License-Identifier: BUSL-1.1
import {
  matchPageRoute,
  webAppEntryToolName,
  type LocalizedText,
  type WebAppEntriesV1,
  type WebAppEntry,
  type WebAppEntryGroup,
  type WebCollectionView,
  type WebEntityInterface,
  type WebManifestV1,
  type WebNamedView,
} from "@openshapeforge/interface-web";
import type { AppShellNavItem } from "./types/navigation.js";

/** The authored shell navigation this projection reads; a composed `menu.yaml`. */
export type WebAppEntryShell = { navigation?: { sidebarItems?: AppShellNavItem[] } };

export type WebAppEntryOptions = {
  /**
   * Entity slugs and page ids another surface of the same application projects
   * (an operator console beside the tenant application). Items naming them are
   * left out here rather than reported as missing targets.
   */
  elsewhere?: { entities?: Iterable<string>; pages?: Iterable<string> };
};

export type WebAppEntryProjection = {
  entries: WebAppEntriesV1;
  /** Authored items that produced no entry, with the reason; nothing is dropped silently. */
  omitted: Array<{ id: string; reason: "projected-elsewhere" | "disabled" }>;
};

function segments(route: string): string[] {
  return route.split("?")[0]!.split("/").filter(Boolean);
}

function literalRoute(item: AppShellNavItem): string | undefined {
  return typeof item.route === "string" ? item.route : item.route?.en;
}

/** A named view with its own route: the compiled collection contract, not a relationship layout. */
function addressableCollection(view: WebNamedView | undefined): WebCollectionView | undefined {
  return view?.kind === "collection" && "route" in view && typeof view.route === "string" && "operations" in view
    ? view as WebCollectionView : undefined;
}

/** Top-level addressable views a parameterless route opens: canonical and named collections. */
function addressableViews(manifest: WebManifestV1, route: string): string[] {
  const wanted = segments(route).join("/");
  return Object.values(manifest.entities).flatMap((entity) => [
    ...(segments(entity.views.collection.route).join("/") === wanted ? [`${entity.entityId}.collection`] : []),
    ...Object.entries(entity.views.named ?? {}).flatMap(([name, view]) =>
      segments(addressableCollection(view)?.route ?? "/:none").join("/") === wanted ? [`${entity.entityId}.${name}`] : []),
  ]);
}

function entityEntry(item: AppShellNavItem, entity: WebEntityInterface): Pick<WebAppEntry, "label" | "target" | "route" | "discoverOperations"> {
  if (item.view === undefined) {
    const view = entity.views.collection;
    return {
      label: { ...entity.title, ...item.label },
      target: { kind: "entityView", entityId: entity.entityId },
      route: view.route,
      discoverOperations: [view.operations.read.id],
    };
  }
  const named = Object.hasOwn(entity.views.named ?? {}, item.view) ? entity.views.named![item.view] : undefined;
  if (!named) throw new Error(`Menu item ${item.key} names view "${item.view}", which entity "${item.entity}" does not project.`);
  const view = addressableCollection(named);
  if (!view) {
    throw new Error(`Menu item ${item.key} names view "${item.view}" of "${item.entity}", which is not an addressable collection.`);
  }
  return {
    label: { ...view.title, ...item.label },
    target: { kind: "entityView", entityId: entity.entityId, view: item.view },
    route: view.route,
    discoverOperations: [view.operations.read.id],
  };
}

/**
 * Project the authored shell onto the compiled web manifest: every sidebar
 * item becomes one entry that references an entity view, a page of standalone
 * Operations, or a route the host renders itself. Browser navigation and MCP
 * openers both select from this result, so a destination has one definition.
 *
 * An entry copies no field, layout, input schema or role list. Discoverability
 * names canonical Operations; removing an entity's web interface removes the
 * target and so fails the build until the item is removed with it.
 */
export function projectWebAppEntries(
  shell: WebAppEntryShell,
  manifest: WebManifestV1,
  options: WebAppEntryOptions = {},
): WebAppEntryProjection {
  const bySlug = new Map(Object.values(manifest.entities).map((entity) => [entity.entitySlug, entity]));
  const entitiesElsewhere = new Set(options.elsewhere?.entities ?? []);
  const pagesElsewhere = new Set(options.elsewhere?.pages ?? []);
  const entries: Record<string, WebAppEntry> = {};
  const omitted: WebAppEntryProjection["omitted"] = [];
  const navigation: WebAppEntryGroup[] = [];
  const routes = new Map<string, string>();
  const toolNames = new Map<string, string>();

  const project = (item: AppShellNavItem): WebAppEntry | undefined => {
    if (item.disabled) { omitted.push({ id: item.key, reason: "disabled" }); return; }
    const targets = [item.entity, item.page, literalRoute(item)].filter((target) => target !== undefined && target !== null);
    if (targets.length !== 1) throw new Error(`Menu item ${item.key} must name exactly one of entity, page or route.`);
    const base = { id: item.key, ...(item.icon ? { icon: item.icon } : {}) };
    const mcp: WebAppEntry["mcp"] = item.mcp === false ? { exposed: false, reason: "authored" } : { exposed: true };
    if (item.entity) {
      const entity = bySlug.get(item.entity);
      if (!entity) {
        if (entitiesElsewhere.has(item.entity)) { omitted.push({ id: item.key, reason: "projected-elsewhere" }); return; }
        throw new Error(`Menu item ${item.key} names entity "${item.entity}", which is not in the web manifest.`);
      }
      const projected = entityEntry(item, entity);
      if (projected.route.split("/").some((part) => part.startsWith(":"))) {
        throw new Error(`Menu item ${item.key} resolves to ${projected.route}, which needs a record to open.`);
      }
      const matches = addressableViews(manifest, projected.route);
      if (matches.length !== 1) {
        throw new Error(`Menu item ${item.key} resolves to ${projected.route}, which ${matches.length} top-level views claim (${matches.join(", ")}).`);
      }
      return { ...base, ...projected, mcp };
    }
    if (item.view !== undefined) throw new Error(`Menu item ${item.key} names a view without an entity.`);
    if (item.page) {
      const page = Object.hasOwn(manifest.pages ?? {}, item.page) ? manifest.pages![item.page] : undefined;
      if (!page) {
        if (pagesElsewhere.has(item.page)) { omitted.push({ id: item.key, reason: "projected-elsewhere" }); return; }
        throw new Error(`Menu item ${item.key} names page "${item.page}", which is not in the web manifest.`);
      }
      return {
        ...base,
        label: { ...page.title, ...item.label },
        target: { kind: "operationPage", pageId: page.id },
        route: page.route.startsWith("/") ? page.route : `/${page.route}`,
        discoverOperations: [...page.operations],
        mcp,
      };
    }
    const route = literalRoute(item)!;
    if (!route.startsWith("/") || route.startsWith("//") || /[?#]/.test(route)) {
      throw new Error(`Menu item ${item.key} has an invalid local route.`);
    }
    // A literal route that a compiled view or page already answers would keep
    // a second, unowned definition of that destination alive.
    const owners = [...addressableViews(manifest, route), ...(matchPageRoute(manifest, route) ? [`page ${matchPageRoute(manifest, route)!.id}`] : [])];
    if (owners.length) {
      throw new Error(`Menu item ${item.key} routes to ${route}, which ${owners.join(", ")} already projects; reference it with entity/view or page.`);
    }
    return { ...base, label: item.label as LocalizedText, target: { kind: "hostPage" }, route, discoverOperations: [], mcp: { exposed: false, reason: item.mcp === false ? "authored" : "host-page" } };
  };

  for (const group of shell.navigation?.sidebarItems ?? []) {
    const items = group.children ?? (group.entity || group.page || literalRoute(group) ? [group] : []);
    const ids: string[] = [];
    for (const item of items) {
      const entry = project(item);
      if (!entry) continue;
      if (Object.hasOwn(entries, entry.id)) throw new Error(`Menu item key "${entry.id}" is used more than once.`);
      const route = segments(entry.route).join("/");
      if (routes.has(route)) throw new Error(`Menu items ${routes.get(route)} and ${entry.id} both open ${entry.route}.`);
      routes.set(route, entry.id);
      const tool = webAppEntryToolName("", entry.id);
      if (toolNames.has(tool)) throw new Error(`Menu items ${toolNames.get(tool)} and ${entry.id} would share an opener name.`);
      toolNames.set(tool, entry.id);
      entries[entry.id] = entry;
      ids.push(entry.id);
    }
    if (ids.length) navigation.push({ id: group.key, ...(group.children ? { label: group.label as LocalizedText } : {}), entries: ids });
  }
  return { entries: { contract: "openshapeforge.web-app-entries", version: 1, entries, navigation }, omitted };
}
