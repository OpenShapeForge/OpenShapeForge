// @ts-nocheck
/**
 * View-driven page generator — produces Next.js list pages, detail pages, and
 * create/edit forms from compiled entity contracts and view contexts.
 *
 * Pipeline position: final stage of the generation pipeline. Consumes CompiledEntityContract
 * and ViewDefinition to emit Next.js page.tsx files, form field configurations, GraphQL
 * selection sets, and route structures under a "(generated)" route group.
 *
 * Handles referentiedata option resolution for form fields that use remote data sources.
 *
 * Input:  ViewDefinition + CompiledEntityContract.
 * Output: Map<string, string> — file path to generated TypeScript/TSX source code.
 */
import path from "node:path";
import type {
  CompiledEntityContract,
  CompiledField,
  CompiledNamedPresentation,
  CompiledViewContext,
  CompiledViewActionDefinition,
  CompiledViewRowAction,
  PresentationDefinition,
  FieldOptions,
  FormVariableSource,
  GraphQLProfileType,
  ListFilter,
  LocalizedText,
  RelationshipOverrides,
  ViewDefinition,
} from "../types.js";
import { resolveFieldOptionsForClient } from "../referentiedata/resolve-referentiedata-options.js";
import { renderTemplate } from "./helpers.js";
import { GENERATED_ROUTE_GROUP } from "./layout.js";
import { normalizeMultiContextPresentations } from "../view-normalization.js";
import type {
  EntityManifestEntryData,
  RuntimeMetadataEntryData,
  RuntimeWaitConditionFieldData,
} from "./manifest.js";
import { normalizeKeycloakRoleName } from "./keycloak.js";

export type EntityPageConfigBundle = {
  entitySlug: string;
  listConfigs: Record<string, unknown>;
  detailConfigs: Record<string, unknown>;
  workspaceConfigs: Record<string, unknown>;
  createFormConfigs: Record<string, unknown>;
  editFormConfigs: Record<string, unknown>;
};

export type ViewPagesResult = {
  files: Map<string, string>;
  manifestEntry: EntityManifestEntryData;
  /**
   * Raw per-entity config objects (the same data baked into the .ts config
   * bases). Aggregated by generate-ui-artifacts into the
   * entity-page-configs.seed.json catalog so the configs can be served from
   * Postgres ALONGSIDE the generated .ts files. The .ts emission is unchanged.
   */
  pageConfigBundle: EntityPageConfigBundle;
};

/**
 * WEB-020 — Mirror of the authoring `FieldSuggestions` block, kept local to
 * the generator so the emitted JSON stays in lockstep with what the renderer
 * reads. The shape mirrors `FieldSuggestions` in `types/authoring.ts`.
 */
type GeneratedFieldSuggestions = {
  /** Legacy: sibling field whose value names the entity type. */
  sourceField?: string;
  /** WEB-020: opt-in key of a form-level `FormVariableSource`. */
  sourceKey?: string;
};

type GeneratedFormFieldConfig = {
  key: string;
  dataPath: string;
  valueType: CompiledField["valueType"];
  cardinality?: CompiledField["cardinality"];
  variables?: CompiledField["variables"];
  sortable?: boolean;
  semanticType?: string;
  label: LocalizedText;
  description?: LocalizedText;
  help?: LocalizedText;
  required: boolean;
  readOnly?: boolean;
  defaultValue?: unknown;
  /**
   * Optional column-span hint, consumed by the web-client renderer's
   * layout-policy helpers (`getRendererFieldSpan`). Values:
   * - undefined / <= 0 → single column (default)
   * - >= 1 → full width (spans all grid columns for the current group)
   * - fractional (e.g. 0.5) → proportional span
   * Pass-through from the authoring `field.layoutFraction`.
   */
  layoutFraction?: number;
  render: {
    component: string;
    props?: Record<string, unknown>;
  };
  visibility?: CompiledField["visibility"];
  validation?: Record<string, unknown>;
  options?: Record<string, unknown>;
  suggestions?: GeneratedFieldSuggestions;
  children?: GeneratedFormFieldConfig[];
  item?: GeneratedFormFieldConfig;
};

type GeneratedFormConfig = {
  mode: "create" | "edit";
  title: LocalizedText;
  submitLabel: LocalizedText;
  successRoute: string;
  actions?: NonNullable<CompiledViewContext["form"]>["actions"];
  routes?: Record<string, LocalizedText | string>;
  groups: GeneratedGroupConfig[];
  fields: GeneratedFormFieldConfig[];
  /**
   * WEB-020 — Form-level variable sources consumed by the web-client
   * renderer via `RendererFormDefinition.variableSources`. Emitted verbatim
   * from the authoring `form.variableSources` block.
   */
  variableSources?: FormVariableSource[];
};

const WAIT_CONDITION_VALUE_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
]);

type GeneratedTimelineInclude =
  | "self"
  | { relationship: string };

type GeneratedTimelineConfig = {
  include?: GeneratedTimelineInclude[];
};

type GeneratedGroupConfig = {
  id: string;
  title?: LocalizedText;
  /**
   * When true, the renderer suppresses this group's card title. Set by the
   * generator when the group would visually duplicate a label the viewer can
   * already see (e.g. an innermost card that holds a single field whose
   * label matches the card's title). Kept optional so existing groups stay
   * unaffected.
   */
  hideGroupTitle?: boolean;
  label?: LocalizedText;
  render?: string;
  fields?: string[];
  relationships?: {
    name: string;
    view?: string;
    overrides?: RelationshipOverrides;
    presentationType?: "list" | "cards" | "summary" | "listItem";
    titleField?: string;
    subtitleField?: string;
    title?: LocalizedText;
    emptyState?: LocalizedText;
    actions?: NonNullable<CompiledViewContext["list"]>["actions"];
    itemActions?: NonNullable<CompiledViewContext["list"]>["actions"];
    routes?: Record<string, LocalizedText | string>;
    fields?: GeneratedDetailFieldConfig[];
  }[];
  relationship?: {
    name: string;
    view?: string;
    overrides?: RelationshipOverrides;
    presentationType?: "list" | "cards" | "summary" | "listItem";
    titleField?: string;
    subtitleField?: string;
    title?: LocalizedText;
    emptyState?: LocalizedText;
    actions?: NonNullable<CompiledViewContext["list"]>["actions"];
    itemActions?: NonNullable<CompiledViewContext["list"]>["actions"];
    routes?: Record<string, LocalizedText | string>;
    fields?: GeneratedDetailFieldConfig[];
  };
  groups?: GeneratedGroupConfig[];
  /**
   * Per-view timeline composition config. Only meaningful when
   * `render === "timeline"`. Passed verbatim from authoring YAML through the
   * compiled view group to the web renderer.
   */
  timeline?: GeneratedTimelineConfig;
};

type GeneratedListColumnConfig = {
  key: string;
  label: LocalizedText;
  sortable?: boolean;
  accessor?: string;
  render?: {
    component: string;
  };
};

type GeneratedListConfig = {
  query: string;
  queryName: string;
  realtimeResourceType: string;
  title: LocalizedText;
  subtitle?: LocalizedText;
  columns: GeneratedListColumnConfig[];
  filters?: ListFilter[];
  filterField: string;
  searchPlaceholder: LocalizedText;
  defaultSort?: { key: string; direction: "asc" | "desc" };
  actions?: NonNullable<CompiledViewContext["list"]>["actions"];
  actionDefinitions?: Record<string, CompiledViewActionDefinition>;
  rowActions?: CompiledViewRowAction[];
  routes?: Record<string, LocalizedText | string>;
  deleteMutationName?: string;
  rowLink: LocalizedText | string;
};

type GeneratedDetailFieldConfig = {
  key: string;
  label: LocalizedText;
  valueType?: CompiledField["valueType"];
  cardinality?: CompiledField["cardinality"];
  semanticType?: string;
  /** Mirror of the authoring field's `layoutFraction`, consumed by the renderer's layout-policy helpers. */
  layoutFraction?: number;
  render: {
    component: string;
    props?: Record<string, unknown>;
  };
  validation?: Record<string, unknown>;
  options?: Record<string, unknown>;
  /**
   * Mirror of the authoring field's `suggestions` block so the display-mode
   * renderer can reuse the same sibling-field indirection the edit form
   * already relies on (e.g. a `condition` field reading `entityType` to pick
   * the right variable suggestions list).
   *
   * WEB-020 — also carries `sourceKey` / `filter` for fields that opt into a
   * form-level variable source.
   */
  suggestions?: GeneratedFieldSuggestions;
  children?: GeneratedDetailFieldConfig[];
  item?: GeneratedDetailFieldConfig;
  /** Passed through to web client as RendererFieldConfig.displayMode === "hidden". */
  fieldDisplayMode?: "hidden";
};

type GeneratedDetailConfig = {
  queriesByGroup: Record<string, string>;
  queryName: string;
  realtimeResourceType: string;
  defaultGroupId: string;
  deleteMutationName?: string;
  render?: string;
  header: {
    titleTemplate: string;
    subtitleTemplate?: string;
    badges?: string[];
  };
  actions?: NonNullable<CompiledViewContext["detail"]>["actions"];
  routes?: Record<string, LocalizedText | string>;
  groups: GeneratedGroupConfig[];
  fields: GeneratedDetailFieldConfig[];
  listRoute: LocalizedText | string;
  pathnameTemplate: LocalizedText | string;
};

type GeneratedWorkspacePaneConfig = {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  weight?: number;
  resizable?: boolean;
};

type GeneratedWorkspaceGroupPaneConfig = GeneratedWorkspacePaneConfig & {
  title?: LocalizedText;
  groups: GeneratedGroupConfig[];
  fields: GeneratedDetailFieldConfig[];
};

type GeneratedWorkspaceConfig = {
  realtimeResourceType: string;
  render?: string;
  title?: LocalizedText;
  subtitle?: LocalizedText;
  selectionParam: string;
  defaultSelectionSource: "firstRow" | "none";
  actions?: NonNullable<CompiledViewContext["workspace"]>["actions"];
  routes?: Record<string, LocalizedText | string>;
  layout: {
    variant: string;
  };
  list: GeneratedWorkspacePaneConfig & {
    config: GeneratedListConfig;
  };
  body: GeneratedWorkspacePaneConfig & {
    config: GeneratedDetailConfig;
  };
  sidebar?: GeneratedWorkspaceGroupPaneConfig;
  related?: GeneratedWorkspaceGroupPaneConfig;
  queriesByBodyGroup: Record<string, string>;
};

