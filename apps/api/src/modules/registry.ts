// SPDX-License-Identifier: BUSL-1.1
/**
 * Resolving plugin runtime modules at boot.
 *
 * The compiler records WHICH plugins ship a runtime half
 * (`generated/modules/registry.json`); resolving those specifiers is a runtime
 * job, for the reason `connectors/loader.ts` gives — output that depended on
 * node_modules would break the determinism gates.
 *
 * Loading is fail-soft, and deliberately so: a module that throws on import, or
 * that loads as something other than a `RuntimeModule`, is recorded as a
 * failure and skipped. One broken plugin must not take the API down, exactly as
 * one broken connector must not. The cost is that its surfaces are silently
 * absent, so every failure is logged once with its reason at startup rather
 * than discovered when a query 404s.
 *
 * The name check is not ceremony. The registry entry carries the plugin's
 * compiler-side name, and the loaded module carries its own; if they disagree,
 * the package's two halves are out of step — a stale build, a bad merge, a
 * mis-specified subpath — and the pairing the whole contract rests on no longer
 * holds. Refuse rather than run half a plugin.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import generatedRegistry from "../generated/modules/registry.json" with { type: "json" };
import type { RuntimeModule } from "./contract.js";

type RuntimeModuleRegistration = { name: string; specifier: string };

// The generated file is `{ version, modules: [] }` in a repo with no runtime
// plugin, which TypeScript infers as `never[]`. Narrow through the declared
// shape, as the connector catalog does for the same reason.
const registry = generatedRegistry as unknown as {
  version: number;
  modules: RuntimeModuleRegistration[];
};

/** Repo root, module-relative: apps/api/src/modules -> src -> api -> apps -> . */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export type ModuleLoadFailureReason = "module_missing" | "invalid_module" | "name_mismatch";

export type ModuleLoadFailure = {
  name: string;
  specifier: string;
  reason: ModuleLoadFailureReason;
  message: string;
};

export type ModuleRegistry = {
  /** Successfully loaded modules, in registration order (seed order depends on it). */
  loaded: RuntimeModule[];
  failures: ModuleLoadFailure[];
};

export type LoadModulesOptions = {
  /** Injectable for tests; production uses dynamic import. */
  importModule?: (specifier: string) => Promise<unknown>;
};

/**
 * A module's default export, shaped enough to be worth keeping. Anything
 * without a string `name` is rejected here rather than at first use.
 */
function asRuntimeModule(module: unknown): RuntimeModule | undefined {
  const candidate = (module as { default?: unknown })?.default ?? module;
  if (!candidate || typeof candidate !== "object") return undefined;
  const shape = candidate as Partial<RuntimeModule>;
  return typeof shape.name === "string" && shape.name ? (candidate as RuntimeModule) : undefined;
}

/**
 * Repo-root-relative specifiers are resolved against this file's location, not
 * the process cwd: the API is started as `bun apps/api/src/index.ts` from the
 * image root, but nothing guarantees that, and every other generated-artifact
 * read here is module-relative for the same reason.
 */
function resolveSpecifier(specifier: string): string {
  if (specifier.startsWith(".")) return join(REPO_ROOT, specifier);
  if (isAbsolute(specifier)) return specifier;
  return specifier; // bare package specifier — let the runtime resolve it
}

export async function loadRuntimeModules(
  options: LoadModulesOptions = {},
): Promise<ModuleRegistry> {
  const importModule = options.importModule ?? ((specifier) => import(specifier));
  const loaded: RuntimeModule[] = [];
  const failures: ModuleLoadFailure[] = [];

  for (const entry of registry.modules) {
    let imported: unknown;
    try {
      imported = await importModule(resolveSpecifier(entry.specifier));
    } catch (error) {
      failures.push({
        name: entry.name,
        specifier: entry.specifier,
        reason: "module_missing",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const module = asRuntimeModule(imported);
    if (!module) {
      failures.push({
        name: entry.name,
        specifier: entry.specifier,
        reason: "invalid_module",
        message: "default export is not a RuntimeModule (no string `name`)",
      });
      continue;
    }
    if (module.name !== entry.name) {
      failures.push({
        name: entry.name,
        specifier: entry.specifier,
        reason: "name_mismatch",
        message: `runtime module calls itself "${module.name}"; the plugin is registered as "${entry.name}"`,
      });
      continue;
    }
    loaded.push(module);
  }

  return { loaded, failures };
}
