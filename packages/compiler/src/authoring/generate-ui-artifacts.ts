// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import YAML from "yaml";
import {
  discoverContextEntities,
  listEntityFiles,
  loadContextEntity,
  loadEntity,
} from "./loader.js";
import { compile } from "./compiler/index.js";
import { generateDynamicRoutes, generateLayout, generateViewPages } from "./generators/app.js";
import { buildRuntimeMetadataEntry } from "./generators/pages.js";
import type { EntityPageConfigBundle } from "./generators/app.js";
import { normalizeKeycloakRoleName } from "./generators/keycloak.js";
import type { EntityManifestEntryData } from "./generators/app.js";
import type { RuntimeMetadataData } from "./generators/manifest.js";
import type { ViewDefinition } from "./types.js";
import { generatePersistedOperationArtifacts } from "../persisted-operations.js";

export type AuthoringUiArtifact = {
  path: string;
  contents: string;
};

type CompiledAuthoringEntity = {
  name: string;
  contract: ReturnType<typeof compile>;
  appShell?: unknown;
  routes?: ViewDefinition["routes"] | undefined;
};

// Workflow artifact prefixes (api/workflow/, workflow/contract/,
// workflow/generated/, features/**) moved with the workflow generators to the
// example workflow plugin (examples/plugins/workflow), which maps them itself.
const generatedArtifactPathMappings = [
  { oldPrefix: "actions/generated/", servicePrefix: "apps/web/src/actions/generated/" },
  { oldPrefix: "app/", servicePrefix: "apps/web/src/app/" },
  { oldPrefix: "compiler/", servicePrefix: "apps/web/src/compiler/" },
  // Catalog seed for platform.entity_page_configs. It lands API-side because
  // apps/api owns that table and seeds it during `db:migrate`; the web app
  // never reads the file, it queries the catalog over GraphQL. Still emitted
  // from the web-gated UI generator, since page configs only exist when there
  // are pages to configure.
  {
    oldPrefix: "page-configs/",
    servicePrefix: "apps/api/src/generated/page-configs/",
  },
  { oldPrefix: "generated/web/", servicePrefix: "apps/web/src/generated/" },
];

async function listYamlStems(dir: string, suffix = ".yaml"): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(suffix) && !entry.name.startsWith("_"),
    )
    .map((entry) => entry.name.slice(0, -suffix.length))
    .sort();
}

async function loadViewDefinitions(authoringDir: string): Promise<Map<string, ViewDefinition>> {
  const viewsDir = join(authoringDir, "views");
  const viewNames = await listYamlStems(viewsDir, ".view.yaml");
  const views = new Map<string, ViewDefinition>();

  for (const viewName of viewNames) {
    const raw = await readFile(join(viewsDir, `${viewName}.view.yaml`), "utf8");
    views.set(viewName, YAML.parse(raw) as ViewDefinition);
  }

  return views;
}

type RuntimeAuthorizationConfig = {
  realmRoles?: Record<string, { composites?: Record<string, string[]> }>;
  users?: Array<{
    username: string;
    tid?: string;
    realmRoles?: string[];
    groups?: string[];
    clientRoles?: Record<string, string[]>;
  }>;
};

async function loadAuthorizationConfig(authoringDir: string): Promise<RuntimeAuthorizationConfig> {
  const raw = await readFile(join(authoringDir, "authorization.yaml"), "utf8");
  return YAML.parse(raw) as RuntimeAuthorizationConfig;
}

function normalizeRoleList(roles: string[] | undefined): string[] {
  return [...new Set((roles ?? []).map(normalizeKeycloakRoleName))].sort();
}

