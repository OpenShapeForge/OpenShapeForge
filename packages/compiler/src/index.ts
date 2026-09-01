#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  generateAuthoringUiArtifacts,
} from "./authoring/generate-ui-artifacts.js";
import { generateAuthoringKeycloakArtifacts } from "./authoring/generate-keycloak-artifacts.js";
import {
  activeManifestSource,
  loadActivePlatformCompile,
  resolveActiveAuthoringDir,
} from "./active-manifest.js";
import {
  generateCoreReferentiedataArtifacts,
  loadCoreReferentiedataSnapshot,
  type CoreReferentiedataSnapshot,
} from "./core-referentiedata-artifacts.js";
import { generateArtifacts } from "./generate.js";
import { renderConnectorCatalog } from "./generate-connectors.js";
import { renderGraphqlDocumentationCatalog } from "./generate-graphql.js";
import {
  collectPluginMigrationRegistry,
  PLUGIN_MIGRATION_REGISTRY_PATH,
  renderPluginMigrationRegistry,
} from "./generate-plugin-migrations.js";
import { buildModuleRegistry, MODULE_REGISTRY_PATH, renderModuleRegistry } from "./generate-modules.js";
import { MAX_DEDICATED_TOOLS, renderMcpCatalog, type McpCatalogInput } from "./generate-mcp.js";
import { loadAuthoringConfig } from "./authoring/layers.js";
import {
  auditOperationSurfaceCollisions,
  assertOperationRuntimeModules,
  collectPluginOperations,
  renderOperationCatalog,
} from "./generate-operations.js";
import type { GeneratedArtifact, PlatformSchemaManifest } from "./schema.js";
import type { CompiledEntityInfo } from "./plugins.js";
import type { CompiledField } from "./authoring/types.js";
import { renderEmptyApiPersistedOperationArtifact } from "./persisted-operations.js";

const defaultRepoRoot = resolve(import.meta.dir, "../../..");

export type ArtifactCollection = {
  groups: {
    db: GeneratedArtifact[];
    graphql: GeneratedArtifact[];
    mcp: GeneratedArtifact[];
    connectors: GeneratedArtifact[];
    modules: GeneratedArtifact[];
    pluginMigrations: GeneratedArtifact[];
    operations: GeneratedArtifact[];
    referentiedata: GeneratedArtifact[];
    ui: GeneratedArtifact[];
    keycloak: GeneratedArtifact[];
    plugins: { name: string; artifacts: GeneratedArtifact[] }[];
  };
  all: GeneratedArtifact[];
  /** Plugin-owned output paths, merged into the check gates. */
  ownedPaths: { roots: string[]; files: string[] };
};

/**
 * Pair each MCP-opted-in contract with its physical table identity.
 *
 * The table name is read back from the manifest rather than recomputed, so the
 * `schema.table` string the MCP runtime dispatches on is by construction the
 * same one the CRUD layer keys its table map on. An entity whose table did not
 * make it into the manifest is skipped — the backend manifest already fails
 * the build for an `mcp:` block without generated CRUD, so this is a guard
 * against surprises, not an expected path.
 */
function mcpCatalogInputs(
  entities: CompiledEntityInfo[],
  manifest: PlatformSchemaManifest,
): McpCatalogInput[] {
  const tableByEntityName = new Map(
    manifest.tables
      .filter((table) => table.source?.authoringEntityName)
      .map((table) => [
        table.source!.authoringEntityName!,
        `${table.schema}.${table.name}`,
      ]),
  );
  return entities.flatMap((entity) => {
    if (!entity.contract.mcp) return [];
    const table = tableByEntityName.get(entity.contract.entity.name);
    if (!table) return [];
    return [{ slug: entity.slug, contract: entity.contract, table }];
  });
}

/**
 * Every referentiedata group an entity points at, from either authoring
 * spelling: the documented `options.referentieGroep`, and the
 * `render.props.referentieGroep` the UI select components consume. Walks
 * nested children/item so a group referenced inside an object field counts.
 */
