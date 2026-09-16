// SPDX-License-Identifier: BUSL-1.1
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { pluginAuthoringDir } from "./authoring/layers.js";
import { loadCompilerPluginEntries } from "./plugins.js";
import type { ModuleRegistry } from "./generate-modules.js";
import type { GeneratedArtifact } from "./schema.js";

function localRuntimePath(specifier: string): boolean {
  return specifier.startsWith("./") && !specifier.includes("\\") &&
    specifier.slice(2).split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Installed packages run in place; only host-local entry points need relocation. */
export async function prepareRuntimeModules(options: {
  repoRoot: string;
  runtimeRoot: string;
  registry?: ModuleRegistry;
}): Promise<{ bundled: string[]; packages: string[] }> {
  const { repoRoot, runtimeRoot } = options;
  const registry = options.registry ?? JSON.parse(await readFile(
    join(repoRoot, "apps/api/src/generated/modules/registry.json"), "utf8",
  )) as ModuleRegistry;
  if (registry.version !== 1 || !Array.isArray(registry.modules)) throw new Error("Unsupported runtime registry.");
  const result = { bundled: [] as string[], packages: [] as string[] };
  const names = new Set<string>();
  for (const entry of registry.modules) {
    if (!entry || typeof entry.name !== "string" || !entry.name || names.has(entry.name) ||
        typeof entry.specifier !== "string" || !entry.specifier) throw new Error("Invalid runtime registration.");
    names.add(entry.name);
    if (isAbsolute(entry.specifier) || entry.specifier.startsWith(".")) {
      if (!localRuntimePath(entry.specifier)) throw new Error(`Runtime ${entry.name} must use a contained relative path.`);
      const source = resolve(repoRoot, entry.specifier);
      const target = resolve(runtimeRoot, entry.specifier);
      if (realpathSync(source) !== join(realpathSync(repoRoot), entry.specifier.slice(2))) {
        throw new Error(`Runtime ${entry.name} cannot relocate through a symbolic link.`);
      }
      if (source === target) continue;
      await mkdir(dirname(target), { recursive: true });
      const build = await Bun.build({
        entrypoints: [source], outdir: dirname(target), naming: basename(target),
        target: "bun", format: "esm", minify: false, sourcemap: "none",
      });
      if (!build.success) throw new AggregateError(build.logs, `Cannot bundle runtime ${entry.name}.`);
      result.bundled.push(entry.name);
    } else {
      const expected = realpathSync(Bun.resolveSync(entry.specifier, repoRoot));
      const actual = realpathSync(Bun.resolveSync(entry.specifier, join(runtimeRoot, "apps/api/src/modules")));
      if (actual !== expected) throw new Error(`Runtime package mismatch for ${entry.name}.`);
      result.packages.push(entry.name);
    }
  }
  return result;
}

/** Compile seed fixtures from registered plugin ownership, with no host package-name list. */
export async function collectPluginSeedFixtures(repoRoot: string): Promise<GeneratedArtifact[]> {
  const entries = await loadCompilerPluginEntries(repoRoot);
  const artifacts: GeneratedArtifact[] = [];
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.plugin.name)) throw new Error("Invalid plugin seed namespace.");
    const authoring = pluginAuthoringDir(repoRoot, entry.spec);
    if (!authoring || !existsSync(join(authoring, "seeds"))) continue;
    const directory = join(authoring, "seeds");
    for (const file of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !/\.(json|ya?ml)$/.test(file.name)) continue;
      const path = `authoring/seeds/${entry.plugin.name}.${file.name.replace(/\.(json|ya?ml)$/, ".json")}`;
      if (paths.has(path)) throw new Error(`Plugin seed fixture collision: ${path}`);
      paths.add(path);
      const contents = await readFile(join(directory, file.name), "utf8");
      const value = file.name.endsWith(".json") ? JSON.parse(contents) : parse(contents);
      artifacts.push({ path, contents: `${JSON.stringify(value, null, 2)}\n` });
    }
  }
  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}