function buildRuntimeAuthMetadata(
  authConfig: RuntimeAuthorizationConfig,
): Pick<RuntimeMetadataData, "realmRoleComposites" | "personas"> {
  const realmRoleComposites: Record<string, string[]> = {};
  for (const [roleName, role] of Object.entries(authConfig.realmRoles ?? {})) {
    const roles = Object.values(role.composites ?? {}).flat();
    realmRoleComposites[roleName] = normalizeRoleList(roles);
  }

  const personas = (authConfig.users ?? []).map((user) => {
    const directRoles = Object.values(user.clientRoles ?? {}).flat();
    const compositeRoles = (user.realmRoles ?? []).flatMap(
      (roleName) => realmRoleComposites[roleName] ?? [],
    );
    return {
      username: user.username,
      tid: user.tid ?? null,
      realmRoles: normalizeRoleList(user.realmRoles),
      groupPaths: [...(user.groups ?? [])].sort(),
      effectiveClientRoles: normalizeRoleList([...directRoles, ...compositeRoles]),
    };
  }).sort((left, right) => left.username.localeCompare(right.username));

  return { realmRoleComposites, personas };
}

function buildContextLabels(compiled: CompiledAuthoringEntity[]) {
  const contexts = [...new Set(compiled.flatMap((entity) => Object.keys(entity.contract.views)))];
  return contexts.map((key) => ({
    key,
    label:
      key === "core"
        ? { en: "Core", nl: "Kern" }
        : { en: key.toUpperCase(), nl: key.toUpperCase() },
  }));
}

function toKebabCase(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function isGeneratedCrudUiEnabled(contract: CompiledAuthoringEntity["contract"]) {
  // The stock generated pages assume the complete list/detail/edit surface.
  // Partial CRUD policies are valid for APIs and workflows, but require a
  // purpose-built UI rather than pages that reference omitted operations.
  return Object.values(contract.crud.operations).every(Boolean);
}

function isGeneratedCrudUiEnabledForEntityName(
  entityName: string | undefined,
  contractByName: Map<string, CompiledAuthoringEntity["contract"]>,
) {
  if (!entityName) {
    return true;
  }
  const contract = contractByName.get(entityName) ?? contractByName.get(toKebabCase(entityName));
  return contract ? isGeneratedCrudUiEnabled(contract) : true;
}

function isGeneratedCrudUiEnabledForViewName(
  viewName: string | undefined,
  viewDefinitions: Map<string, ViewDefinition>,
  contractByName: Map<string, CompiledAuthoringEntity["contract"]>,
) {
  if (!viewName) {
    return true;
  }
  const viewDefinition = viewDefinitions.get(viewName);
  if (!viewDefinition) {
    return true;
  }
  return isGeneratedCrudUiEnabledForEntityName(viewDefinition.entity, contractByName);
}

function filterAppShellNavItems(
  items: unknown,
  viewDefinitions: Map<string, ViewDefinition>,
  contractByName: Map<string, CompiledAuthoringEntity["contract"]>,
): unknown {
  if (!Array.isArray(items)) {
    return items;
  }

  return items.flatMap((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") {
      return [rawItem];
    }

    const item = rawItem as Record<string, unknown>;
    const entity = typeof item.entity === "string" ? item.entity : undefined;
    const view = typeof item.view === "string" ? item.view : undefined;
    if (
      !isGeneratedCrudUiEnabledForEntityName(entity, contractByName) ||
      !isGeneratedCrudUiEnabledForViewName(view, viewDefinitions, contractByName)
    ) {
      return [];
    }

    if (Array.isArray(item.children)) {
      const children = filterAppShellNavItems(item.children, viewDefinitions, contractByName);
      if (Array.isArray(children) && children.length === 0 && !item.route && !item.view && !item.entity) {
        return [];
      }
      return [{ ...item, children }];
    }

    return [item];
  });
}

function buildNavRoutes(
  compiled: CompiledAuthoringEntity[],
  viewDefinitions: Map<string, ViewDefinition>,
  contractByName: Map<string, CompiledAuthoringEntity["contract"]>,
): Map<string, ViewDefinition["routes"]["list"]> {
  const navRoutes = new Map<string, ViewDefinition["routes"]["list"]>();
  for (const entity of compiled) {
    if (!isGeneratedCrudUiEnabled(entity.contract)) {
      continue;
    }
    const contextKeys = Object.keys(entity.contract.views);
    const viewRoutes =
      entity.contract.views.core?.routes ?? entity.contract.views[contextKeys[0] ?? ""]?.routes;
    if (viewRoutes?.list) {
      navRoutes.set(entity.name, viewRoutes.list);
    }
  }
  for (const [viewName, viewDefinition] of viewDefinitions) {
    if (navRoutes.has(viewName)) {
      continue;
    }
    if (!isGeneratedCrudUiEnabledForEntityName(viewDefinition.entity, contractByName)) {
      continue;
    }
    if (viewDefinition.routes?.list) {
      navRoutes.set(viewName, viewDefinition.routes.list);
    }
  }
  return navRoutes;
}

