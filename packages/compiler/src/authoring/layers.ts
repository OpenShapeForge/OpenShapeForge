// SPDX-License-Identifier: BUSL-1.1
/**
 * Layered authoring resolution — Kustomize-style bases and overlays.
 *
 * A repo declares its authoring sources in `authoring.config.yaml` at the
 * repo root:
 *
 *   layers:
 *     - packages/compiler/config/authoring        # base
 *     - authoring/overlays/my-overlay             # overlay (optional, many)
 *
 * Layers are applied in order. An overlay may:
 *   - add new files anywhere (entities, contexts, mappings, views, catalogs)
 *   - patch an entity from an earlier layer by shipping a file with the SAME
 *     slug and `kind: entityPatch` — a strategic merge (objects deep-merge,
 *     keyed arrays merge by `key`/`id`, `$delete: true` removes a keyed item,
 *     explicit `null` removes an object property)
 *   - patch the app shell with `kind: appShellPatch`, the same strategic merge
 *     against `appShell.yaml`. This is how a PLUGIN contributes a sidebar
 *     entry: `sidebarItems` is a keyed array, so a patch appends its own entry
 *     without restating anyone else's. Without it a plugin could emit a route
 *     file and have nothing in the app link to it, because shipping
 *     `appShell.yaml` outright collides.
 *
 * Catalog files (`catalogs/*.yaml`) merge across layers automatically: a
 * later layer's file with the same path strategically merges into the earlier
 * one, so an overlay can add referentiedata groups or transforms without
 * copying the base catalog. For every other path, shipping a plain file that
 * already exists in an earlier layer is an error — replacing wholesale is
 * almost always a mistake; patch instead.
 *
 * With a single layer and no patches the layer directory is used directly
 * (fast path, byte-identical to the pre-layer behavior). Otherwise the merged
 * tree is materialized deterministically under `.authoring-build/` at the
 * repo root so the resolved input is inspectable, exactly like running
 * `kustomize build`.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";

export type AuthoringConfig = {
  layers: string[];
  /** Compiler plugin module specifiers (see ../plugins.ts). */
  plugins?: string[];
};

export const AUTHORING_CONFIG_FILENAME = "authoring.config.yaml";
const DEFAULT_LAYER = "packages/compiler/config/authoring";
const BUILD_DIR = ".authoring-build";

export function loadAuthoringConfig(repoRoot: string): AuthoringConfig {
  const configPath = join(repoRoot, AUTHORING_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return { layers: [DEFAULT_LAYER] };
  }
  const parsed = YAML.parse(readFileSync(configPath, "utf8")) as {
    layers?: unknown;
    plugins?: unknown;
  } | null;
  const layers = parsed?.layers;
  if (!Array.isArray(layers) || layers.length === 0 || layers.some((l) => typeof l !== "string")) {
    throw new Error(
      `${AUTHORING_CONFIG_FILENAME} must declare a non-empty string array "layers".`,
    );
  }
  const plugins = parsed?.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.some((entry) => typeof entry !== "string")) {
    throw new Error(`${AUTHORING_CONFIG_FILENAME} "plugins" must be a string array.`);
  }
  return { layers: layers as string[], plugins: plugins as string[] };
}

/**
 * A plugin may ship its own authoring layer: an `authoring/` directory next
 * to the plugin module (local specs) or at the package root (package specs).
 * Resolved synchronously — the plugin CODE is imported separately.
 */
function pluginAuthoringDir(repoRoot: string, spec: string): string | null {
  let moduleDir: string | null = null;
  if (spec.startsWith(".") || isAbsolute(spec)) {
    const asPath = isAbsolute(spec) ? spec : resolve(repoRoot, spec);
    if (existsSync(asPath)) {
      moduleDir = asPath.endsWith(".ts") || asPath.endsWith(".js")
        ? resolve(asPath, "..")
        : asPath;
    }
  } else {
    try {
      moduleDir = resolve(Bun.resolveSync(`${spec}/package.json`, repoRoot), "..");
    } catch {
      moduleDir = null;
    }
  }
  if (!moduleDir) return null;
  const authoring = join(moduleDir, "authoring");
  return existsSync(authoring) ? authoring : null;
}

/**
 * Resolves a layer entry to an absolute directory: repo-relative or absolute
 * paths first, then a bare package specifier whose package root contains an
 * `authoring/` directory (so contexts can ship as workspace packages).
 */
