// SPDX-License-Identifier: BUSL-1.1
/**
 * Boot-time resolution of plugin runtime modules.
 *
 * The property that matters is fail-soft: every rejection path must record a
 * failure and keep going, because one broken plugin taking the API down is the
 * outage this contract exists to avoid.
 */
import { describe, expect, test } from "bun:test";
import { loadRuntimeModules } from "../registry.js";

describe("runtime module registry", () => {
  test("loads the registered modules through the injected importer", async () => {
    const seen: string[] = [];
    const result = await loadRuntimeModules({
      importModule: async (specifier) => {
        seen.push(specifier);
        return { default: { name: "workflow" } };
      },
    });

    // The repo registers the workflow plugin, which ships a runtime half.
    expect(result.failures).toEqual([]);
    expect(result.loaded.map((module) => module.name)).toEqual(["workflow"]);
    // Repo-root-relative specifiers are resolved to absolute paths, not left
    // for the process cwd to interpret.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\/.*examples\/plugins\/workflow\/runtime\.ts$/);
  });

  test("an import that throws is recorded, not propagated", async () => {
    const result = await loadRuntimeModules({
      importModule: async () => {
        throw new Error("boom");
      },
    });

    expect(result.loaded).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toBe("module_missing");
    expect(result.failures[0]?.message).toContain("boom");
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
});
