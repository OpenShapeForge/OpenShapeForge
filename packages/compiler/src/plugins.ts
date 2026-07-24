// SPDX-License-Identifier: BUSL-1.1
/**
 * Compiler plugin system.
 *
 * A plugin extends the compiler without living in it: extra generators (e.g.
 * a future workflow-contract plugin), extra platform tables, and optionally
 * its own authoring layer (a package shipping `authoring/**` next to its
 * code — appended to the configured layers automatically).
 *
 * Registration happens in `authoring.config.yaml`:
 *
 *   plugins:
 *     - ./examples/plugins/entity-docs.ts     # local module
 *     - "@openshapeforge/plugin-workflow"         # workspace/npm package
 *
 * A plugin module default-exports a `CompilerPlugin`. Hooks must be pure and
 * deterministic — `check:generated` runs the whole pipeline twice and fails
 * on any hash difference, plugins included.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CompiledEntityContract } from "./authoring/types.js";
import { loadAuthoringConfig } from "./authoring/layers.js";
import type { GeneratedArtifact, PlatformSchemaManifest, TableDefinition } from "./schema.js";

export type CompiledEntityInfo = {
  slug: string;
  /** Repo-root-relative provenance path of the entity YAML. */
  path: string;
  origin: "core" | "contextFull";
  contract: CompiledEntityContract;
};

export type PluginBaseContext = {
  repoRoot: string;
  authoringDir: string;
  webPresent: boolean;
};

export type PluginGenerateContext = PluginBaseContext & {
  manifest: PlatformSchemaManifest;
  entities: CompiledEntityInfo[];
};

export type CompilerPlugin = {
  name: string;
  /**
   * Extra platform tables merged into the base manifest before authoring
   * entities are promoted (e.g. a workflow plugin's catalog/instance tables).
   * Colliding with an existing schema.table is an error.
   */
  contributePlatformTables?(context: PluginBaseContext): TableDefinition[];
  /** Emit artifacts; paths are repo-root-relative like all compiler output. */
  generate?(
    context: PluginGenerateContext,
  ): GeneratedArtifact[] | Promise<GeneratedArtifact[]>;
  /**
   * Generated paths this plugin owns, so `check:generated` extends its
   * stale/orphan gates to them.
   */
  ownedPaths?: { roots?: string[]; files?: string[] };
};

function resolvePluginModulePath(repoRoot: string, spec: string): string {
  if (spec.startsWith(".") || isAbsolute(spec)) {
    const asPath = isAbsolute(spec) ? spec : resolve(repoRoot, spec);
    if (existsSync(asPath)) {
      return asPath;
    }
    throw new Error(`Plugin module "${spec}" not found (resolved to ${asPath}).`);
  }
  try {
    return Bun.resolveSync(spec, repoRoot);
  } catch (error) {
    throw new Error(`Plugin package "${spec}" could not be resolved: ${String(error)}`);
  }
}

function assertPluginShape(spec: string, plugin: unknown): CompilerPlugin {
  const candidate = plugin as CompilerPlugin | undefined;
  if (!candidate || typeof candidate.name !== "string" || !candidate.name) {
    throw new Error(`Plugin "${spec}" must default-export an object with a string "name".`);
  }
  return candidate;
}

const pluginCache = new Map<string, Promise<CompilerPlugin[]>>();

export function loadCompilerPlugins(repoRoot: string): Promise<CompilerPlugin[]> {
  let cached = pluginCache.get(repoRoot);
  if (!cached) {
    cached = (async () => {
      const { plugins = [] } = loadAuthoringConfig(repoRoot);
      const loaded: CompilerPlugin[] = [];
      const seen = new Set<string>();
      for (const spec of plugins) {
        const modulePath = resolvePluginModulePath(repoRoot, spec);
        const module = (await import(modulePath)) as { default?: unknown };
        const plugin = assertPluginShape(spec, module.default);
        if (seen.has(plugin.name)) {
          throw new Error(`Duplicate compiler plugin name "${plugin.name}".`);
        }
        seen.add(plugin.name);
        loaded.push(plugin);
      }
      return loaded;
    })();
    pluginCache.set(repoRoot, cached);
  }
  return cached;
}

/** Merge plugin-contributed platform tables into the base manifest (in place). */
export function mergePluginPlatformTables(
  baseManifest: PlatformSchemaManifest,
  plugins: CompilerPlugin[],
  context: PluginBaseContext,
): void {
  const existing = new Set(baseManifest.tables.map((table) => `${table.schema}.${table.name}`));
  for (const plugin of plugins) {
    for (const table of plugin.contributePlatformTables?.(context) ?? []) {
      const key = `${table.schema}.${table.name}`;
      if (existing.has(key)) {
        throw new Error(
          `Plugin "${plugin.name}" contributes platform table ${key}, which already exists.`,
        );
      }
      existing.add(key);
      baseManifest.tables.push(table);
    }
  }
}
