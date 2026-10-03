// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPluginSeedFixtures, prepareRuntimeModules } from "./prepare-runtime.js";

test("bundles a registered local runtime including its local dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "osf-runtime-"));
  try {
    await mkdir(join(root, "source/plugins/demo"), { recursive: true });
    await writeFile(join(root, "source/plugins/demo/value.ts"), "export const value = 42;");
    await writeFile(join(root, "source/plugins/demo/runtime.ts"), 'import { value } from "./value.ts"; export default { name: "demo", value };');
    const result = await prepareRuntimeModules({ repoRoot: join(root, "source"), runtimeRoot: join(root, "target"),
      registry: { version: 1, modules: [{ name: "demo", specifier: "./plugins/demo/runtime.ts" }] } });
    expect(result).toEqual({ bundled: ["demo"], packages: [] });
    const module = await import(join(root, "target/plugins/demo/runtime.ts"));
    expect(module.default).toEqual({ name: "demo", value: 42 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses path escape", async () => {
  for (const specifier of ["../outside.ts", "/outside.ts", "./plugins/../outside.ts"]) {
    await expect(prepareRuntimeModules({ repoRoot: "/unused", runtimeRoot: "/unused", registry: {
      version: 1, modules: [{ name: "demo", specifier }],
    } })).rejects.toThrow("contained relative path");
  }
});

test("uses installed runtime packages in place and rejects a different runtime binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "osf-bindings-"));
  try {
    const source = join(root, "source");
    const target = join(source, "runtime");
    const install = async (directory: string) => {
      const packageRoot = join(directory, "node_modules/demo-runtime");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "demo-runtime", exports: { "./runtime": "./runtime.ts" } }));
      await writeFile(join(packageRoot, "runtime.ts"), "export default { name: 'demo' };");
    };
    await mkdir(join(target, "apps/api/src/modules"), { recursive: true });
    await install(source);
    const registry = { version: 1, modules: [{ name: "demo", specifier: "demo-runtime/runtime" }] };
    expect(await prepareRuntimeModules({ repoRoot: source, runtimeRoot: target, registry })).toEqual({ bundled: [], packages: ["demo"] });
    await expect(prepareRuntimeModules({ repoRoot: source, runtimeRoot: target,
      registry: { version: 1, modules: [...registry.modules, ...registry.modules] } })).rejects.toThrow("Invalid runtime registration");
    // A distinct importer avoids Bun's process-local resolution cache.
    const other = join(root, "other");
    await mkdir(join(other, "apps/api/src/modules"), { recursive: true });
    await install(other);
    await expect(prepareRuntimeModules({ repoRoot: source, runtimeRoot: other, registry })).rejects.toThrow("Runtime package mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("collects deterministic namespaced fixtures from declared plugins, without copying source paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "osf-seeds-"));
  try {
    await mkdir(join(root, "plugins/demo/authoring/seeds"), { recursive: true });
    await mkdir(join(root, "authoring/base"), { recursive: true });
    await writeFile(join(root, "authoring.config.yaml"), "layers: [authoring/base]\nplugins: [./plugins/demo/index.ts]\n");
    await writeFile(join(root, "plugins/demo/index.ts"), 'export default { name: "demo" };');
    await writeFile(join(root, "plugins/demo/authoring/seeds/example.yaml"), "version: 1\nitems: []\n");
    const first = await collectPluginSeedFixtures(root);
    expect(first).toEqual([{ path: "authoring/seeds/demo.example.json", contents: '{\n  "version": 1,\n  "items": []\n}\n' }]);
    expect(await collectPluginSeedFixtures(root)).toEqual(first);
    await writeFile(join(root, "plugins/demo/authoring/seeds/example.json"), "{}");
    await expect(collectPluginSeedFixtures(root)).rejects.toThrow("collision");
    expect(await readFile(join(root, "plugins/demo/authoring/seeds/example.json"), "utf8")).toBe("{}");
  } finally { await rm(root, { recursive: true, force: true }); }
});