const ENTITY_PAGE_CONFIG_KINDS = [
  { kind: "list", select: (b: EntityPageConfigBundle) => b.listConfigs },
  { kind: "detail", select: (b: EntityPageConfigBundle) => b.detailConfigs },
  { kind: "workspace", select: (b: EntityPageConfigBundle) => b.workspaceConfigs },
  { kind: "create_form", select: (b: EntityPageConfigBundle) => b.createFormConfigs },
  { kind: "edit_form", select: (b: EntityPageConfigBundle) => b.editFormConfigs },
] as const;

/**
 * Build the entity-page-configs catalog seed JSON: one row per non-empty
 * (entitySlug, configKind) config object. Rows are sorted deterministically and
 * the checksum is a sha256 over the serialized rows so the seed gate / Redis
 * cache key stay stable across runs with identical config output.
 */
function buildEntityPageConfigsSeed(bundles: EntityPageConfigBundle[]): string {
  const rows: Array<{
    entitySlug: string;
    configKind: string;
    configs: unknown;
  }> = [];

  for (const bundle of bundles) {
    for (const { kind, select } of ENTITY_PAGE_CONFIG_KINDS) {
      const configs = select(bundle);
      if (configs && Object.keys(configs).length > 0) {
        rows.push({ entitySlug: bundle.entitySlug, configKind: kind, configs });
      }
    }
  }

  rows.sort((a, b) =>
    a.entitySlug === b.entitySlug
      ? a.configKind.localeCompare(b.configKind)
      : a.entitySlug.localeCompare(b.entitySlug),
  );

  const serializedRows = JSON.stringify(rows);
  const checksum = createHash("sha256").update(serializedRows).digest("hex");

  return JSON.stringify({ checksum, rows });
}

function toServiceWebClientPath(oldCompilerPath: string): string | null {
  for (const { oldPrefix, servicePrefix } of generatedArtifactPathMappings) {
    if (oldCompilerPath.startsWith(oldPrefix)) {
      return `${servicePrefix}${oldCompilerPath.slice(oldPrefix.length)}`;
    }
  }
  return null;
}

function keepGreenfieldSafeArtifacts(files: Map<string, string>): AuthoringUiArtifact[] {
  const artifacts: AuthoringUiArtifact[] = [];

  for (const [oldCompilerPath, contents] of files) {
    const servicePath = toServiceWebClientPath(oldCompilerPath);
    if (!servicePath) {
      continue;
    }
    artifacts.push({ path: servicePath, contents });
  }

  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}