function generatedAppPagePath(route: string): string {
  return `app/${GENERATED_ROUTE_GROUP}/${routeToNextPath(route)}/page.tsx`;
}

function generatedAppRouteDir(route: string): string {
  return `app/${GENERATED_ROUTE_GROUP}/${routeToNextPath(route)}`;
}

function generatedSharedFormSchemaBasePath(
  contract: CompiledEntityContract,
  mode: "create" | "edit"
): string {
  return `app/${GENERATED_ROUTE_GROUP}/_generated/${contract.entity.name.toLowerCase()}/${mode}-form-schema-base.ts`;
}

function generatedSharedListConfigBasePath(contract: CompiledEntityContract): string {
  return `app/${GENERATED_ROUTE_GROUP}/_generated/${contract.entity.name.toLowerCase()}/list-config-base.ts`;
}

function generatedSharedDetailConfigBasePath(contract: CompiledEntityContract): string {
  return `app/${GENERATED_ROUTE_GROUP}/_generated/${contract.entity.name.toLowerCase()}/detail-config-base.ts`;
}

function generatedSharedWorkspaceConfigBasePath(contract: CompiledEntityContract): string {
  return `app/${GENERATED_ROUTE_GROUP}/_generated/${contract.entity.name.toLowerCase()}/workspace-config-base.ts`;
}

function generatedSharedPageModulePath(
  contract: CompiledEntityContract,
  kind: "list" | "detail" | "create" | "edit"
): string {
  return `app/${GENERATED_ROUTE_GROUP}/_generated/${contract.entity.name.toLowerCase()}/${kind}-page.tsx`;
}

/**
 * Generate per-entity config bases, form schema bases, and server actions.
 * Route page generation has moved to dynamic routes (see manifest.ts).
 */
export function generateViewPages(
  view: ViewDefinition,
  contract: CompiledEntityContract,
  allContextLabels: { key: string; label: { en: string; nl: string } }[],
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): ViewPagesResult {
  const files = new Map<string, string>();
  const usedDetailRelationshipPaths = new Set<string>();

  function collectCompiledRelationshipPaths(
    groups: NonNullable<CompiledViewContext["detail"]>["groups"]["items"] | undefined,
  ) {
    if (!groups) {
      return;
    }

    for (const group of groups) {
      if (group.relationship?.name) {
        const selectionPath = resolveRelationshipSelectionPath(contract, group.relationship, contractCache);
        if (selectionPath) {
          usedDetailRelationshipPaths.add(selectionPath);
        }
      }

      for (const relationship of group.relationships ?? []) {
        if (relationship?.name) {
          const selectionPath = resolveRelationshipSelectionPath(contract, relationship, contractCache);
          if (selectionPath) {
            usedDetailRelationshipPaths.add(selectionPath);
          }
        }
      }

      collectCompiledRelationshipPaths(group.groups);
    }
  }

  for (const contextView of Object.values(contract.views)) {
    collectCompiledRelationshipPaths(contextView.detail?.groups.items);
  }

  const detailRelationshipSelectionSet = buildSelectionSet(
    contract,
    "core",
    [...usedDetailRelationshipPaths],
  );

  // Server action for this entity
  const entityLower = contract.entity.name.toLowerCase();
  files.set(`actions/generated/${entityLower}.ts`, renderTemplate("app/actions.ts.ejs", {
    contract,
    detailRelationshipSelectionSet,
  }));

  const contexts = Object.keys(contract.views);
  const routes = view.routes;
  const gql = contract.graphql;

  // Config objects feed the entity-page-configs seed (platform.entity_page_configs)
  // via pageConfigBundle below. They are NO LONGER emitted as `.ts` config-base
  // files — the web reads them at runtime from the catalog over GraphQL.
  const listConfigs = buildListConfigs(contract, contexts, contract.views, routes);
  const detailConfigs = buildDetailConfigs(contract, contexts, contract.views, routes, viewDefinitionCache, contractCache);
  const workspaceConfigs = buildWorkspaceConfigs(contract, contexts, contract.views, routes, viewDefinitionCache, contractCache);
  const createFormConfigs = routes.create
    ? buildFormConfigs(contract, contexts, contract.views, routes, getCanonicalRoute(routes.create), "create", viewDefinitionCache, contractCache)
    : {};
  const editFormConfigs = routes.edit
    ? buildFormConfigs(contract, contexts, contract.views, routes, getCanonicalRoute(routes.edit), "edit", viewDefinitionCache, contractCache)
    : {};

  // Build manifest entry data for the cross-entity manifest generator
  const manifestEntry: EntityManifestEntryData = {
    entityName: contract.entity.name,
    entityType: `${contract.entity.module}.${contract.entity.name.charAt(0).toLowerCase()}${contract.entity.name.slice(1)}`,
    entityLower,
    entitySlug: contract.authorization.entitySlug,
    typeName: gql.typeName,
    realtimeResourceType: gql.queries.single.name,
    listQueryName: gql.queries.list.name,
    domains: contract.entity.domains,
    routes,
    hasListConfigs: Object.keys(listConfigs).length > 0,
    hasDetailConfigs: Object.keys(detailConfigs).length > 0,
    hasWorkspaceConfigs: Object.keys(workspaceConfigs).length > 0,
    hasCreateFormConfigs: Object.keys(createFormConfigs).length > 0,
    hasEditFormConfigs: Object.keys(editFormConfigs).length > 0,
  };

  const pageConfigBundle: EntityPageConfigBundle = {
    entitySlug: contract.authorization.entitySlug,
    listConfigs,
    detailConfigs,
    workspaceConfigs,
    createFormConfigs,
    editFormConfigs,
  };

  return { files, manifestEntry, pageConfigBundle };
}

function uniqueRoutes(route: LocalizedText | string): string[] {
  if (typeof route === "string") return [route];
  return [...new Set(Object.values(route).filter(Boolean) as string[])];
}

function getCanonicalRoute(route: LocalizedText | string): string {
  if (typeof route === "string") return route;
  return route.en ?? Object.values(route).find(Boolean) ?? "/";
}

