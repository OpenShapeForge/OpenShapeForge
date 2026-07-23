// @ts-nocheck
/**
 * Entity manifest + dynamic route generator — produces a cross-entity manifest
 * that maps URL slugs to entity configs/actions, and 4 dynamic Next.js route
 * pages with Suspense boundaries.
 *
 * Pipeline position: called once after all entities are compiled and per-entity
 * generation is complete. Consumes collected manifest entry data from all entities.
 *
 * Input:  Array of EntityManifestEntryData (one per entity).
 * Output: Map<string, string> — manifest file + 4 dynamic route pages.
 */
import type { LocalizedText } from "../types.js";
import { renderTemplate } from "./helpers.js";
import { GENERATED_ROUTE_GROUP } from "./layout.js";

export type RuntimeAccessOp = "read" | "create" | "update" | "delete";

export type RuntimeEntityAuthorizationData = {
  slug: string;
  entity: string;
  required: Record<RuntimeAccessOp, string[]>;
};

export type RuntimePersonaData = {
  username: string;
  tid: string | null;
  realmRoles: string[];
  groupPaths: string[];
  effectiveClientRoles: string[];
};

export type RuntimeWaitConditionFieldData = {
  key: string;
  label: string;
  description?: string;
  fieldType: string;
  inputKind: "text" | "number" | "boolean" | "select";
  options?: Array<{ value: string; label: string }>;
};

export type RuntimeMetadataEntryData = {
  entityName: string;
  entitySlug: string;
  authorization: RuntimeEntityAuthorizationData;
  waitConditionFields: RuntimeWaitConditionFieldData[];
};

export type RuntimeMetadataData = {
  entities: RuntimeMetadataEntryData[];
  realmRoleComposites: Record<string, string[]>;
  personas: RuntimePersonaData[];
};

export type EntityManifestEntryData = {
  entityName: string;
  entityType: string;
  entityLower: string;
  entitySlug: string;
  typeName: string;
  realtimeResourceType: string;
  listQueryName: string;
  domains: string[];
  routes: Record<string, LocalizedText | string>;
  hasListConfigs: boolean;
  hasDetailConfigs: boolean;
  hasWorkspaceConfigs: boolean;
  hasCreateFormConfigs: boolean;
  hasEditFormConfigs: boolean;
};