function collectReferentieGroepReferences(
  fields: readonly CompiledField[] | undefined,
  into: Map<string, Set<string>>,
  entityName: string,
): Map<string, Set<string>> {
  for (const field of fields ?? []) {
    const fromOptions =
      field.options?.type === "referentiedata" ? field.options.referentieGroep : undefined;
    const fromRender = field.render?.props?.referentieGroep;
    for (const groep of [fromOptions, fromRender]) {
      if (typeof groep === "string" && groep.length > 0) {
        const where = into.get(groep) ?? new Set<string>();
        where.add(`${entityName}.${field.key}`);
        into.set(groep, where);
      }
    }
    collectReferentieGroepReferences(field.children, into, entityName);
    if (field.item) collectReferentieGroepReferences([field.item], into, entityName);
  }
  return into;
}

/**
 * Fail closed on a `referentieGroep` that resolves to nothing.
 *
 * An unresolved group is silent by nature: the field degrades to an
 * unconstrained string, every gate stays green, and the only symptom is a
 * missing enum in generated output that nobody is looking at. A typo in the
 * group name therefore ships as a quietly weaker schema. Since the catalog and
 * the reference are both authored in this repo, a mismatch is always a
 * mistake — so it is a build error, like an unknown retention policyRef.
 */
function assertReferentieGroepsResolve(
  entities: CompiledEntityInfo[],
  snapshot: CoreReferentiedataSnapshot,
): void {
  const references = new Map<string, Set<string>>();
  for (const entity of entities) {
    collectReferentieGroepReferences(
      entity.contract.model.fields,
      references,
      entity.contract.entity.name,
    );
  }

  const failures = [...references.entries()]
    .filter(([groep]) => (snapshot[groep]?.length ?? 0) === 0)
    .map(
      ([groep, where]) =>
        `"${groep}" (referenced by ${[...where].sort().join(", ")}) ` +
        `${groep in snapshot ? "is defined but empty" : "is not defined"}`,
    )
    .sort();

  if (failures.length > 0) {
    throw new Error(
      `Referentiedata group(s) do not resolve:\n  - ${failures.join("\n  - ")}\n` +
        `Add them to catalogs/core-referentiedata.yaml (or fix the referentieGroep spelling). ` +
        `An unresolved group silently degrades the field to an unconstrained string.`,
    );
  }
}

/**
 * Collects every artifact the compiler would write, without touching disk.
 * The single entry point shared by `runCompiler` and the check scripts.
 */