export async function generateAuthoringUiArtifacts(
  authoringDir: string,
  repoRoot: string,
): Promise<AuthoringUiArtifact[]> {
  const entityNames = listEntityFiles(authoringDir).map((file) => file.slug);
  const compiled: CompiledAuthoringEntity[] = [];

  for (const entityName of entityNames) {
    const loaded = loadEntity(authoringDir, entityName);
    compiled.push({
      name: entityName,
      contract: compile(loaded),
      appShell: loaded.appShell,
      routes: loaded.coreEntity.ui?.routes,
    });
  }

  for (const contextEntity of discoverContextEntities(authoringDir).sort((a, b) =>
    `${a.context}/${a.name}`.localeCompare(`${b.context}/${b.name}`),
  )) {
    const loaded = loadContextEntity(authoringDir, contextEntity.context, contextEntity.name);
    compiled.push({
      name: contextEntity.name,
      contract: compile(loaded),
      appShell: loaded.appShell,
    });
  }

  const viewDefinitions = await loadViewDefinitions(authoringDir);
  const authorizationConfig = await loadAuthorizationConfig(authoringDir);
  const contractByName = new Map(compiled.map((entity) => [entity.name, entity.contract]));
  const allContextLabels = buildContextLabels(compiled);
  const generatedFiles = new Map<string, string>();
  const pageConfigBundles: EntityPageConfigBundle[] = [];
  const manifestEntries: EntityManifestEntryData[] = [];
  const runtimeMetadata: RuntimeMetadataData = {
    entities: compiled
      .map((entity) => buildRuntimeMetadataEntry(entity.contract))
      .sort((left, right) => left.entitySlug.localeCompare(right.entitySlug)),
    ...buildRuntimeAuthMetadata(authorizationConfig),
  };
  const appShell = compiled.find((entity) => entity.appShell)?.appShell;

  if (appShell) {
    const layoutFiles = generateLayout(
      appShell as Parameters<typeof generateLayout>[0],
      buildNavRoutes(compiled, viewDefinitions, contractByName),
      allContextLabels,
      filterAppShellNavItems(
        (appShell as { navigation?: { sidebarItems?: unknown; items?: unknown } }).navigation?.sidebarItems ??
          (appShell as { navigation?: { items?: unknown } }).navigation?.items,
        viewDefinitions,
        contractByName,
      ) as Parameters<typeof generateLayout>[3],
    );
    for (const [path, contents] of layoutFiles) {
      generatedFiles.set(path, contents);
    }
  }

  for (const [viewName, viewDefinition] of viewDefinitions) {
    const contract = contractByName.get(viewDefinition.entity);
    if (!contract) {
      throw new Error(
        `View ${viewName}.view.yaml references entity "${viewDefinition.entity}" but no compiled contract exists.`,
      );
    }
    if (!isGeneratedCrudUiEnabled(contract)) {
      continue;
    }

    const result = generateViewPages(
      viewDefinition,
      contract,
      allContextLabels,
      viewDefinitions,
      contractByName,
    );
    for (const [path, contents] of result.files) {
      generatedFiles.set(path, contents);
    }
    manifestEntries.push(result.manifestEntry);
    pageConfigBundles.push(result.pageConfigBundle);
  }

  // Entities with inline `ui` presentations but no standalone `.view.yaml` still
  // get generated CRUD pages: the compiled contract already carries the inline
  // presentations, so a minimal in-memory view definition (entity + routes) is
  // enough to drive page generation.
  for (const entity of compiled) {
    if (viewDefinitions.has(entity.name)) {
      continue;
    }
    if (!isGeneratedCrudUiEnabled(entity.contract)) {
      continue;
    }
    if (!entity.routes) {
      continue;
    }
    const syntheticView: ViewDefinition = {
      schemaVersion: 1,
      kind: "view",
      entity: entity.name,
      sources: [{ entity: entity.name }],
      routes: entity.routes,
      presentations: {},
    };
    const result = generateViewPages(
      syntheticView,
      entity.contract,
      allContextLabels,
      viewDefinitions,
      contractByName,
    );
    for (const [path, contents] of result.files) {
      generatedFiles.set(path, contents);
    }
    manifestEntries.push(result.manifestEntry);
    pageConfigBundles.push(result.pageConfigBundle);
  }

  // Catalog seed for platform.entity_page_configs: one row per non-empty
  // (entitySlug, configKind) config object. This is ADDITIVE to the .ts config
  // bases emitted above — both are produced from the same in-memory configs.
  const entityPageConfigsSeed = buildEntityPageConfigsSeed(pageConfigBundles);
  generatedFiles.set(
    "page-configs/entity-page-configs.seed.json",
    entityPageConfigsSeed,
  );

  const routeFiles = generateDynamicRoutes(manifestEntries, runtimeMetadata);
  for (const [path, contents] of routeFiles) {
    generatedFiles.set(path, contents);
  }

  const persisted = await generatePersistedOperationArtifacts({
    repoRoot,
    generatedWebSources: generatedFiles,
    pageConfigs: pageConfigBundles,
  });
  return [...keepGreenfieldSafeArtifacts(generatedFiles), ...persisted]
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function writeAuthoringUiArtifacts(
  repoRoot: string,
  artifacts: AuthoringUiArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    const target = join(repoRoot, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.contents, "utf8");
  }
}