function routeToNextPath(route: string): string {
  return route.replace(/^\//, "").replace(/:(\w+)/g, "[$1]");
}

function toRelativeImportPath(fromFile: string, targetFile: string): string {
  const relative = path.posix.relative(path.posix.dirname(fromFile), targetFile);
  const normalized = relative.startsWith(".") ? relative : `./${relative}`;
  return normalized.replace(/\.(ts|tsx|js|jsx)$/, "");
}

function getParentRoute(route: LocalizedText | string | undefined): string {
  if (!route) return "/";
  if (typeof route === "string") return route;
  return route.en ?? route.nl ?? "/";
}

/**
 * Given a localized route map and a current route string, find which language
 * the current route belongs to, then return the matching value from the target
 * localized route. Falls back to English if no match is found.
 */
function getMatchingRoute(
  currentRoute: string,
  currentRouteMap: LocalizedText | string | undefined,
  targetRouteMap: LocalizedText | string | undefined
): string {
  if (!targetRouteMap) return "/";
  if (typeof targetRouteMap === "string") return targetRouteMap;
  if (!currentRouteMap || typeof currentRouteMap === "string") return targetRouteMap.en ?? targetRouteMap.nl ?? "/";

  // Find which language the current route corresponds to
  for (const [lang, routeValue] of Object.entries(currentRouteMap)) {
    if (routeValue === currentRoute) {
      return (targetRouteMap as Record<string, string>)[lang] ?? targetRouteMap.en ?? "/";
    }
  }
  return targetRouteMap.en ?? targetRouteMap.nl ?? "/";
}

function writeGeneratedFormRoute(
  files: Map<string, string>,
  {
    contract,
    contexts,
    route,
    routes,
    views,
    mode,
    viewDefinitionCache,
  }: {
    contract: CompiledEntityContract;
    contexts: string[];
    route: string;
    routes: Record<string, LocalizedText | string>;
    views: Record<string, CompiledViewContext>;
    mode: "create" | "edit";
    viewDefinitionCache?: Map<string, ViewDefinition>;
  }
) {
  const routeDir = generatedAppRouteDir(route);
  const currentConfigs = buildFormConfigs(contract, contexts, views, routes, route, mode, viewDefinitionCache);
  const successRoutesByContext = Object.fromEntries(
    Object.entries(currentConfigs).map(([context, config]) => [context, config.successRoute])
  );
  const baseSchemaPath = generatedSharedFormSchemaBasePath(contract, mode);
  const canonicalRoute = getCanonicalRoute(mode === "edit" ? routes.edit : routes.create);
  const canonicalConfigs = buildFormConfigs(contract, contexts, views, routes, canonicalRoute, mode, viewDefinitionCache);
  const formFieldKeys = [...new Set(
    Object.values(canonicalConfigs).flatMap((config) => config.fields.map((field) => field.key))
  )];
  const sharedPagePath = generatedSharedPageModulePath(contract, mode);

  if (!files.has(baseSchemaPath)) {
    files.set(baseSchemaPath, renderTemplate("app/generated-form-schema-base.ts.ejs", {
      configs: canonicalConfigs,
    }));
  }

  if (!files.has(sharedPagePath)) {
    files.set(sharedPagePath, renderTemplate(
      mode === "edit" ? "app/generated-edit-page.tsx.ejs" : "app/generated-form-page.tsx.ejs",
      { contract }
    ));
  }

  files.set(`${routeDir}/form-schema.ts`, renderTemplate("app/generated-form-schema.ts.ejs", {
    baseImportPath: toRelativeImportPath(`${routeDir}/form-schema.ts`, baseSchemaPath),
    successRoutesByContext,
    formFieldKeys,
  }));
  files.set(generatedAppPagePath(route), renderTemplate(
    mode === "edit" ? "app/entity-edit.tsx.ejs" : "app/entity-form.tsx.ejs",
    {
      contract,
      sharedPageImportPath: toRelativeImportPath(generatedAppPagePath(route), sharedPagePath),
    }
  ));
}

function writeGeneratedListRoute(
  files: Map<string, string>,
  {
    contract,
    contexts,
    route,
    routes,
    views,
  }: {
    contract: CompiledEntityContract;
    contexts: string[];
    route: string;
    routes: Record<string, LocalizedText | string>;
    views: Record<string, CompiledViewContext>;
  }
) {
  const baseConfigPath = generatedSharedListConfigBasePath(contract);
  const canonicalConfigs = buildListConfigs(contract, contexts, views, routes);
  const sharedPagePath = generatedSharedPageModulePath(contract, "list");

  if (!files.has(baseConfigPath)) {
    files.set(baseConfigPath, renderTemplate("app/generated-list-config-base.ts.ejs", {
      configs: canonicalConfigs,
    }));
  }

  if (!files.has(sharedPagePath)) {
    files.set(sharedPagePath, renderTemplate("app/generated-list-page.tsx.ejs", {
      contract,
      gql: contract.graphql,
    }));
  }

  files.set(
    generatedAppPagePath(route),
    renderTemplate("app/re-export-default.ts.ejs", {
      exportPath: toRelativeImportPath(generatedAppPagePath(route), sharedPagePath),
    }),
  );
}

/**
 * Detail UI is a single Next.js `page.tsx` per route (`entity-detail.tsx.ejs`), which composes
 * the shared `Renderer` from the web client. This generator does not emit `detail.tsx`,
 * `detail-action.ts`, or a UI registry file—avoid parallel detail modules; extend the shared
 * renderer/detail mapping instead.
 */
function writeGeneratedDetailRoute(
  files: Map<string, string>,
  {
    contract,
    contexts,
    route,
    routes,
    views,
    viewDefinitionCache,
  }: {
    contract: CompiledEntityContract;
    contexts: string[];
    route: string;
    routes: Record<string, LocalizedText | string>;
    views: Record<string, CompiledViewContext>;
    viewDefinitionCache?: Map<string, ViewDefinition>;
  }
) {
  const baseConfigPath = generatedSharedDetailConfigBasePath(contract);
  const canonicalConfigs = buildDetailConfigs(contract, contexts, views, routes, viewDefinitionCache);
  const sharedPagePath = generatedSharedPageModulePath(contract, "detail");

  if (!files.has(baseConfigPath)) {
    files.set(baseConfigPath, renderTemplate("app/generated-detail-config-base.ts.ejs", {
      configs: canonicalConfigs,
    }));
  }

  if (!files.has(sharedPagePath)) {
    files.set(sharedPagePath, renderTemplate("app/generated-detail-page.tsx.ejs", {
      contract,
    }));
  }

  files.set(
    generatedAppPagePath(route),
    renderTemplate("app/re-export-default.ts.ejs", {
      exportPath: toRelativeImportPath(generatedAppPagePath(route), sharedPagePath),
    }),
  );
}

function buildFormConfigs(
  contract: CompiledEntityContract,
  contexts: string[],
  views: Record<string, CompiledViewContext>,
  routes: Record<string, LocalizedText | string>,
  route: string,
  mode: "create" | "edit",
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): Record<string, GeneratedFormConfig> {
  const configs: Record<string, GeneratedFormConfig> = {};

  for (const context of contexts) {
    const config = buildFormConfig(contract, context, views[context], routes, route, mode, viewDefinitionCache, contractCache);
    if (config) {
      configs[context] = config;
    }
  }

  return configs;
}

function buildDetailConfigs(
  contract: CompiledEntityContract,
  contexts: string[],
  views: Record<string, CompiledViewContext>,
  routes: Record<string, LocalizedText | string>,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): Record<string, GeneratedDetailConfig> {
  const configs: Record<string, GeneratedDetailConfig> = {};

  for (const context of contexts) {
    const config = buildDetailConfig(contract, context, views[context], routes, viewDefinitionCache, contractCache);
    if (config) {
      configs[context] = config;
    }
  }

  return configs;
}

function buildWorkspaceConfigs(
  contract: CompiledEntityContract,
  contexts: string[],
  views: Record<string, CompiledViewContext>,
  routes: Record<string, LocalizedText | string>,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): Record<string, GeneratedWorkspaceConfig> {
  const configs: Record<string, GeneratedWorkspaceConfig> = {};

  for (const context of contexts) {
    const config = buildWorkspaceConfig(contract, context, views[context], routes, viewDefinitionCache, contractCache);
    if (config) {
      configs[context] = config;
    }
  }

  return configs;
}

function buildListConfigs(
  contract: CompiledEntityContract,
  contexts: string[],
  views: Record<string, CompiledViewContext>,
  routes: Record<string, LocalizedText | string>
): Record<string, GeneratedListConfig> {
  const configs: Record<string, GeneratedListConfig> = {};

  for (const context of contexts) {
    const config = buildListConfig(contract, context, views[context], routes);
    if (config) {
      configs[context] = config;
    }
  }

  return configs;
}

function collectCompiledGroupFieldKeys(
  groups: readonly NonNullable<CompiledViewContext["detail"]>["groups"]["items"][number][],
  keys: Set<string>,
  renderOverrides: Record<string, GeneratedDetailFieldConfig["render"]>,
  fieldDisplayModes: Record<string, "hidden">,
) {
  for (const group of groups) {
    for (const field of group.fields ?? []) {
      const key = typeof field === "string" ? field : field.key;
      keys.add(key);

      if (typeof field === "object") {
        if (field.renderOverride) {
          renderOverrides[key] = field.renderOverride;
        }
        if (field.fieldDisplayMode === "hidden") {
          fieldDisplayModes[key] = "hidden";
        }
      }
    }

    if (group.groups?.length) {
      collectCompiledGroupFieldKeys(group.groups, keys, renderOverrides, fieldDisplayModes);
    }
  }
}

function mapGeneratedDetailFieldKey(
  contract: CompiledEntityContract,
  context: string,
  key: string,
): string {
  return resolveFieldPath(contract, context, key) ?? key;
}

function createRelationshipConfigMapper(
  contract: CompiledEntityContract,
  context: string,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
) {
  return (relationship: {
    name: string;
    via?: string;
    view?: string;
    overrides?: RelationshipOverrides;
  }) => {
    const metadata = resolveRelationshipPresentationMetadata(
      contract,
      relationship,
      context,
      viewDefinitionCache,
      contractCache,
    );
    const selectionPath = resolveRelationshipSelectionPath(contract, relationship, contractCache) ?? relationship.name;
    const fields = buildRelationshipPresentationFields(
      contract,
      relationship,
      context,
      viewDefinitionCache,
      contractCache,
    );

    return {
      name: selectionPath,
      view: relationship.view,
      overrides: relationship.overrides,
      presentationType: metadata?.presentationType,
      titleField: metadata?.titleField,
      subtitleField: metadata?.subtitleField,
      title: relationship.overrides?.title ?? metadata?.title,
      emptyState: relationship.overrides?.emptyState ?? metadata?.emptyState,
      actions: metadata?.actions,
      itemActions: metadata?.itemActions,
      routes: metadata?.routes,
      fields: fields.length > 0 ? fields : undefined,
    };
  };
}

/**
 * Build the per-column field metadata that an embedded relationship list needs
 * to render labels correctly: one entry per target-entity list column, with
 * the authoring label (not just the humanized key).
 *
 * For columns that point at a belongsTo relationship, emits an entry under the
 * nested display-field path (e.g. `author.displayName`) so the renderer can
 * look up the label when it walks the data object.
 */
function buildRelationshipPresentationFields(
  contract: CompiledEntityContract,
  relationship: {
    name: string;
    via?: string;
    view?: string;
    overrides?: { columns?: Array<string | { key: string }> };
  },
  context: string,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): GeneratedDetailFieldConfig[] {
  const resolved = resolveRelationshipTargetPresentation(
    contract,
    relationship,
    context,
    viewDefinitionCache,
    contractCache,
  );
  if (!resolved) return [];

  const { targetContract, targetViewContextName, targetViewContext, presentation } = resolved;

  const overrideColumns = relationship.overrides?.columns;
  let fieldSpecs: Array<string | { key: string; label?: LocalizedText }> = [];
  if (overrideColumns && overrideColumns.length > 0) {
    fieldSpecs = overrideColumns.map((col) => (typeof col === "string" ? { key: col } : col));
  } else if (presentation?.type === "listItem") {
    fieldSpecs = (presentation.fields ?? []).map((entry) =>
      typeof entry === "string" ? { key: entry } : { key: entry.key },
    );
  } else if (presentation?.type === "list") {
    fieldSpecs = presentation.columns.map((col) => {
      const def = col as typeof col & { accessor?: string; label?: LocalizedText };
      return { key: def.accessor ?? def.key, label: def.label };
    });
  } else if (presentation?.type === "summary" || presentation?.type === "cards") {
    fieldSpecs = (presentation.fields ?? []).map((entry) =>
      typeof entry === "string" ? { key: entry } : { key: entry.key },
    );
  } else if (targetViewContext.list?.columns) {
    fieldSpecs = targetViewContext.list.columns.map((col) => {
      const def = col as typeof col & { accessor?: string; label?: LocalizedText };
      return { key: def.accessor ?? def.key, label: def.label };
    });
  }

  const relationshipKeys = new Set(targetContract.model.relationships.map((rel) => rel.key));
  const fields: GeneratedDetailFieldConfig[] = [];

  for (const spec of fieldSpecs) {
    const key = spec.key;
    if (relationshipKeys.has(key)) {
      // For relationship columns, point the label at the nested display field
      // (matches the path that resolveRelationshipListFieldPaths produces).
      const rel = targetContract.model.relationships.find((candidate) => candidate.key === key);
      if (!rel) continue;
      const nestedTargetContract = contractCache?.get(toEntitySlug(rel.target));
      if (!nestedTargetContract) continue;
      const nestedFieldKeys = new Set(nestedTargetContract.model.fields.map((f) => f.key));
      const displayField = RELATIONSHIP_DISPLAY_FIELD_CANDIDATES.find((c) => nestedFieldKeys.has(c));
      if (!displayField) continue;

      const label = (spec as { label?: LocalizedText }).label ?? rel.label
        ?? { en: key, nl: key };
      fields.push({
        key: `${key}.${displayField}`,
        label,
        valueType: "string",
        cardinality: "single",
        render: { component: "TextDisplay" },
      });
      continue;
    }

    const fieldConfig = buildDetailFieldConfig(targetContract, targetViewContextName, key);
    fields.push({
      ...fieldConfig,
      label: (spec as { label?: LocalizedText }).label ?? fieldConfig.label,
    });
  }

  return fields;
}

function mapGeneratedViewGroup(
  contract: CompiledEntityContract,
  context: string,
  group: NonNullable<CompiledViewContext["detail"]>["groups"]["items"][number],
  mapRelationshipConfig: ReturnType<typeof createRelationshipConfigMapper>,
): GeneratedGroupConfig {
  return {
    id: group.id,
    title: group.title,
    label: group.label,
    render: group.render?.component,
    fields: group.fields?.map((field) => mapGeneratedDetailFieldKey(contract, context, typeof field === "string" ? field : field.key)),
    relationships: group.relationships?.map(mapRelationshipConfig),
    relationship: group.relationship ? mapRelationshipConfig(group.relationship) : undefined,
    groups: group.groups?.map((child) => mapGeneratedViewGroup(contract, context, child, mapRelationshipConfig)),
    timeline: group.timeline,
  };
}

function localizedTextEquals(
  a: LocalizedText | string | undefined,
  b: LocalizedText | string | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  const normalize = (value: LocalizedText | string): Record<string, string> => {
    if (typeof value === "string") return { en: value, nl: value };
    const out: Record<string, string> = {};
    if (typeof value.en === "string") out.en = value.en;
    if (typeof value.nl === "string") out.nl = value.nl;
    return out;
  };
  const left = normalize(a);
  const right = normalize(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return Object.keys(left).length > 0;
}

/**
 * Mark innermost generated groups whose card title would visually duplicate
 * the label of the single field they contain. The renderer reads
 * `hideGroupTitle` and suppresses the title while keeping the field label
 * (which stays closer to the value). Applies to detail + workspace configs
 * only (forms still benefit from explicit section headings even when they
 * match the sole field).
 */
function markRedundantGroupTitles(
  groups: GeneratedGroupConfig[],
  fieldsByKey: Map<string, GeneratedDetailFieldConfig>,
): void {
  for (const group of groups) {
    const hasChildGroups = Boolean(group.groups?.length);
    const hasRelationships =
      Boolean(group.relationships?.length) || Boolean(group.relationship);
    const isInnermost = !hasChildGroups && !hasRelationships;
    const singleFieldKey =
      group.fields && group.fields.length === 1 ? group.fields[0] : undefined;

    if (isInnermost && group.title && singleFieldKey) {
      const fieldConfig = fieldsByKey.get(singleFieldKey);
      if (fieldConfig?.label && localizedTextEquals(group.title, fieldConfig.label)) {
        group.hideGroupTitle = true;
      }
    }

    if (group.groups?.length) {
      markRedundantGroupTitles(group.groups, fieldsByKey);
    }
  }
}

function buildDetailConfigFromPresentation(
  contract: CompiledEntityContract,
  context: string,
  detail: NonNullable<CompiledViewContext["detail"]>,
  view: CompiledViewContext | undefined,
  routes: Record<string, LocalizedText | string>,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): GeneratedDetailConfig {
  const coreFieldNames = new Set(contract.graphql.fields.map((field) => field.name));
  const allFieldKeys = new Set<string>();
  const renderOverrides: Record<string, GeneratedDetailFieldConfig["render"]> = {};
  const fieldDisplayModes: Record<string, "hidden"> = {};
  collectCompiledGroupFieldKeys(detail.groups.items, allFieldKeys, renderOverrides, fieldDisplayModes);

  for (const field of contract.graphql.fields) {
    if ((detail.header.title ?? "").includes(field.name) || (detail.header.subtitle ?? "").includes(field.name)) {
      allFieldKeys.add(field.name);
    }
  }

  const mapRelationshipConfig = createRelationshipConfigMapper(contract, context, viewDefinitionCache, contractCache);
  const badgeItems = (detail.header.badges?.items ?? []).map((badge) => (
    resolveFieldPath(contract, context, badge) ?? (coreFieldNames.has(badge) ? badge : mapGeneratedDetailFieldKey(contract, context, badge))
  ));
  const defaultGroupId = getDefaultDetailGroupId(detail);
  const queriesByGroup = buildDetailQueriesByGroup(contract, context, detail, defaultGroupId, contractCache);

  const generatedGroups = detail.groups.items.map((group) =>
    mapGeneratedViewGroup(contract, context, group, mapRelationshipConfig),
  );
  const generatedFields = [...allFieldKeys].map((key) =>
    buildDetailFieldConfig(contract, context, key, renderOverrides[key], fieldDisplayModes[key]),
  );
  markRedundantGroupTitles(
    generatedGroups,
    new Map(generatedFields.map((field) => [field.key, field])),
  );

  return {
    queriesByGroup,
    queryName: contract.graphql.queries.single.name,
    realtimeResourceType: contract.graphql.queries.single.name,
    defaultGroupId,
    deleteMutationName: contract.graphql.mutations.delete.name,
    render: detail.render?.component,
    header: {
      titleTemplate: detail.header.title,
      subtitleTemplate: detail.header.subtitle,
      badges: badgeItems.length ? badgeItems : undefined,
    },
    actions: detail.actions,
    routes,
    groups: generatedGroups,
    fields: generatedFields,
    listRoute: routes.list,
    pathnameTemplate: routes.detail,
  };
}

function buildDetailConfig(
  contract: CompiledEntityContract,
  context: string,
  view: CompiledViewContext | undefined,
  routes: Record<string, LocalizedText | string>,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): GeneratedDetailConfig | null {
  const detail = view?.detail;
  if (!detail) return null;

  return buildDetailConfigFromPresentation(contract, context, detail, view, routes, viewDefinitionCache, contractCache);
}

function collectWorkspaceAuxiliarySelectionPaths(
  contract: CompiledEntityContract,
  context: string,
  pane: GeneratedWorkspaceGroupPaneConfig | undefined,
  contractCache?: Map<string, CompiledEntityContract>,
): string[] {
  if (!pane) {
    return [];
  }

  const paths: string[] = [];
  for (const group of pane.groups) {
    for (const path of collectGeneratedGroupSelectionPaths(contract, context, group, contractCache)) {
      appendUnique(paths, path);
    }
  }
  return paths;
}

function buildWorkspaceGroupPane(
  contract: CompiledEntityContract,
  context: string,
  groups: readonly NonNullable<CompiledViewContext["detail"]>["groups"]["items"][number][],
  title: LocalizedText | undefined,
  sizing: GeneratedWorkspacePaneConfig,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): GeneratedWorkspaceGroupPaneConfig {
  const fieldKeys = new Set<string>();
  const renderOverrides: Record<string, GeneratedDetailFieldConfig["render"]> = {};
  const fieldDisplayModes: Record<string, "hidden"> = {};
  collectCompiledGroupFieldKeys(groups, fieldKeys, renderOverrides, fieldDisplayModes);
  const mapRelationshipConfig = createRelationshipConfigMapper(contract, context, viewDefinitionCache, contractCache);

  const generatedGroups = groups.map((group) =>
    mapGeneratedViewGroup(contract, context, group, mapRelationshipConfig),
  );
  const generatedFields = [...fieldKeys].map((key) =>
    buildDetailFieldConfig(contract, context, key, renderOverrides[key], fieldDisplayModes[key]),
  );
  markRedundantGroupTitles(
    generatedGroups,
    new Map(generatedFields.map((field) => [field.key, field])),
  );

  return {
    ...sizing,
    title,
    groups: generatedGroups,
    fields: generatedFields,
  };
}

function buildWorkspaceConfig(
  contract: CompiledEntityContract,
  context: string,
  view: CompiledViewContext | undefined,
  routes: Record<string, LocalizedText | string>,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): GeneratedWorkspaceConfig | null {
  const workspace = view?.workspace;
  if (!workspace) {
    return null;
  }

  const listPresentation = view?.presentations[workspace.slots.list.presentation];
  const detailPresentation = view?.presentations[workspace.slots.body.presentation];
  if (!listPresentation || listPresentation.type !== "list" || !detailPresentation || detailPresentation.type !== "detail") {
    return null;
  }

  const listConfig = buildListConfigFromPresentation(contract, context, listPresentation, view, routes);
  const bodyConfig = buildDetailConfigFromPresentation(contract, context, detailPresentation, view, routes, viewDefinitionCache, contractCache);
  const sidebarPane = workspace.slots.sidebar
    ? buildWorkspaceGroupPane(contract, context, workspace.slots.sidebar.groups, workspace.slots.sidebar.title, workspace.slots.sidebar, viewDefinitionCache, contractCache)
    : undefined;
  const relatedPane = workspace.slots.related
    ? buildWorkspaceGroupPane(contract, context, workspace.slots.related.groups, workspace.slots.related.title, workspace.slots.related, viewDefinitionCache, contractCache)
    : undefined;
  const bodyHeaderPaths = collectDetailHeaderSelectionPaths(contract, context, detailPresentation);
  const relatedPaths = mergeSelectionPaths(
    collectWorkspaceAuxiliarySelectionPaths(contract, context, sidebarPane, contractCache),
    collectWorkspaceAuxiliarySelectionPaths(contract, context, relatedPane, contractCache),
  );
  const queriesByBodyGroup = Object.fromEntries(
    Object.entries(bodyConfig.queriesByGroup).map(([groupId]) => {
      const bodyGroup = detailPresentation.groups.items.find((candidate) => candidate.id === groupId);
      const selection = buildSelectionSet(
        contract,
        context,
        mergeSelectionPaths(
          bodyHeaderPaths,
          bodyGroup ? collectDetailGroupSelectionPaths(contract, context, bodyGroup, contractCache) : [],
          relatedPaths,
        ),
      );
      return [groupId, buildDetailQuery(contract, selection)];
    }),
  );

  return {
    realtimeResourceType: contract.graphql.queries.single.name,
    render: workspace.render?.component,
    title: workspace.title ?? listConfig.title,
    subtitle: workspace.subtitle ?? listConfig.subtitle,
    selectionParam: workspace.selectionParam ?? "id",
    defaultSelectionSource: workspace.defaultSelectionSource ?? "firstRow",
    actions: workspace.actions,
    routes,
    layout: {
      variant: workspace.layout.variant,
    },
    list: {
      defaultWidth: workspace.slots.list.defaultWidth,
      minWidth: workspace.slots.list.minWidth,
      maxWidth: workspace.slots.list.maxWidth,
      weight: workspace.slots.list.weight,
      resizable: workspace.slots.list.resizable,
      config: listConfig,
    },
    body: {
      defaultWidth: workspace.slots.body.defaultWidth,
      minWidth: workspace.slots.body.minWidth,
      maxWidth: workspace.slots.body.maxWidth,
      weight: workspace.slots.body.weight,
      resizable: workspace.slots.body.resizable,
      config: bodyConfig,
    },
    sidebar: sidebarPane,
    related: relatedPane,
    queriesByBodyGroup,
  };
}

function resolveRelationshipTargetPresentation(
  contract: CompiledEntityContract,
  relationship: {
    name: string;
    via?: string;
    view?: string;
  },
  context: string,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
) {
  const resolvedRelationship = resolveRelationshipUsage(contract, relationship, contractCache);
  if (!resolvedRelationship) {
    return undefined;
  }

  const targetContract = contractCache?.get(toEntitySlug(resolvedRelationship.relationship.target));
  if (!targetContract) {
    return undefined;
  }

  const targetViewDefinition = viewDefinitionCache?.get(toEntitySlug(resolvedRelationship.relationship.target))
    ?? [...(viewDefinitionCache?.values() ?? [])]
      .find((candidate) => candidate.entity.toLowerCase() === resolvedRelationship.relationship.target.toLowerCase());
  if (!targetViewDefinition) {
    return undefined;
  }

  const normalized = normalizeMultiContextPresentations(targetViewDefinition.presentations);
  const presentations = normalized[context]
    ?? normalized.core
    ?? normalized[Object.keys(normalized)[0] ?? ""];
  const targetViewContextName = targetContract.views[context]
    ? context
    : targetContract.views.core
      ? "core"
      : Object.keys(targetContract.views)[0] ?? "core";
  const targetViewContext = targetContract.views[targetViewContextName];

  if (!targetViewContext || !presentations) {
    return undefined;
  }

  const requestedView = relationship.view ?? "list";
  const presentation = presentations[requestedView] ?? presentations.list;

  return {
    resolvedRelationship,
    targetContract,
    targetViewDefinition,
    targetViewContextName,
    targetViewContext,
    presentation,
  };
}

function resolveRelationshipPresentationMetadata(
  contract: CompiledEntityContract,
  relationship: {
    name: string;
    via?: string;
    view?: string;
  },
  context: string,
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): {
  presentationType?: "list" | "cards" | "summary" | "listItem";
  titleField?: string;
  subtitleField?: string;
  title?: LocalizedText;
  emptyState?: LocalizedText;
  actions?: NonNullable<CompiledViewContext["list"]>["actions"];
  itemActions?: NonNullable<CompiledViewContext["list"]>["actions"];
  routes?: Record<string, LocalizedText | string>;
} | undefined {
  const resolved = resolveRelationshipTargetPresentation(
    contract,
    relationship,
    context,
    viewDefinitionCache,
    contractCache,
  );
  if (!resolved) return undefined;

  const { targetViewDefinition, presentation } = resolved;
  const resolvedType = presentation?.type;
  const synthesizedItemActions = (() => {
    const itemAction = presentation && "itemAction" in presentation
      ? presentation.itemAction
      : undefined;

    if (itemAction?.type === "open" && itemAction.target === "page") {
      const routeKey = itemAction.view ?? "detail";
      if (targetViewDefinition.routes[routeKey]) {
        return [{
          key: `open-${routeKey}`,
          label: { en: "Open", nl: "Openen" },
          route: routeKey,
        }];
      }
    }

    const rowLink = presentation && "rowLink" in presentation
      ? presentation.rowLink
      : undefined;
    if ((resolvedType === "list" || resolvedType === "listItem") && rowLink && targetViewDefinition.routes.detail) {
      return [{
        key: "open-detail",
        label: { en: "Open", nl: "Openen" },
        route: "detail",
      }];
    }

    return undefined;
  })();

  const actions = presentation && "actions" in presentation
    ? (presentation.actions as NonNullable<CompiledViewContext["list"]>["actions"] | undefined)
    : undefined;
  const isListItem = resolvedType === "listItem";

  return {
    presentationType: resolvedType === "list" || resolvedType === "cards" || resolvedType === "summary" || resolvedType === "listItem"
      ? resolvedType
      : undefined,
    titleField: isListItem && "titleField" in presentation ? presentation.titleField as string | undefined : undefined,
    subtitleField: isListItem && "subtitleField" in presentation ? presentation.subtitleField as string | undefined : undefined,
    title: presentation && "title" in presentation ? presentation.title as LocalizedText | undefined : undefined,
    emptyState: presentation && "emptyState" in presentation ? presentation.emptyState as LocalizedText | undefined : undefined,
    actions: !isListItem && actions?.length ? actions : (resolvedType === "list" || resolvedType === "listItem") && targetViewDefinition.routes.create
      ? [{
          key: "create",
          label: { en: "Create", nl: "Aanmaken" },
          route: "create",
        }]
      : undefined,
    itemActions: isListItem && actions?.length ? actions : synthesizedItemActions,
    routes: targetViewDefinition.routes,
  };
}

function buildListConfigFromPresentation(
  contract: CompiledEntityContract,
  context: string,
  list: NonNullable<CompiledViewContext["list"]>,
  view: CompiledViewContext | undefined,
  routes: Record<string, LocalizedText | string>,
): GeneratedListConfig {
  const profileType = context !== "core" ? contract.graphql.profileTypes[context] : undefined;
  const coreFieldNames = new Set(contract.graphql.fields.map((field) => field.name));
  const selection = buildSelectionSet(
    contract,
    context,
    collectListSelectionPaths(contract, context, list, view?.actionDefinitions, routes),
  );
  const detailRoute = routes.detail ?? `${getCanonicalRoute(routes.list).replace(/\/$/, "")}/:id`;

  return {
    query: buildListQuery(contract, selection),
    queryName: contract.graphql.queries.list.name,
    realtimeResourceType: contract.graphql.queries.single.name,
    title: list.title ?? { en: "List", nl: "Lijst" },
    subtitle: list.subtitle,
    columns: list.columns.map((column) => {
      const columnDef = column as typeof column & { accessor?: string; label?: LocalizedText };
      const key = columnDef.key;
      const coreField = contract.model.fields.find((field) => field.key === key);
      const profileField = profileType?.fields.find((field) => field.name === key);
      const label = columnDef.label ?? coreField?.label ?? profileField?.label ?? { en: key, nl: key };
      const render = profileField?.displayRender ?? coreField?.render ?? profileField?.render;

      return {
        key,
        label,
        sortable: columnDef.sortable,
        accessor: resolveFieldPath(contract, context, columnDef.accessor ?? key) ?? (coreFieldNames.has(key) ? key : key),
        render: render ? { component: render.component } : undefined,
      };
    }),
    filters: list.filterBar?.filters,
    filterField:
      contract.profiles[context]?.filterField ??
      contract.entity.filterField ??
      "displayName",
    searchPlaceholder: list.search?.placeholder ?? { en: "Search...", nl: "Zoeken..." },
    defaultSort: list.defaultSort
      ? {
          key: coreFieldNames.has(list.defaultSort.key) ? list.defaultSort.key : "displayName",
          direction: list.defaultSort.direction,
        }
      : undefined,
    actions: list.actions?.length ? list.actions : routes.create
      ? [{
          key: "create",
          label: { en: "Create", nl: "Aanmaken" },
          route: "create",
        }]
      : undefined,
    actionDefinitions: view?.actionDefinitions,
    rowActions: list.rowActions,
    routes,
    deleteMutationName: contract.graphql.mutations.delete.name,
    rowLink: list.rowLink ?? detailRoute,
  };
}

function buildListConfig(
  contract: CompiledEntityContract,
  context: string,
  view: CompiledViewContext | undefined,
  routes: Record<string, LocalizedText | string>
): GeneratedListConfig | null {
  const list = view?.list;
  if (!list) return null;

  return buildListConfigFromPresentation(contract, context, list, view, routes);
}

function buildFormConfig(
  contract: CompiledEntityContract,
  context: string,
  view: CompiledViewContext | undefined,
  routes: Record<string, LocalizedText | string>,
  route: string,
  mode: "create" | "edit",
  viewDefinitionCache?: Map<string, ViewDefinition>,
  contractCache?: Map<string, CompiledEntityContract>,
): GeneratedFormConfig | null {
  const formView = view?.form;
  if (!formView) return null;

  const createVariant = formView.variants.create;
  const editVariant = formView.variants.edit;
  const variant = mode === "edit" ? (editVariant ?? createVariant) : createVariant;
  if (!variant) return null;

  const groups = resolveFormGroups(variant, createVariant);
  const fieldOverrides = variant.fieldOverrides ?? {};
  function collectFormFieldKeys(group: NonNullable<typeof groups>[number], keys: Set<string>) {
    for (const field of group.fields ?? []) {
      keys.add(typeof field === "string" ? field : field.key);
    }
    for (const child of group.groups ?? []) {
      collectFormFieldKeys(child, keys);
    }
  }
  const fieldKeySet = new Set<string>();
  for (const group of groups) {
    collectFormFieldKeys(group, fieldKeySet);
  }
  const fieldKeys = [...fieldKeySet];
  const fields = fieldKeys
    .map((key) => buildFormFieldConfig(contract, context, key, fieldOverrides[key] ?? {}))
    .filter(Boolean) as GeneratedFormFieldConfig[];
  const currentRouteMap = mode === "edit" ? routes.edit : routes.create;

  function mapRelationshipConfig(relationship: {
    name: string;
    via?: string;
    view?: string;
    overrides?: RelationshipOverrides;
  }) {
    const metadata = resolveRelationshipPresentationMetadata(
      contract,
      relationship,
      context,
      viewDefinitionCache,
      contractCache,
    );
    const selectionPath = resolveRelationshipSelectionPath(contract, relationship, contractCache) ?? relationship.name;

    return {
      name: selectionPath,
      view: relationship.view,
      overrides: relationship.overrides,
      presentationType: metadata?.presentationType,
      title: relationship.overrides?.title ?? metadata?.title,
      emptyState: relationship.overrides?.emptyState ?? metadata?.emptyState,
      actions: metadata?.actions,
      routes: metadata?.routes,
    };
  }

  return {
    mode,
    title: variant.title,
    submitLabel: variant.submit?.label ?? (
      mode === "edit"
        ? { en: "Save", nl: "Opslaan" }
        : { en: "Create", nl: "Aanmaken" }
    ),
    successRoute: getMatchingRoute(route, currentRouteMap, routes.detail),
    actions: formView.actions,
    routes,
    groups: groups.map((group) => mapGeneratedFormGroup(group, mapRelationshipConfig)),
    fields,
    // WEB-020 — Copy form-level variable sources through to the generated
    // config so the renderer can resolve them at form mount.
    variableSources: formView.variableSources,
  };
}

function resolveRelationshipUsage(
  contract: CompiledEntityContract,
  relationship: {
    name: string;
    via?: string;
  },
  contractCache?: Map<string, CompiledEntityContract>,
): {
  relationship: CompiledEntityContract["model"]["relationships"][number];
  selectionPath: string;
} | null {
  let currentContract: CompiledEntityContract | undefined = contract;
  const selectionSegments: string[] = [];
  type ModelRelationship = CompiledEntityContract["model"]["relationships"][number];

  for (const viaSegment of splitRelationshipPath(relationship.via)) {
    const viaRelationship: ModelRelationship | undefined = currentContract?.model.relationships.find(
      (candidate) => candidate.key === viaSegment,
    );
    if (!viaRelationship || viaRelationship.kind !== "belongsTo") {
      return null;
    }

    selectionSegments.push(viaSegment);
    currentContract = contractCache?.get(toEntitySlug(viaRelationship.target));
    if (!currentContract) {
      return null;
    }
  }

  const terminalRelationship = currentContract.model.relationships.find((candidate) => candidate.key === relationship.name);
  if (!terminalRelationship) {
    return null;
  }

  selectionSegments.push(relationship.name);
  return {
    relationship: terminalRelationship,
    selectionPath: selectionSegments.join("."),
  };
}

function resolveRelationshipSelectionPath(
  contract: CompiledEntityContract,
  relationship: {
    name: string;
    via?: string;
  },
  contractCache?: Map<string, CompiledEntityContract>,
): string | null {
  return resolveRelationshipUsage(contract, relationship, contractCache)?.selectionPath ?? null;
}

function splitRelationshipPath(path: string | undefined): string[] {
  return path?.split(".").map((segment) => segment.trim()).filter(Boolean) ?? [];
}

function toEntitySlug(entityName: string): string {
  return entityName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function normalizeText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const localized = value as { en?: string; nl?: string };
    return localized.nl ?? localized.en;
  }
  return undefined;
}

function normalizeRoles(roles: string[]) {
  return [...new Set(roles.map(normalizeKeycloakRoleName))].sort();
}

function waitConditionOptions(field: CompiledField): RuntimeWaitConditionFieldData["options"] {
  const resolved = resolveFieldOptionsForClient(field.options as FieldOptions | undefined) as
    | { items?: Array<{ value: string; label?: LocalizedText }> }
    | undefined;
  const items = resolved?.items;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  return items.map((item) => ({
    value: item.value,
    label: normalizeText(item.label) ?? item.value,
  }));
}

function waitConditionInputKind(
  field: CompiledField,
  options: RuntimeWaitConditionFieldData["options"],
): RuntimeWaitConditionFieldData["inputKind"] {
  if (options && options.length > 0) return "select";
  if (field.valueType === "boolean") return "boolean";
  if (field.valueType === "integer" || field.valueType === "number") return "number";
  return "text";
}

function buildWaitConditionFields(contract: CompiledEntityContract): RuntimeWaitConditionFieldData[] {
  return contract.model.fields
    .filter((field) =>
      Boolean(field)
      && typeof field.key === "string"
      && field.key.trim().length > 0
      && field.cardinality !== "collection"
      && WAIT_CONDITION_VALUE_TYPES.has(field.valueType),
    )
    .map((field) => {
      const options = waitConditionOptions(field);
      return {
        key: field.key,
        label: normalizeText(field.label) ?? field.key,
        ...(field.description ? { description: normalizeText(field.description) } : {}),
        fieldType: field.valueType,
        inputKind: waitConditionInputKind(field, options),
        ...(options ? { options } : {}),
      };
    });
}

export function buildRuntimeMetadataEntry(
  contract: CompiledEntityContract,
): RuntimeMetadataEntryData {
  return {
    entityName: contract.entity.name,
    entitySlug: contract.authorization.entitySlug,
    authorization: {
      slug: contract.authorization.entitySlug,
      entity: contract.entity.name,
      required: {
        read: normalizeRoles(contract.authorization.roles.read),
        create: normalizeRoles(contract.authorization.roles.create),
        update: normalizeRoles(contract.authorization.roles.update),
        delete: normalizeRoles(contract.authorization.roles.delete),
      },
    },
    waitConditionFields: buildWaitConditionFields(contract),
  };
}

function mapGeneratedFormGroup(
  group: NonNullable<CompiledViewContext["form"]>["variants"][string]["groups"][number],
  mapRelationshipConfig?: (relationship: {
    name: string;
    via?: string;
    view?: string;
    overrides?: RelationshipOverrides;
  }) => GeneratedGroupConfig["relationship"],
): GeneratedGroupConfig {
  return {
    id: group.id,
    title: group.title ?? group.label,
    label: group.label,
    render: group.render?.component,
    fields: group.fields?.map((field) => typeof field === "string" ? field : field.key),
    relationships: group.relationships?.map((relationship) => mapRelationshipConfig?.(relationship) ?? {
      name: relationship.name,
      view: relationship.view,
      overrides: relationship.overrides,
    }),
    relationship: group.relationship
      ? (mapRelationshipConfig?.(group.relationship) ?? {
          name: group.relationship.name,
          view: group.relationship.view,
          overrides: group.relationship.overrides,
        })
      : undefined,
    groups: group.groups?.map((child) => mapGeneratedFormGroup(child, mapRelationshipConfig)),
    timeline: group.timeline,
  };
}

function resolveFormGroups(
  variant: { groups?: NonNullable<CompiledViewContext["form"]>["variants"][string]["groups"]; extends?: string },
  createVariant: { groups?: NonNullable<CompiledViewContext["form"]>["variants"][string]["groups"] } | undefined
): NonNullable<CompiledViewContext["form"]>["variants"][string]["groups"] {
  if (variant.groups && variant.groups.length > 0) {
    return variant.groups;
  }

  if (variant.extends === "create" && createVariant?.groups) {
    return createVariant.groups;
  }

  return createVariant?.groups ?? [];
}

function buildFormFieldConfig(
  contract: CompiledEntityContract,
  context: string,
  key: string,
  overrides: Record<string, unknown>
): GeneratedFormFieldConfig | null {
  const coreField = contract.model.fields.find((field) => field.key === key);
  const profileType = context !== "core" ? contract.graphql.profileTypes[context] : undefined;
  const profileField = !coreField ? profileType?.fields.find((field) => field.name === key) : undefined;

  if (!coreField && !profileField) {
    return {
      key,
      dataPath: key,
      valueType: "string",
      cardinality: "single",
      label: { en: key, nl: key },
      required: false,
      render: { component: "Input" },
    };
  }

  const baseConfig = coreField
    ? buildCoreFieldConfig(coreField)
    : buildProfileFieldConfig(profileField!, profileType);
  const overrideConfig = normalizeFieldOverrides(overrides);

  const merged: GeneratedFormFieldConfig = {
    ...baseConfig,
    ...overrideConfig,
    render: {
      ...baseConfig.render,
      ...(typeof overrides.render === "object" && overrides.render
        ? overrides.render as Record<string, unknown>
        : {}),
    },
  };
  merged.options = resolveFieldOptionsForClient(merged.options as FieldOptions | undefined);
  return merged;
}

function buildDetailFieldConfigFromCompiledField(
  field: CompiledField,
  renderOverride?: GeneratedDetailFieldConfig["render"],
): GeneratedDetailFieldConfig {
  return {
    key: field.key,
    label: field.label,
    valueType: field.valueType,
    cardinality: field.cardinality,
    semanticType: field.semanticType,
    layoutFraction: field.layoutFraction,
    render: renderOverride ?? field.render,
    validation: field.validation as Record<string, unknown> | undefined,
    options: resolveFieldOptionsForClient(field.options),
    suggestions: field.suggestions,
    children: field.children?.map((child) =>
      buildDetailFieldConfigFromCompiledField(child),
    ),
    item: field.item ? buildDetailFieldConfigFromCompiledField(field.item) : undefined,
  };
}

function buildDetailFieldConfig(
  contract: CompiledEntityContract,
  context: string,
  key: string,
  renderOverride?: GeneratedDetailFieldConfig["render"],
  fieldDisplayMode?: "hidden",
): GeneratedDetailFieldConfig {
  const profileType = context !== "core" ? contract.graphql.profileTypes[context] : undefined;
  const normalizedKey = resolveFieldPath(contract, context, key) ?? key;
  const profilePrefix = profileType ? `${profileType.fieldName}.` : "";
  const profileFieldKey = profilePrefix && normalizedKey.startsWith(profilePrefix)
    ? normalizedKey.slice(profilePrefix.length)
    : normalizedKey;
  const coreField = contract.model.fields.find((field) => field.key === normalizedKey);
  const profileField = !coreField ? profileType?.fields.find((field) => field.name === profileFieldKey) : undefined;

  const attachDisplayMode = (row: GeneratedDetailFieldConfig): GeneratedDetailFieldConfig =>
    fieldDisplayMode === "hidden" ? { ...row, fieldDisplayMode: "hidden" } : row;

  if (coreField) {
    return attachDisplayMode(buildDetailFieldConfigFromCompiledField(coreField, renderOverride));
  }

  if (profileField) {
    return attachDisplayMode({
      key: normalizedKey,
      label: profileField.label ?? { en: profileFieldKey, nl: profileFieldKey },
      valueType: graphQlFieldTypeToFormValueType(profileField.type),
      cardinality: graphQlFieldTypeIsCollection(profileField.type) ? "collection" : "single",
      render: renderOverride ?? profileField.render ?? { component: "TextDisplay" },
      validation: profileField.validation as Record<string, unknown> | undefined,
      options: resolveFieldOptionsForClient(profileField.options),
    });
  }

  return attachDisplayMode({
    key: normalizedKey,
    label: { en: normalizedKey, nl: normalizedKey },
    valueType: "string",
    cardinality: "single",
    render: renderOverride ?? { component: "TextDisplay" },
  });
}

function buildCoreFieldConfig(field: CompiledField): GeneratedFormFieldConfig {
  return {
    key: field.key,
    dataPath: field.key,
    valueType: field.valueType,
    cardinality: field.cardinality,
    variables: field.variables,
    sortable: field.sortable,
    semanticType: field.semanticType,
    label: field.label,
    description: field.description,
    help: field.help,
    required: field.required,
    readOnly: field.readOnly,
    defaultValue: field.defaultValue,
    layoutFraction: field.layoutFraction,
    render: field.render,
    visibility: field.visibility,
    validation: field.validation as Record<string, unknown> | undefined,
    options: resolveFieldOptionsForClient(field.options),
    suggestions: field.suggestions,
    children: field.children?.map(buildCoreFieldConfig),
    item: field.item ? buildCoreFieldConfig(field.item) : undefined,
  };
}

function buildProfileFieldConfig(
  field: GraphQLProfileType["fields"][number],
  profileType: GraphQLProfileType | undefined
): GeneratedFormFieldConfig {
  return {
    key: field.name,
    dataPath: `${profileType?.fieldName ?? "profile"}.${field.name}`,
    valueType: graphQlFieldTypeToFormValueType(field.type),
    cardinality: graphQlFieldTypeIsCollection(field.type) ? "collection" : "single",
    label: field.label ?? { en: field.name, nl: field.name },
    required: field.type.endsWith("!"),
    render: field.render ?? { component: "Input" },
    validation: field.validation as Record<string, unknown> | undefined,
    options: resolveFieldOptionsForClient(field.options),
  };
}

function graphQlFieldTypeToFormValueType(type: string): GeneratedFormFieldConfig["valueType"] {
  const normalizedType = type.replace(/!/g, "");
  const map: Record<string, string> = {
    ID: "string",
    String: "string",
    Int: "integer",
    Float: "number",
    Boolean: "boolean",
    JSON: "object",
  };

  return (map[normalizedType.replace(/^\[|\]$/g, "")] ?? "string") as GeneratedFormFieldConfig["valueType"];
}

function graphQlFieldTypeIsCollection(type: string): boolean {
  return type.replace(/!/g, "").startsWith("[");
}

function normalizeFieldOverrides(overrides: Record<string, unknown>): Partial<GeneratedFormFieldConfig> {
  const normalized: Partial<GeneratedFormFieldConfig> = {};

  if ("label" in overrides) normalized.label = overrides.label as LocalizedText;
  if ("description" in overrides) normalized.description = overrides.description as LocalizedText;
  if ("help" in overrides) normalized.help = overrides.help as LocalizedText;
  if ("required" in overrides) normalized.required = Boolean(overrides.required);
  if ("readOnly" in overrides) normalized.readOnly = Boolean(overrides.readOnly);
  if ("defaultValue" in overrides) normalized.defaultValue = overrides.defaultValue;
  if ("validation" in overrides) normalized.validation = overrides.validation as Record<string, unknown>;
  if ("options" in overrides) normalized.options = overrides.options as Record<string, unknown>;
  if ("valueType" in overrides && typeof overrides.valueType === "string") {
    normalized.valueType = overrides.valueType as GeneratedFormFieldConfig["valueType"];
  }
  if ("cardinality" in overrides && typeof overrides.cardinality === "string") {
    normalized.cardinality = overrides.cardinality as GeneratedFormFieldConfig["cardinality"];
  }
  if ("semanticType" in overrides && typeof overrides.semanticType === "string") {
    normalized.semanticType = overrides.semanticType;
  }
  if ("dataPath" in overrides && typeof overrides.dataPath === "string") normalized.dataPath = overrides.dataPath;
  if ("visibility" in overrides && typeof overrides.visibility === "object") {
    normalized.visibility = overrides.visibility as CompiledField["visibility"];
  }

  return normalized;
}

function collectDetailSelectionPaths(
  contract: CompiledEntityContract,
  context: string,
  detail: NonNullable<CompiledViewContext["detail"]>,
  contractCache?: Map<string, CompiledEntityContract>,
): string[] {
  const paths = collectDetailHeaderSelectionPaths(contract, context, detail);

  for (const group of detail.groups.items) {
    for (const path of collectDetailGroupSelectionPaths(contract, context, group, contractCache)) {
      appendUnique(paths, path);
    }
  }

  return paths;
}

function collectDetailHeaderSelectionPaths(
  contract: CompiledEntityContract,
  context: string,
  detail: NonNullable<CompiledViewContext["detail"]>
): string[] {
  const paths: string[] = ["id"];

  appendTemplatePaths(paths, detail.header.title);
  appendTemplatePaths(paths, detail.header.subtitle);

  for (const badge of detail.header.badges?.items ?? []) {
    appendUnique(paths, resolveFieldPath(contract, context, badge));
  }

  return paths;
}

function collectDetailGroupSelectionPaths(
  contract: CompiledEntityContract,
  context: string,
  group: NonNullable<CompiledViewContext["detail"]>["groups"]["items"][number],
  contractCache?: Map<string, CompiledEntityContract>,
): string[] {
  const paths: string[] = [];

  if (group.relationship?.name) {
    appendUnique(paths, resolveRelationshipSelectionPath(contract, group.relationship, contractCache));
    for (const columnPath of resolveRelationshipListFieldPaths(contract, group.relationship, contractCache)) {
      appendUnique(paths, columnPath);
    }
  }

  for (const field of group.fields ?? []) {
    const key = typeof field === "string" ? field : field.key;
    appendUnique(paths, resolveFieldPath(contract, context, key));
  }

  for (const relationship of group.relationships ?? []) {
    appendUnique(paths, resolveRelationshipSelectionPath(contract, relationship, contractCache));
    for (const columnPath of resolveRelationshipListFieldPaths(contract, relationship, contractCache)) {
      appendUnique(paths, columnPath);
    }
  }

  for (const child of group.groups ?? []) {
    for (const path of collectDetailGroupSelectionPaths(contract, context, child, contractCache)) {
      appendUnique(paths, path);
    }
  }

  return paths;
}

/**
 * Resolve the list-presentation column field paths for an embedded relationship
 * usage. Used to expand a `relationship: "comments"` group into a GraphQL
 * selection that actually returns the columns the embedded list will render
 * (body, source, …), not just `{ id }`.
 *
 * Resolution order for which columns to include:
 *   1. `overrides.columns` if specified on the relationship usage
 *   2. The target entity's core `list` presentation columns
 *   3. Fallback: just `id`
 *
 * Returns an empty array if the target contract is not available — the caller's
 * existing fallback (`buildSelectionSet` hard-codes `{ id }` for empty
 * relationship selections) keeps generation safe in that case.
 */
function resolveRelationshipListFieldPaths(
  contract: CompiledEntityContract,
  relationship: {
    name: string;
    via?: string;
    view?: string;
    overrides?: { columns?: Array<string | { key: string }> };
  },
  contractCache?: Map<string, CompiledEntityContract>,
): string[] {
  const usage = resolveRelationshipUsage(contract, relationship, contractCache);
  if (!usage) {
    return [];
  }

  const targetContract = contractCache?.get(toEntitySlug(usage.relationship.target));
  if (!targetContract) {
    return [];
  }

  // Profile-only entities have no `core` view context — pick
  // the first available context so we can still resolve presentations.
  const targetViewContext = targetContract.views["core"]
    ?? Object.values(targetContract.views).find((ctx): ctx is CompiledViewContext => Boolean(ctx));
  if (!targetViewContext) {
    return [];
  }
  const targetViewContextName = targetContract.views["core"]
    ? "core"
    : Object.keys(targetContract.views)[0] ?? "core";

  const overrideColumns = relationship.overrides?.columns;
  let columnKeys: string[] = [];
  if (overrideColumns && overrideColumns.length > 0) {
    columnKeys = overrideColumns.map((col) => (typeof col === "string" ? col : col.key));
  } else if (relationship.view && targetViewContext.presentations[relationship.view]) {
    // Honour the embedded `view:` named on the relationship usage so that a
    // tab declaring `view: summary` actually fetches the summary presentation's
    // fields (and not just `{ id }`). Falls through to the list columns below
    // when the named presentation has no fields/columns we can pull.
    columnKeys = extractFieldKeysFromPresentation(targetViewContext.presentations[relationship.view]);
  }

  if (columnKeys.length === 0 && targetViewContext.list?.columns) {
    columnKeys = targetViewContext.list.columns.map((col) => {
      const def = col as typeof col & { accessor?: string };
      return def.accessor ?? def.key;
    });
  }

  // Always include id so the row has a stable key
  const orderedKeys = ["id", ...columnKeys.filter((key) => key !== "id")];

  const paths: string[] = [];
  const relationshipKeys = new Set(targetContract.model.relationships.map((rel) => rel.key));

  for (const key of orderedKeys) {
    if (relationshipKeys.has(key)) {
      // Column references a belongsTo relationship — expand to id + display field
      // of the nested target so the embedded list can show a human-readable label.
      for (const nested of expandRelationshipColumnPaths(targetContract, key, contractCache)) {
        appendUnique(paths, `${usage.selectionPath}.${nested}`);
      }
      continue;
    }

    const resolved = resolveFieldPath(targetContract, targetViewContextName, key);
    if (resolved) {
      appendUnique(paths, `${usage.selectionPath}.${resolved}`);
    }
  }
  return paths;
}

/**
 * Pulls the column/field keys out of any embedded presentation (list/listItem/
 * summary/cards). Used so a relationship usage that declares `view: summary` (or any
 * other named embedded presentation) drives the parent's GraphQL selection,
 * not just the target entity's default `list` columns.
 */
function extractFieldKeysFromPresentation(presentation: CompiledNamedPresentation): string[] {
  if (presentation.type === "list") {
    return presentation.columns.map((col) => {
      const def = col as typeof col & { accessor?: string };
      return def.accessor ?? def.key;
    });
  }

  if (presentation.type === "listItem") {
    const fields = [
      presentation.titleField,
      presentation.subtitleField,
      ...((presentation.fields ?? []).map((entry) => (typeof entry === "string" ? entry : entry.key))),
    ].filter((key): key is string => Boolean(key));
    return [...new Set(fields)];
  }

  if (presentation.type === "summary" || presentation.type === "cards") {
    const fields = presentation.fields ?? [];
    return fields.map((entry) => (typeof entry === "string" ? entry : entry.key));
  }

  return [];
}

const RELATIONSHIP_DISPLAY_FIELD_CANDIDATES = ["displayName", "name", "title", "code", "subject"];

/**
 * Expand a list column that points to a `belongsTo` relationship into the paths
 * needed to render a human-readable label: `<key>.id` plus the first available
 * display-field on the target (displayName, name, title, code, subject).
 *
 * Used for embedded hasMany lists where the parent entity's list-presentation
 * names a relationship (e.g. Comment.author → Relation.displayName).
 */
function expandRelationshipColumnPaths(
  parentContract: CompiledEntityContract,
  relationshipKey: string,
  contractCache?: Map<string, CompiledEntityContract>,
): string[] {
  const rel = parentContract.model.relationships.find((candidate) => candidate.key === relationshipKey);
  if (!rel) {
    return [`${relationshipKey}.id`];
  }

  const targetContract = contractCache?.get(toEntitySlug(rel.target));
  if (!targetContract) {
    return [`${relationshipKey}.id`];
  }

  const targetFieldKeys = new Set(targetContract.model.fields.map((field) => field.key));
  const paths = [`${relationshipKey}.id`];

  for (const candidate of RELATIONSHIP_DISPLAY_FIELD_CANDIDATES) {
    if (targetFieldKeys.has(candidate)) {
      paths.push(`${relationshipKey}.${candidate}`);
      break;
    }
  }

  return paths;
}

function collectGeneratedGroupSelectionPaths(
  contract: CompiledEntityContract,
  context: string,
  group: GeneratedGroupConfig,
  contractCache?: Map<string, CompiledEntityContract>,
): string[] {
  const paths: string[] = [];

  if (group.relationship?.name) {
    appendUnique(paths, group.relationship.name);
  }

  for (const field of group.fields ?? []) {
    appendUnique(paths, resolveFieldPath(contract, context, field) ?? field);
  }

  for (const relationship of group.relationships ?? []) {
    appendUnique(paths, relationship.name);
  }

  for (const child of group.groups ?? []) {
    for (const path of collectGeneratedGroupSelectionPaths(contract, context, child, contractCache)) {
      appendUnique(paths, path);
    }
  }

  return paths;
}

function collectListSelectionPaths(
  contract: CompiledEntityContract,
  context: string,
  list: NonNullable<CompiledViewContext["list"]>,
  actionDefinitions?: Record<string, CompiledViewActionDefinition>,
  routes?: Record<string, LocalizedText | string>,
): string[] {
  const paths: string[] = ["id"];
  const rowLink = list.rowLink;

  for (const column of list.columns) {
    const columnDef = column as typeof column & { accessor?: string };
    appendUnique(paths, resolveFieldPath(contract, context, columnDef.accessor ?? columnDef.key));
  }

  if (rowLink) {
    appendRoutePlaceholderPaths(paths, contract, context, rowLink);
  }

  for (const rowAction of list.rowActions ?? []) {
    const definition = actionDefinitions?.[rowAction.actionRef];
    if (!definition) {
      continue;
    }

    const routeTemplate = resolveActionRouteTemplate(definition.route, routes);
    if (routeTemplate) {
      appendRoutePlaceholderPaths(paths, contract, context, routeTemplate);
    }

    appendPayloadPaths(paths, rowAction.payload);
    appendPayloadPaths(paths, definition.payload);
    appendVisibilityPaths(paths, contract, context, rowAction.visibleWhen);
    appendVisibilityPaths(paths, contract, context, rowAction.disabledWhen);
  }

  return paths;
}

function buildDetailQuery(contract: CompiledEntityContract, selection: string): string {
  return `query ($id: ID!) { ${contract.graphql.queries.single.name}(id: $id) { ${selection} } }`;
}

function buildListQuery(contract: CompiledEntityContract, selection: string): string {
  return `query ($filter: ${contract.graphql.typeName}Filter, $sort: ${contract.graphql.typeName}Sort, $first: Int, $after: String) { ${contract.graphql.queries.list.name}(filter: $filter, sort: $sort, first: $first, after: $after) { edges { node { ${selection} } cursor } pageInfo { hasNextPage endCursor } totalCount } }`;
}

function getDefaultDetailGroupId(detail: NonNullable<CompiledViewContext["detail"]>): string {
  return detail.groups.items[0]?.id ?? "overview";
}

function buildDetailQueriesByGroup(
  contract: CompiledEntityContract,
  context: string,
  detail: NonNullable<CompiledViewContext["detail"]>,
  defaultGroupId: string,
  contractCache?: Map<string, CompiledEntityContract>,
): Record<string, string> {
  const queriesByGroup: Record<string, string> = {};
  const headerPaths = collectDetailHeaderSelectionPaths(contract, context, detail);

  if (detail.groups.items.length === 0) {
    const selection = buildSelectionSet(contract, context, headerPaths);
    queriesByGroup[defaultGroupId] = buildDetailQuery(contract, selection);
    return queriesByGroup;
  }

  for (const group of detail.groups.items) {
    const selection = buildSelectionSet(
      contract,
      context,
      mergeSelectionPaths(headerPaths, collectDetailGroupSelectionPaths(contract, context, group, contractCache))
    );
    queriesByGroup[group.id] = buildDetailQuery(contract, selection);
  }

  return queriesByGroup;
}

function buildSelectionSet(
  contract: CompiledEntityContract,
  context: string,
  fieldPaths: string[]
): string {
  const tree = new Map<string, Map<any, any>>();
  const relationshipFieldNames = new Set(contract.graphql.relationships.map((r) => r.name));
  const labelsFieldNames = new Set(
    contract.graphql.fields
      .filter((f) => f.computedResolver === "labels")
      .map((f) => f.name),
  );

  for (const fieldPath of fieldPaths) {
    const resolved = resolveFieldPath(contract, context, fieldPath);
    if (!resolved) continue;

    const parts = resolved.split(".").filter(Boolean);
    if (parts.length === 0) continue;

    let current = tree;
    for (const part of parts) {
      const next = current.get(part) ?? new Map<string, Map<any, any>>();
      current.set(part, next);
      current = next;
    }
  }

  // Relationship fields are object types in GraphQL and require at least { id }
  for (const [field, children] of tree) {
    if (children.size === 0 && relationshipFieldNames.has(field)) {
      children.set("id", new Map<string, Map<any, any>>());
    }
  }

  // Computed `labels` fields resolve to the LabelValues object type — the
  // query must select at least one of its subfields. `asMap` is the flat
  // key→value map the list/detail renderers consume.
  for (const [field, children] of tree) {
    if (children.size === 0 && labelsFieldNames.has(field)) {
      children.set("asMap", new Map<string, Map<any, any>>());
    }
  }

  // Include aggregate counts for collection relationships (hasMany / manyToMany)
  for (const rel of contract.graphql.relationships) {
    if (rel.type.startsWith("[")) {
      const aggName = `${rel.name}Aggregate`;
      if (!tree.has(aggName)) {
        const countMap = new Map<string, Map<any, any>>();
        countMap.set("count", new Map<string, Map<any, any>>());
        tree.set(aggName, countMap);
      }
    }
  }

  return renderSelectionTree(tree);
}

function renderSelectionTree(tree: Map<string, Map<any, any>>): string {
  return [...tree.entries()]
    .map(([field, children]) => {
      // Defense-in-depth: every selection token is a validated authoring field
      // key, relationship name, or a compiler-fixed subfield (id/asMap/count/
      // *Aggregate). Assert the GraphQL-safe shape before it is interpolated
      // raw into the operation string built by buildDetailQuery/buildListQuery —
      // a regression must fail the build, not emit a token that restructures the
      // selection set.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
        throw new Error(`pages: unsafe GraphQL selection field ${JSON.stringify(field)}`);
      }
      return children.size > 0
        ? `${field} { ${renderSelectionTree(children)} }`
        : field;
    })
    .join(" ");
}

