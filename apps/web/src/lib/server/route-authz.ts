// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import {
  GENERATED_ENTITY_NAME_SLUGS,
  GENERATED_ROUTE_ENTITY_SLUGS,
} from "@/compiler/entity-manifest";
import {
  getEntityAuth,
  rolesGrantOp,
  type AccessOp,
} from "@/lib/server/compiler-authz";
import type { NavItem } from "@/lib/navigation/types";

const entityNameSlugs = GENERATED_ENTITY_NAME_SLUGS as Record<string, string>;
const routeEntitySlugs = GENERATED_ROUTE_ENTITY_SLUGS as Record<string, string>;
const legacyRouteEntitySlugs: Record<string, string> = {
  "process-templates": "case-template",
  "process-template-steps": "case-step-template",
};

/**
 * Convert an entity's PascalCase name (`MaintenanceRequest`) to its generated
 * authoring slug (`maintenance-request`). Falls back to the deterministic
 * casing rule so non-generated hand-built entities keep working.
 */
export function entityNameToYamlSlug(pascal: string): string {
  return entityNameSlugs[pascal] ?? pascal
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Given a route path (with or without leading slash), returns the generated
 * entity slug if the route is entity-bound. Returns null for non-entity routes
 * so callers leave hand-built routes alone.
 */
export function resolveEntitySlugForRoute(routePath: string): string | null {
  if (!routePath || routePath === "/" || routePath === "") return null;
  const trimmed = routePath.replace(/^\/+/, "").split("/")[0];
  if (!trimmed) return null;
  return routeEntitySlugs[trimmed] ?? legacyRouteEntitySlugs[trimmed] ?? null;
}

export function getRequiredRolesForRoute(
  routePath: string,
  op: AccessOp = "read",
): ReadonlySet<string> | null {
  const slug = resolveEntitySlugForRoute(routePath);
  if (!slug) return null;
  try {
    return getEntityAuth(slug).required[op];
  } catch {
    return null;
  }
}

export function isRouteReadableByRoles(
  routePath: string,
  roles: readonly string[],
): boolean {
  const slug = resolveEntitySlugForRoute(routePath);
  if (!slug) return true;
  return rolesGrantOp(roles, "read", slug);
}

function pickAnyRouteValue(route: NavItem["route"]): string | null {
  if (!route) return null;
  for (const key of ["en", "nl", "fr"] as const) {
    const value = (route as Record<string, string | undefined>)[key];
    if (value) return value;
  }
  for (const value of Object.values(route)) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

export function filterNavItemsByRoles(
  items: readonly NavItem[],
  roles: readonly string[],
): NavItem[] {
  const result: NavItem[] = [];
  for (const item of items) {
    if (item.children && item.children.length > 0) {
      const filteredChildren = filterNavItemsByRoles(item.children, roles);
      if (filteredChildren.length > 0) {
        result.push({ ...item, children: filteredChildren });
      }
      continue;
    }
    const routeValue = pickAnyRouteValue(item.route);
    if (!routeValue) {
      result.push(item);
      continue;
    }
    if (isRouteReadableByRoles(routeValue, roles)) {
      result.push(item);
    }
  }
  return result;
}

/** Test-only compatibility hook; generated metadata is static. */
export function __resetRouteAuthzCacheForTests(): void {}