function slugsFromRoutes(routes: Record<string, LocalizedText | string>): string[] {
  const listRoute = routes.list;
  if (!listRoute) return [];
  const values = typeof listRoute === "string" ? [listRoute] : Object.values(listRoute);
  return [...new Set(
    values.filter(Boolean).map((r) => (r as string).replace(/^\//, ""))
  )];
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildManifestVarName(entityLower: string): string {
  const normalized = entityLower.replace(/[^a-zA-Z0-9_$]/g, "_");
  return `entity_${normalized}`;
}

export function generateDynamicRoutes(
  entries: EntityManifestEntryData[],
  runtimeMetadata: RuntimeMetadataData,
): Map<string, string> {
  const files = new Map<string, string>();

  // Build slug → shard filename mapping. The shard filename is the entityLower
  // (matches the per-entity directory naming the rest of the compiler uses for
  // generated configs/actions).
  const slugMappings: Array<[string, string]> = [];
  const routeEntitySlugMappings: Array<[string, string]> = [];
  const seenSlugs = new Set<string>();
  for (const entry of entries) {
    for (const slug of slugsFromRoutes(entry.routes)) {
      if (seenSlugs.has(slug)) {
        continue;
      }
      seenSlugs.add(slug);
      slugMappings.push([slug, entry.entityLower]);
      routeEntitySlugMappings.push([slug, entry.entitySlug]);
    }
  }

  // Per-entity shard files — each holds one entity's static imports +
  // EntityManifestEntry, exported as default. Keeps the server module cache
  // bounded to entities actually requested at runtime.
  for (const entry of entries) {
    files.set(
      `compiler/entity-manifests/${entry.entityLower}.ts`,
      renderTemplate("app/entity-manifest-shard.ts.ejs", {
        entry,
        capitalizeFirst,
      }),
    );
  }

  // Dispatcher — async resolveEntity() that lazily loads shards.
  files.set(
    "compiler/entity-manifest.ts",
    renderTemplate("app/entity-manifest.ts.ejs", {
      slugMappings,
      runtimeMetadataSource: renderRuntimeMetadata({
        ...runtimeMetadata,
        routeEntitySlugMappings,
      }),
    }),
  );

  // Dynamic route pages
  files.set(
    `app/${GENERATED_ROUTE_GROUP}/[entity]/page.tsx`,
    renderTemplate("app/dynamic-list-page.tsx.ejs", {}),
  );
  files.set(
    `app/${GENERATED_ROUTE_GROUP}/[entity]/list-client.tsx`,
    renderTemplate("app/dynamic-list-client.tsx.ejs", {}),
  );
  files.set(
    `app/${GENERATED_ROUTE_GROUP}/[entity]/[id]/page.tsx`,
    renderTemplate("app/dynamic-detail-page.tsx.ejs", {}),
  );
  files.set(
    `app/${GENERATED_ROUTE_GROUP}/[entity]/[id]/edit/page.tsx`,
    renderTemplate("app/dynamic-edit-page.tsx.ejs", {}),
  );
  files.set(
    `app/${GENERATED_ROUTE_GROUP}/[entity]/create/page.tsx`,
    renderTemplate("app/dynamic-create-page.tsx.ejs", {}),
  );

  return files;
}

function stableStringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function renderRuntimeMetadata(
  data: RuntimeMetadataData & {
    routeEntitySlugMappings: Array<[string, string]>;
  },
) {
  const entityAuthEntries = data.entities
    .map((entry) => [entry.entitySlug, entry.authorization] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const entityNameEntries = data.entities
    .map((entry) => [entry.entityName, entry.entitySlug] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const waitFieldEntries = data.entities
    .map((entry) => [entry.entitySlug, entry.waitConditionFields] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const routeEntries = data.routeEntitySlugMappings
    .sort(([left], [right]) => left.localeCompare(right));

  return `// Generated by OpenShapeForge Service Compiler
// Production runtime metadata for authorization and workflow designer lookups.

export type GeneratedAccessOp = "read" | "create" | "update" | "delete";

export type GeneratedEntityAuthorization = {
  slug: string;
  entity: string;
  required: Record<GeneratedAccessOp, readonly string[]>;
};

export type GeneratedPersona = {
  username: string;
  tid: string | null;
  realmRoles: readonly string[];
  groupPaths: readonly string[];
  effectiveClientRoles: readonly string[];
};

export type GeneratedWaitConditionField = {
  key: string;
  label: string;
  description?: string;
  fieldType: string;
  inputKind: "text" | "number" | "boolean" | "select";
  options?: readonly { value: string; label: string }[];
};

export const GENERATED_ROUTE_ENTITY_SLUGS = ${stableStringify(Object.fromEntries(routeEntries))} as const;

export const GENERATED_ENTITY_NAME_SLUGS = ${stableStringify(Object.fromEntries(entityNameEntries))} as const;

export const GENERATED_ENTITY_AUTH = ${stableStringify(Object.fromEntries(entityAuthEntries))} as const satisfies Record<string, GeneratedEntityAuthorization>;

export const GENERATED_REALM_ROLE_COMPOSITES = ${stableStringify(data.realmRoleComposites)} as const satisfies Record<string, readonly string[]>;

export const GENERATED_PERSONAS = ${stableStringify(data.personas)} as const satisfies readonly GeneratedPersona[];

export const GENERATED_WAIT_CONDITION_FIELDS = ${stableStringify(Object.fromEntries(waitFieldEntries))} as const satisfies Record<string, readonly GeneratedWaitConditionField[]>;
`;
}
