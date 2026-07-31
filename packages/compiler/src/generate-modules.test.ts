// SPDX-License-Identifier: BUSL-1.1
/**
 * The runtime module registry artifact.
 *
 * What matters here is that the compiler records a specifier and never resolves
 * one — resolution would make output depend on node_modules and break the
 * determinism gates — and that a plugin without a runtime half is simply absent
 * rather than an entry the API then fails to load.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModuleRegistry } from "./generate-modules.js";
import type { LoadedCompilerPlugin } from "./plugins.js";

function entry(name: string, spec: string, modulePath: string): LoadedCompilerPlugin {
  return { plugin: { name }, spec, modulePath };
}

/** A repo root with `<pluginDir>/index.ts` and optionally a runtime sibling. */
function scratchRepo(pluginDir: string, runtimeFile?: string) {
  const root = mkdtempSync(join(tmpdir(), "osf-modules-"));
  const dir = join(root, pluginDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), "export default { name: 'x' };\n");
  if (runtimeFile) {
    const target = join(dir, runtimeFile);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "export default { name: 'x' };\n");
  }
  return { root, modulePath: join(dir, "index.ts") };
}

describe("buildModuleRegistry", () => {
  test("records a path plugin's runtime sibling, repo-root-relative", () => {
    const { root, modulePath } = scratchRepo("plugins/demo", "runtime.ts");
    const registry = buildModuleRegistry(root, [
      entry("demo", "./plugins/demo/index.ts", modulePath),
    ]);

    expect(registry.modules).toEqual([
      { name: "demo", specifier: "./plugins/demo/runtime.ts" },
    ]);
  });

  test("accepts a runtime/ directory as the entry point", () => {
    const { root, modulePath } = scratchRepo("plugins/demo", "runtime/index.ts");
    const registry = buildModuleRegistry(root, [
      entry("demo", "./plugins/demo/index.ts", modulePath),
    ]);

    expect(registry.modules[0]?.specifier).toBe("./plugins/demo/runtime/index.ts");
  });

  test("a path plugin with no runtime half is absent, not a broken entry", () => {
    // The API would otherwise log a load failure for every compile-time-only
    // plugin — entity-docs has nothing to contribute at runtime.
    const { root, modulePath } = scratchRepo("plugins/docs-only");
    const registry = buildModuleRegistry(root, [
      entry("docs-only", "./plugins/docs-only/index.ts", modulePath),
    ]);

    expect(registry.modules).toEqual([]);
  });

  test("a package specifier is recorded unresolved, as a /runtime subpath", () => {
    // Resolving it would read node_modules; the boot loader decides instead.
    const registry = buildModuleRegistry("/repo", [
      entry("pkg", "@scope/plugin-thing", "/repo/node_modules/@scope/plugin-thing/index.ts"),
    ]);

    expect(registry.modules).toEqual([
      { name: "pkg", specifier: "@scope/plugin-thing/runtime" },
    ]);
  });

  test("registration order is preserved — it decides seed order", () => {
    const first = scratchRepo("plugins/a", "runtime.ts");
    const second = scratchRepo("plugins/b", "runtime.ts");
    // Both plugin dirs under one root so the relative paths stay meaningful.
    const root = first.root;
    mkdirSync(join(root, "plugins/b"), { recursive: true });
    writeFileSync(join(root, "plugins/b/runtime.ts"), "export default { name: 'b' };\n");
    writeFileSync(join(root, "plugins/b/index.ts"), "export default { name: 'b' };\n");

    const registry = buildModuleRegistry(root, [
      entry("a", "./plugins/a/index.ts", first.modulePath),
      entry("b", "./plugins/b/index.ts", join(root, "plugins/b/index.ts")),
    ]);

    expect(registry.modules.map((module) => module.name)).toEqual(["a", "b"]);
    expect(second.root).not.toBe(root); // scratch dirs are independent
  });
});