export async function collectAllArtifacts(
  repoRoot: string = defaultRepoRoot,
): Promise<ArtifactCollection> {
  const authoringConfig = loadAuthoringConfig(repoRoot);
  const { manifest, entities, connectors, plugins, pluginEntries } =
    await loadActivePlatformCompile(repoRoot);
  const authoringDir = resolveActiveAuthoringDir(repoRoot);
  // Web UI artifacts (CRUD pages, entity manifests, actions, workflow
  // contract) are only generated when the repo actually has a web app. A
  // data-layer + API repo skips them entirely; adding apps/web back
  // re-enables generation without compiler changes.
  const webPresent = existsSync(join(repoRoot, "apps/web"));
  // Built once, as a value, and shared by everything that needs it. Reading the
  // emitted snapshot back off disk would see the PREVIOUS run's file, since
  // artifacts are written only after every generator has produced its contents.
  const referentiedata = await loadCoreReferentiedataSnapshot(repoRoot);
  assertReferentieGroepsResolve(entities, referentiedata);
  const pluginMigrationRegistry = collectPluginMigrationRegistry(manifest, plugins, {
    repoRoot,
    authoringDir,
    webPresent,
  });
  const operations = collectPluginOperations(plugins, {
    repoRoot,
    authoringDir,
    webPresent,
  });
  const moduleRegistry = buildModuleRegistry(repoRoot, pluginEntries);
  assertOperationRuntimeModules(operations, moduleRegistry.modules.map((module) => module.name));
  auditOperationSurfaceCollisions(operations, manifest, connectors, MAX_DEDICATED_TOOLS);
  const groups: ArtifactCollection["groups"] = {
    db: generateArtifacts(manifest, {
      source: activeManifestSource,
      openApi: {
        entities,
        referentiedata,
        operations,
        ...(authoringConfig.restApi ? { documentation: authoringConfig.restApi } : {}),
      },
    }),
    graphql: [
      {
        path: "apps/api/src/generated/graphql/documentation.json",
        contents: renderGraphqlDocumentationCatalog(
          entities.map((entity) => entity.contract),
          activeManifestSource,
          referentiedata,
          operations,
        ),
      },
      ...(!webPresent ? [renderEmptyApiPersistedOperationArtifact()] : []),
    ],
    mcp: [
      {
        path: "apps/api/src/generated/mcp/tools.json",
        contents: renderMcpCatalog(
          mcpCatalogInputs(entities, manifest),
          activeManifestSource,
          referentiedata,
          operations,
        ),
      },
    ],
    operations: [
      {
        path: "apps/api/src/generated/operations/catalog.json",
        contents: renderOperationCatalog(operations),
      },
    ],
    connectors: [
      {
        path: "apps/api/src/generated/connectors/catalog.json",
        contents: renderConnectorCatalog(connectors, manifest),
      },
    ],
    // Which plugins ship a runtime half. Always emitted so the API's boot-time
    // import is unconditional; see generate-modules.ts for why the API is told
    // rather than reading authoring.config.yaml itself.
    modules: [
      {
        path: MODULE_REGISTRY_PATH,
        contents: renderModuleRegistry(moduleRegistry),
      },
    ],
    // Omitted when no plugin contributes invariant DDL, preserving existing
    // host output byte-for-byte. The API treats an absent registry as empty.
    pluginMigrations:
      pluginMigrationRegistry.migrations.length === 0
        ? []
        : [
            {
              path: PLUGIN_MIGRATION_REGISTRY_PATH,
              contents: renderPluginMigrationRegistry(pluginMigrationRegistry),
            },
          ],
    referentiedata: await generateCoreReferentiedataArtifacts(repoRoot, referentiedata),
    ui: webPresent ? await generateAuthoringUiArtifacts(authoringDir, repoRoot) : [],
    keycloak: generateAuthoringKeycloakArtifacts(authoringDir),
    plugins: [],
  };

  const context = { repoRoot, authoringDir, webPresent, manifest, entities };
  for (const plugin of plugins) {
    if (plugin.generate) {
      groups.plugins.push({ name: plugin.name, artifacts: await plugin.generate(context) });
    }
  }

  const all = [
    ...groups.db,
    ...groups.graphql,
    ...groups.mcp,
    ...groups.operations,
    ...groups.connectors,
    ...groups.modules,
    ...groups.pluginMigrations,
    ...groups.referentiedata,
    ...groups.ui,
    ...groups.keycloak,
    ...groups.plugins.flatMap((entry) => entry.artifacts),
  ];
  const seenPaths = new Set<string>();
  for (const artifact of all) {
    if (seenPaths.has(artifact.path)) {
      throw new Error(`Artifact path collision: ${artifact.path} emitted twice.`);
    }
    seenPaths.add(artifact.path);
  }

  return {
    groups,
    all,
    ownedPaths: {
      roots: plugins.flatMap((plugin) => plugin.ownedPaths?.roots ?? []),
      files: plugins.flatMap((plugin) => plugin.ownedPaths?.files ?? []),
    },
  };
}

export type RunCompilerOptions = {
  /** Host repo root; defaults to this package's own monorepo root. */
  repoRoot?: string;
};

export async function runCompiler(options: RunCompilerOptions = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const { all } = await collectAllArtifacts(repoRoot);

  for (const artifact of all) {
    const target = join(repoRoot, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.contents, "utf8");
  }

  return all.map((artifact) => artifact.path);
}

if (import.meta.main) {
  // Host repos run `openshapeforge-compiler --repo-root .` (or set
  // OPENSHAPEFORGE_REPO_ROOT); without either, the compiler assumes it lives at
  // <repoRoot>/packages/compiler inside its own monorepo.
  const flagIndex = process.argv.indexOf("--repo-root");
  const repoRoot =
    flagIndex >= 0
      ? resolve(process.argv[flagIndex + 1] ?? ".")
      : process.env.OPENSHAPEFORGE_REPO_ROOT
        ? resolve(process.env.OPENSHAPEFORGE_REPO_ROOT)
        : undefined;
  const paths = await runCompiler(repoRoot ? { repoRoot } : {});
  for (const path of paths) {
    console.log(`generated ${path}`);
  }
}
