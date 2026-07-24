// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * App shell layout generator — produces the root Next.js layout with sidebar
 * navigation, the generated route group layout, and the home page.
 *
 * Pipeline position: called once across all entities after compilation to emit
 * cross-entity layout files into the web client.
 *
 * Input:  AppShell config, navigation route map, context labels.
 * Output: Map<string, string> — file path to generated TypeScript/TSX source code.
 */
import type { AppShell, AppShellNavItem, LocalizedText } from "../types.js";
import { renderTemplate } from "./helpers.js";

/** Next.js route group for compiler-emitted pages (does not affect URL paths). */
export const GENERATED_ROUTE_GROUP = "(generated)";

export function generatedRouteGroupLayoutPath(): string {
  return `app/${GENERATED_ROUTE_GROUP}/layout.tsx`;
}

export function generatedRouteGroupLoadingPath(): string {
  return `app/${GENERATED_ROUTE_GROUP}/loading.tsx`;
}

export function addGeneratedRouteGroupLayout(files: Map<string, string>) {
  files.set(
    generatedRouteGroupLayoutPath(),
    renderTemplate("app/generated-route-group-layout.tsx.ejs", {}),
  );
  files.set(
    generatedRouteGroupLoadingPath(),
    renderTemplate("app/generated-route-group-loading.tsx.ejs", {}),
  );
}

/**
 * Generate layout + home page (once, not per entity).
 */
export function generateLayout(
  appShell: AppShell,
  navRoutes: Map<string, LocalizedText | string>,
  allContextLabels: { key: string; label: { en: string; nl: string } }[],
  navItems?: any[]
): Map<string, string> {
  const files = new Map<string, string>();
  const hasMultipleContexts = allContextLabels.length > 1;
  const fallbackRoute = { en: "/", nl: "/" };

  function normalizeRoute(route: LocalizedText | string | undefined): LocalizedText {
    if (!route) {
      return fallbackRoute;
    }
    return typeof route === "string" ? { en: route, nl: route } : route;
  }

  // Recursively resolve nav items with children, routes, and context
  function resolveNavItem(item: AppShellNavItem): any {
    const resolved: any = { key: item.key, label: item.label, icon: item.icon };
    if (item.context) resolved.context = item.context;
    if (item.disabled) resolved.disabled = true;
    if (item.children) {
      resolved.children = item.children.map(resolveNavItem);
    } else if (item.route) {
      resolved.route = normalizeRoute(item.route);
    } else if (item.view || item.entity) {
      const lookupKey = item.view ?? item.entity!;
      resolved.route = normalizeRoute(navRoutes.get(lookupKey));
    } else {
      resolved.route = fallbackRoute;
    }
    return resolved;
  }

  const sourceNavItems = navItems ?? appShell.navigation.sidebarItems ?? appShell.navigation.items;
  const resolvedNavItems = sourceNavItems.map(resolveNavItem);
  const resolvedSettingsPanelItems = (appShell.navigation.settingsPanelItems ?? []).map(resolveNavItem);

  // Layout
  files.set("app/layout.tsx", renderTemplate("app/layout.tsx.ejs", {
    title: appShell.shell.title,
    shellComponent: appShell.shell.component,
    navItems: resolvedNavItems,
    settingsPanelItems: resolvedSettingsPanelItems,
    hasMultipleContexts,
    contextLabels: allContextLabels,
  }));
  addGeneratedRouteGroupLayout(files);

  // Home
  files.set("app/page.tsx", renderTemplate("app/home.tsx.ejs", { contract: null, navItems: resolvedNavItems }));

  return files;
}
