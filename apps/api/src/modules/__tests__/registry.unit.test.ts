// SPDX-License-Identifier: BUSL-1.1
/**
 * Boot-time resolution of plugin runtime modules.
 *
 * The property that matters is fail-soft: every rejection path must record a
 * failure and keep going, because one broken plugin taking the API down is the
 * outage this contract exists to avoid.
 */
import { describe, expect, test } from "bun:test";
import {
  assertSingleModuleEgressOwner,
  initRuntimeModules,
  loadRuntimeModules,
} from "../registry.js";
import type { ModulePlatformServices, RuntimeModule } from "../contract.js";

describe("runtime module registry", () => {
  test("loads the registered modules through the injected importer", async () => {
    const seen: string[] = [];
    const result = await loadRuntimeModules({
      // Name derived from the specifier rather than fixed, so this asserts the
      // specifier-to-module mapping instead of assuming it. A stub that
      // answered the same name for every path would pass while the registry
      // loaded entirely the wrong file.
      importModule: async (specifier) => {
        seen.push(specifier);
        const packaged: Record<string, string> = {
          "@openshapeforge/versioning/runtime": "core-versioning",
          "@openshapeforge/documents/runtime": "documents",
        };
        const dir = packaged[specifier] ?? specifier.replace(/\/runtime\.ts$/, "").split("/").pop();
        return { default: { name: dir } };
      },
    });

    // Three plugins ship a runtime half. Order follows
    // `authoring.config.yaml`, which the seed order depends on.
    expect(result.failures).toEqual([]);
    expect(result.loaded.map((module) => module.name)).toEqual([
      "core-versioning",
      "documents",
      "notebook",
    ]);
    // Repo-root-relative specifiers are resolved to absolute paths, not left
    // for the process cwd to interpret.
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe("@openshapeforge/versioning/runtime");
    expect(seen[1]).toBe("@openshapeforge/documents/runtime");
    expect(seen[2]).toMatch(/^\/.*examples\/plugins\/notebook\/runtime\.ts$/);
  });

  test("an import that throws is recorded, not propagated", async () => {
    const result = await loadRuntimeModules({
      importModule: async () => {
        throw new Error("boom");
      },
    });

    // Fail-soft is per module: all registered runtime halves throw here, and
    // all are recorded rather than the first one aborting the load.
    expect(result.loaded).toEqual([]);
    expect(result.failures).toHaveLength(3);
    for (const failure of result.failures) {
      expect(failure.reason).toBe("module_missing");
      expect(failure.message).toContain("boom");
    }
  });

  test("a module without a name is refused", async () => {
    const result = await loadRuntimeModules({
      importModule: async () => ({ default: { seeds: [] } }),
    });

    expect(result.loaded).toEqual([]);
    expect(result.failures[0]?.reason).toBe("invalid_module");
  });

  test("a module whose name disagrees with its registration is refused", async () => {
    // The two halves of one package must agree; disagreement is a stale build,
    // and running half a plugin is worse than running none of it.
    const result = await loadRuntimeModules({
      importModule: async () => ({ default: { name: "something-else" } }),
    });

    expect(result.loaded).toEqual([]);
    expect(result.failures[0]?.reason).toBe("name_mismatch");
    expect(result.failures[0]?.message).toContain("something-else");
  });

  test("delivers the exact core platform services object during init", async () => {
    const platform = {} as ModulePlatformServices;
    let received: unknown;
    const module: RuntimeModule = {
      name: "module",
      init: async (context) => { received = context.platform; },
    };
    const result = await initRuntimeModules(
      { loaded: [module], failures: [] },
      { platform },
    );
    expect(result.failures).toEqual([]);
    expect(result.loaded).toEqual([module]);
    expect(received).toBe(platform);
  });

  test("fails boot clearly when more than one loaded module owns egress", () => {
    const owner = { fetch: async () => new Response() };
    expect(() => assertSingleModuleEgressOwner([
      { name: "first", egress: owner },
      { name: "second", egress: owner },
    ])).toThrow(/exactly one loaded module may own it/);
    expect(assertSingleModuleEgressOwner([{ name: "only", egress: owner }])).toBe(owner);
  });
});
