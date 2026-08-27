// SPDX-License-Identifier: BUSL-1.1
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  compileAuthoringBackendManifest,
  listAuthoringContextEntitySpecs,
  listAuthoringEntitySlugs,
} from "./authoring/backend-manifest.js";
import { resolveAuthoringLayers } from "./authoring/layers.js";
import { buildConnector } from "./authoring/compiler/connector.js";
import { listConnectorFiles, loadConnector } from "./authoring/connector-loader.js";
import type { CompiledConnectorContract } from "./authoring/types/connector.js";
import { loadManifest } from "./load-manifest.js";
import { resolvePackagedConfigPath } from "./packaged-config.js";
import {
  loadCompilerPluginEntries,
  mergePluginPlatformTables,
  type CompiledEntityInfo,
  type CompilerPlugin,
  type LoadedCompilerPlugin,
} from "./plugins.js";
import type { PlatformSchemaManifest, TableDefinition } from "./schema.js";

export const activeManifestSource =
  "packages/compiler/config/platform-schema.yaml + authoring layers (entities + contexts/*/full)";

const resolvedAuthoringDirs = new Map<string, string>();

/**
 * The active authoring directory for a repo: its configured layers resolved
 * (and merged, when overlays or patches are present). Memoized per repo root
 * so determinism checks that generate twice see the same resolved tree.
 */
export function resolveActiveAuthoringDir(repoRoot: string): string {
  let resolved = resolvedAuthoringDirs.get(repoRoot);
  if (!resolved) {
    resolved = resolveAuthoringLayers(repoRoot);
    resolvedAuthoringDirs.set(repoRoot, resolved);
  }
  return resolved;
}

const replacedBaseTableKeys = new Set<string>();

function tableKey(table: Pick<TableDefinition, "schema" | "name">) {
  return `${table.schema}.${table.name}`;
}

function mergePromotedTables(
  baseManifest: PlatformSchemaManifest,
  promotedManifest: PlatformSchemaManifest,
): PlatformSchemaManifest {
  const promotedKeys = new Set(promotedManifest.tables.map(tableKey));
  const baseKeys = new Set(baseManifest.tables.map(tableKey));
  const missingReplacedTables = [...replacedBaseTableKeys].filter((key) => !baseKeys.has(key));
  if (missingReplacedTables.length > 0) {
    throw new Error(
      `Promoted authoring backend replacement tables are not present in the base manifest: ${missingReplacedTables.join(", ")}.`,
    );
  }
  const firstPromotedIndex = baseManifest.tables.findIndex((table) =>
    promotedKeys.has(tableKey(table)),
  );
  const retainedTables = baseManifest.tables.filter((table) => !promotedKeys.has(tableKey(table)));
  const insertAt = firstPromotedIndex < 0 ? retainedTables.length : firstPromotedIndex;

  return {
    ...baseManifest,
    description:
      "Greenfield platform schema with authoring-catalog generated backend tables.",
    relationshipRegister: baseManifest.relationshipRegister ?? [],
    tables: [
      ...retainedTables.slice(0, insertAt),
      ...promotedManifest.tables,
      ...retainedTables.slice(insertAt),
    ],
  };
}

export type ActivePlatformCompile = {
  manifest: PlatformSchemaManifest;
  /** Compiled entity contracts, in deterministic allowlist order. */
  entities: CompiledEntityInfo[];
  /** Compiled connector contracts, sorted by slug. */
  connectors: CompiledConnectorContract[];
  plugins: CompilerPlugin[];
  /** The same plugins with their provenance, for the module registry. */
  pluginEntries: LoadedCompilerPlugin[];
};

/**
 * Compiles every `connectors/<slug>.yaml` in the resolved authoring tree.
 * Connectors own no storage, so they compile independently of entity promotion
 * — nothing here touches the manifest.
 */
function compileActiveConnectors(
  authoringDir: string,
  sourcePathPrefix: string,
): CompiledConnectorContract[] {
  return listConnectorFiles(authoringDir)
    .map(({ slug, path }) => {
      const origin = join(sourcePathPrefix, "connectors", `${slug}.yaml`);
      return buildConnector(loadConnector(path, slug, origin), slug, origin);
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

const compileCache = new Map<string, Promise<ActivePlatformCompile>>();

/**
 * The full active compile for a repo: plugins loaded, plugin platform tables
 * merged, authoring entities promoted, and every compiled contract captured
 * once for reuse (generators, plugins). Memoized per repo root.
 */
export function loadActivePlatformCompile(repoRoot: string): Promise<ActivePlatformCompile> {
  let cached = compileCache.get(repoRoot);
  if (!cached) {
    cached = (async () => {
      const pluginEntries = await loadCompilerPluginEntries(repoRoot);
      const plugins = pluginEntries.map((entry) => entry.plugin);
      const baseManifest = await loadManifest(
        resolvePackagedConfigPath(repoRoot, "packages/compiler/config/platform-schema.yaml"),
      );
      const authoringDir = resolveActiveAuthoringDir(repoRoot);
      const webPresent = existsSync(join(repoRoot, "apps/web"));
      mergePluginPlatformTables(baseManifest, plugins, { repoRoot, authoringDir, webPresent });

      const authoringEntitySlugs = listAuthoringEntitySlugs(authoringDir);
      const contextEntitySpecs = listAuthoringContextEntitySpecs(authoringDir);
      const entities: CompiledEntityInfo[] = [];
      const promotedManifest = compileAuthoringBackendManifest(
        authoringDir,
        {
          mode: "promote",
          sourcePathPrefix: relative(repoRoot, authoringDir),
          entityAllowlist: authoringEntitySlugs,
          contextEntityAllowlist: contextEntitySpecs,
          schemaByModule: { core: "erp" },
          relationshipRegister: baseManifest.relationshipRegister ?? [],
          generatedCrudAllowlist: authoringEntitySlugs,
          contextEntityGeneratedCrudAllowlist: contextEntitySpecs,
          onCandidate: (candidate) => entities.push(candidate),
        },
      );

      return {
        manifest: mergePromotedTables(baseManifest, promotedManifest),
        entities,
        connectors: compileActiveConnectors(authoringDir, relative(repoRoot, authoringDir)),
        plugins,
        pluginEntries,
      };
    })();
    compileCache.set(repoRoot, cached);
  }
  return cached;
}

export async function loadActivePlatformManifest(repoRoot: string): Promise<PlatformSchemaManifest> {
  return (await loadActivePlatformCompile(repoRoot)).manifest;
}