function resolveFieldPath(
  contract: CompiledEntityContract,
  context: string,
  rawPath: string | undefined
): string | null {
  if (!rawPath) return null;

  const path = rawPath.trim();
  if (!path) return null;

  const coreFieldNames = new Set(contract.graphql.fields.map((field) => field.name));
  const relationshipNames = new Set(contract.graphql.relationships.map((relationship) => relationship.name));
  const profileType = context !== "core" ? contract.graphql.profileTypes[context] : undefined;
  const profileFieldNames = new Set(profileType?.fields.map((field) => field.name) ?? []);
  const parts = path.split(".").filter(Boolean);

  if (parts.length === 0) return null;
  if (parts.length === 1) {
    if (coreFieldNames.has(parts[0])) return parts[0];
    if (relationshipNames.has(parts[0])) return parts[0];
    if (profileType && profileFieldNames.has(parts[0])) return `${profileType.fieldName}.${parts[0]}`;
    return null;
  }

  if (profileType && parts[0] === profileType.fieldName) {
    return parts.join(".");
  }

  if (relationshipNames.has(parts[0])) {
    return parts.join(".");
  }

  if (coreFieldNames.has(parts[0])) {
    return parts.join(".");
  }

  if (profileType && profileFieldNames.has(parts[0])) {
    return `${profileType.fieldName}.${parts.join(".")}`;
  }

  return null;
}

