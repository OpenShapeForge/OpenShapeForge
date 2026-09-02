// SPDX-License-Identifier: BUSL-1.1
/**
 * Runtime module registry generator.
 *
 * Emits `apps/api/src/generated/modules/registry.json` — the list of plugin
 * runtime entry points the API imports at boot to collect GraphQL surfaces,
 * routes and seed steps. Emitted on every run, with an empty `modules` array
 * when no registered plugin ships a runtime half, so the runtime can import it
 * unconditionally (the same pattern `connectors/catalog.json` follows).
 *
 * ## Why the API is told rather than asked
 *
 * The plugin list lives in `authoring.config.yaml`, which `apps/api` must not
 * read: it imports nothing from this package, has no YAML parser, and in a
 * container the repo layout the config describes does not exist. Recording the
 * registration here keeps one place deciding what is registered, and leaves the
 * API consuming a generated artifact like every other compiler output.
 *
 * ## What is and is not resolved here
 *
 * The compiler records a *specifier* and never imports it. Resolving a runtime
 * module would make output depend on node_modules and break the determinism
 * gates — the reason connector packages are resolved at boot instead
 * (`apps/api/src/connectors/loader.ts`). Whether the module loads, and whether
 * what loads is shaped like a `RuntimeModule`, is decided at boot and fails
 * soft there.
 *
 * Existence, however, IS checked: a path specifier's runtime sibling either
 * exists in the tree or does not, which is repo state like `webPresent`, and
 * recording entry points that were never written would have the API log a load
 * failure for every plugin that simply has no runtime half.
 *
 * Determinism: pure function of the config and the tree; registration order is
 * preserved (it is meaningful — it decides seed order), no timestamps, no
 * package resolution.
 */
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { LoadedCompilerPlugin } from "./plugins.js";

export const MODULE_REGISTRY_PATH = "apps/api/src/generated/modules/registry.json";
export const MODULE_REGISTRY_ROOT = "apps/api/src/generated/modules";

/** Candidate filenames for a path-specified plugin's runtime half. */
const RUNTIME_ENTRY_FILENAMES = ["runtime.ts", "runtime/index.ts"] as const;

export type RuntimeModuleRegistration = {
  /** The plugin's compiler-side name; the runtime module must agree. */
  name: string;
  /**
   * What the API passes to `import()`. Repo-root-relative for a path
   * specifier, verbatim for a package specifier — the API resolves it against
   * its own location, so an absolute build-machine path would be wrong.
   */
  specifier: string;
};

export type ModuleRegistry = {
  version: number;
  modules: RuntimeModuleRegistration[];
};

/**
 * Where a plugin's runtime half would live.
 *
 * Path specifiers point at a module inside the repo, so the runtime half is its
 * sibling and we can say whether it exists. Package specifiers resolve through
 * node_modules, which this must not touch, so a `<pkg>/runtime` subpath export
 * is recorded unconditionally and the boot loader decides — a package that
 * exports no such subpath is one fail-soft load failure, logged once.
 */
function runtimeSpecifierFor(
  repoRoot: string,
  entry: LoadedCompilerPlugin,
): string | null {
  const isPathSpecifier = entry.spec.startsWith(".") || entry.spec.startsWith("/");
  if (!isPathSpecifier) {
    return `${entry.spec}/runtime`;
  }
  const pluginDir = dirname(entry.modulePath);
  for (const filename of RUNTIME_ENTRY_FILENAMES) {
    const candidate = join(pluginDir, filename);
    if (existsSync(candidate)) {
      return `./${relative(repoRoot, candidate)}`;
    }
  }
  return null;
}

export function buildModuleRegistry(
  repoRoot: string,
  entries: readonly LoadedCompilerPlugin[],
): ModuleRegistry {
  const modules: RuntimeModuleRegistration[] = [];
  for (const entry of entries) {
    const specifier = runtimeSpecifierFor(repoRoot, entry);
    if (specifier) {
      modules.push({ name: entry.plugin.name, specifier });
    }
  }
  return { version: 1, modules };
}

export function renderModuleRegistry(
  registry: ModuleRegistry,
): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}