function resolveLayerDir(repoRoot: string, layer: string): string {
  const asPath = isAbsolute(layer) ? layer : resolve(repoRoot, layer);
  if (existsSync(asPath)) {
    return asPath;
  }
  try {
    const packageJson = Bun.resolveSync(`${layer}/package.json`, repoRoot);
    const packageAuthoring = join(packageJson, "..", "authoring");
    if (existsSync(packageAuthoring)) {
      return packageAuthoring;
    }
    throw new Error(`package "${layer}" has no authoring/ directory`);
  } catch (error) {
    throw new Error(
      `Authoring layer "${layer}" is neither a directory (relative to ${repoRoot}) ` +
        `nor a resolvable package with an authoring/ directory. ${String(error)}`,
    );
  }
}

function walkFiles(root: string, current = root): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(root, fullPath));
    } else if (entry.isFile()) {
      results.push(relative(root, fullPath));
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Strategic merge
// ---------------------------------------------------------------------------

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayMergeKey(items: JsonValue[]): "key" | "id" | "value" | null {
  for (const candidate of ["key", "id", "value"] as const) {
    if (
      items.length > 0 &&
      items.every(
        (item) => isPlainObject(item) && typeof item[candidate] === "string",
      )
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Kustomize-style strategic merge:
 * - objects deep-merge; a patch property with value `null` deletes the key
 * - arrays whose items all carry a string `key` (or `id`) merge by that key;
 *   a patch item with `$delete: true` removes the base item; new keys append
 * - all other arrays are replaced wholesale
 */
export function strategicMerge(base: JsonValue, patch: JsonValue): JsonValue {
  if (isPlainObject(base) && isPlainObject(patch)) {
    const result: { [key: string]: JsonValue } = { ...base };
    for (const [key, patchValue] of Object.entries(patch)) {
      if (patchValue === null) {
        delete result[key];
      } else if (key in result) {
        result[key] = strategicMerge(result[key]!, patchValue);
      } else {
        result[key] = patchValue;
      }
    }
    return result;
  }

  if (Array.isArray(base) && Array.isArray(patch)) {
    const mergeKey = arrayMergeKey(base) ?? arrayMergeKey(patch);
    if (mergeKey) {
      const result: JsonValue[] = [...base];
      for (const patchItem of patch) {
        if (!isPlainObject(patchItem) || typeof patchItem[mergeKey] !== "string") {
          throw new Error(
            `Patch array items must carry a string "${mergeKey}" to merge into a keyed array.`,
          );
        }
        const index = result.findIndex(
          (item) => isPlainObject(item) && item[mergeKey] === patchItem[mergeKey],
        );
        if (patchItem.$delete === true) {
          if (index >= 0) result.splice(index, 1);
          continue;
        }
        if (index >= 0) {
          result[index] = strategicMerge(result[index]!, patchItem);
        } else {
          result.push(patchItem);
        }
      }
      return result;
    }
    return patch;
  }

  return patch;
}

// ---------------------------------------------------------------------------
// Layer resolution
// ---------------------------------------------------------------------------

/**
 * The app shell's canonical path inside a resolved authoring tree. `loader.ts`
 * reads it from exactly here, so a patch has to merge into this path and no
 * other for the result to be the document the generator sees.
 */
const APP_SHELL_FILENAME = "appShell.yaml";

function isEntityFile(relativePath: string): boolean {
  return (
    relativePath.startsWith("entities/") &&
    relativePath.endsWith(".yaml") &&
    !relativePath.split("/").pop()!.startsWith("_")
  );
}

function entitySlug(relativePath: string): string {
  return relativePath.split("/").pop()!.slice(0, -".yaml".length);
}

/**
 * Resolves the configured layers into a single authoring directory.
 * Single layer without patches -> that directory, untouched (fast path).
 */
export function resolveAuthoringLayers(repoRoot: string, config?: AuthoringConfig): string {
  const { layers, plugins = [] } = config ?? loadAuthoringConfig(repoRoot);
  const layerDirs = layers.map((layer) => resolveLayerDir(repoRoot, layer));
  for (const spec of plugins) {
    const authoring = pluginAuthoringDir(repoRoot, spec);
    if (authoring) {
      layerDirs.push(authoring);
    }
  }

  if (layerDirs.length === 1) {
    return layerDirs[0]!;
  }

  const buildDir = join(repoRoot, BUILD_DIR);
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  // relativePath -> { sourceLayer, contents } for plain files;
  // entity slugs are tracked separately so patches can target them by slug.
  const files = new Map<string, { layer: string; path: string }>();
  const entityPathBySlug = new Map<string, string>();

  for (const layerDir of layerDirs) {
    for (const relativePath of walkFiles(layerDir)) {
      const sourcePath = join(layerDir, relativePath);

      if (relativePath.endsWith(".yaml")) {
        const parsed = YAML.parse(readFileSync(sourcePath, "utf8")) as
          | { kind?: string; entity?: string }
          | null;

        if (parsed?.kind === "entityPatch") {
          const slug = entitySlug(relativePath);
          const targetRelative = entityPathBySlug.get(slug);
          if (!targetRelative) {
            throw new Error(
              `entityPatch ${layerDir}/${relativePath} targets slug "${slug}" ` +
                "but no earlier layer defines that entity.",
            );
          }
          const target = files.get(targetRelative)!;
          const baseDoc = YAML.parse(
            readFileSync(join(target.layer, target.path), "utf8"),
          ) as JsonValue;
          const { kind: _kind, ...patchBody } = parsed as { [key: string]: JsonValue };
          const merged = strategicMerge(baseDoc, patchBody as JsonValue);
          const mergedPath = join(buildDir, targetRelative);
          mkdirSync(join(mergedPath, ".."), { recursive: true });
          writeFileSync(mergedPath, YAML.stringify(merged), "utf8");
          // Later layers may patch again: repoint the base to the merged file.
          files.set(targetRelative, { layer: buildDir, path: targetRelative });
          continue;
        }

        if (parsed?.kind === "appShellPatch") {
          // Targeted by path, not by slug: there is exactly one app shell, so a
          // slug lookup would have one possible answer. The patch is merged
          // into the canonical path wherever the patch file itself sits, which
          // is what keeps a misfiled patch from being copied through as an
          // inert extra document nobody reads.
          const target = files.get(APP_SHELL_FILENAME);
          if (!target) {
            throw new Error(
              `appShellPatch ${layerDir}/${relativePath} cannot be applied: ` +
                "no earlier layer defines an app shell " +
                `(${APP_SHELL_FILENAME}).`,
            );
          }
          const baseDoc = YAML.parse(
            readFileSync(join(target.layer, target.path), "utf8"),
          ) as JsonValue;
          const { kind: _kind, ...patchBody } = parsed as { [key: string]: JsonValue };
          const merged = strategicMerge(baseDoc, patchBody as JsonValue);
          const mergedPath = join(buildDir, APP_SHELL_FILENAME);
          mkdirSync(join(mergedPath, ".."), { recursive: true });
          writeFileSync(mergedPath, YAML.stringify(merged), "utf8");
          files.set(APP_SHELL_FILENAME, { layer: buildDir, path: APP_SHELL_FILENAME });
          continue;
        }
      }

      if (files.has(relativePath)) {
        const isCatalog =
          relativePath.startsWith("catalogs/") && relativePath.endsWith(".yaml");
        if (isCatalog) {
          const target = files.get(relativePath)!;
          const baseDoc = YAML.parse(
            readFileSync(join(target.layer, target.path), "utf8"),
          ) as JsonValue;
          const overlayDoc = YAML.parse(readFileSync(sourcePath, "utf8")) as JsonValue;
          const merged = strategicMerge(baseDoc, overlayDoc);
          const mergedPath = join(buildDir, relativePath);
          mkdirSync(join(mergedPath, ".."), { recursive: true });
          writeFileSync(mergedPath, YAML.stringify(merged), "utf8");
          files.set(relativePath, { layer: buildDir, path: relativePath });
          continue;
        }
        throw new Error(
          `Layer collision on ${relativePath}: ${files.get(relativePath)!.layer} ` +
            `already provides it and ${layerDir} ships a plain replacement. ` +
            "Entities can be modified with kind: entityPatch; the app shell with " +
            "kind: appShellPatch; catalogs/*.yaml merge automatically.",
        );
      }
      if (isEntityFile(relativePath)) {
        const slug = entitySlug(relativePath);
        const existing = entityPathBySlug.get(slug);
        if (existing && existing !== relativePath) {
          throw new Error(
            `Duplicate entity slug "${slug}" across layers (${existing} vs ${relativePath}). ` +
              "Use kind: entityPatch to modify an entity from an earlier layer.",
          );
        }
        entityPathBySlug.set(slug, relativePath);
      }
      files.set(relativePath, { layer: layerDir, path: relativePath });
    }
  }

  for (const [relativePath, source] of files) {
    if (source.layer === buildDir) {
      continue; // already written by a patch merge
    }
    const target = join(buildDir, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(join(source.layer, source.path), target);
  }

  return buildDir;
}