function appendTemplatePaths(paths: string[], template?: string): void {
  if (!template) return;

  for (const match of template.matchAll(/\{\{(.+?)\}\}/g)) {
    const expression = match[1];
    for (const candidate of expression.split("||").map((part) => part.trim()).filter(Boolean)) {
      appendUnique(paths, candidate);
    }
  }
}

function appendPayloadPaths(
  paths: string[],
  payload?: Record<string, string | number | boolean>,
): void {
  if (!payload) {
    return;
  }

  for (const value of Object.values(payload)) {
    if (typeof value === "string") {
      appendTemplatePaths(paths, value);
    }
  }
}

function appendVisibilityPaths(
  paths: string[],
  contract: CompiledEntityContract,
  context: string,
  visibility?: { conditions?: Array<{ field: string }> },
): void {
  for (const condition of visibility?.conditions ?? []) {
    appendUnique(paths, resolveFieldPath(contract, context, condition.field));
  }
}

function appendRoutePlaceholderPaths(
  paths: string[],
  contract: CompiledEntityContract,
  context: string,
  route: LocalizedText | string
): void {
  const routeValues = typeof route === "string" ? [route] : Object.values(route);

  for (const routeValue of routeValues) {
    if (!routeValue) continue;

    for (const match of routeValue.matchAll(/:([A-Za-z0-9_.]+)/g)) {
      appendUnique(paths, resolveFieldPath(contract, context, match[1]));
    }
  }
}

function resolveActionRouteTemplate(
  routeKey: string | undefined,
  routes: Record<string, LocalizedText | string> | undefined,
): LocalizedText | string | undefined {
  if (!routeKey) {
    return undefined;
  }

  if (routes?.[routeKey]) {
    return routes[routeKey];
  }

  return routeKey;
}

function appendUnique(values: string[], candidate: string | null | undefined): void {
  if (!candidate || values.includes(candidate)) return;
  values.push(candidate);
}

function mergeSelectionPaths(...groups: string[][]): string[] {
  const merged: string[] = [];

  for (const group of groups) {
    for (const candidate of group) {
      appendUnique(merged, candidate);
    }
  }

  return merged;
}
