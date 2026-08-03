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
      // Name derived from the specifier rather than fixed, so this asserts the
      // specifier-to-module mapping instead of assuming it. A stub that
      // answered the same name for every path would pass while the registry
      // loaded entirely the wrong file.
      importModule: async (specifier) => {
        seen.push(specifier);
        const dir = specifier.replace(/\/runtime\.ts$/, "").split("/").pop();
        return { default: { name: dir } };
      },
    });

    // Two plugins ship a runtime half: the workflow plugin and the domain node
    // packs split out of it. Order follows `authoring.config.yaml`, which the
    // seed order depends on.
    expect(result.failures).toEqual([]);
    expect(result.loaded.map((module) => module.name)).toEqual([
      "workflow",
      "workflow-domain-nodes",
    ]);
    // Repo-root-relative specifiers are resolved to absolute paths, not left
    // for the process cwd to interpret.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^\/.*examples\/plugins\/workflow\/runtime\.ts$/);
    expect(seen[1]).toMatch(
      /^\/.*examples\/plugins\/workflow-domain-nodes\/runtime\.ts$/,
    );
  });

  test("an import that throws is recorded, not propagated", async () => {
    const result = await loadRuntimeModules({
      importModule: async () => {
        throw new Error("boom");
      },
    });

    // Fail-soft is per module: both registered runtime halves throw here, and
    // both are recorded rather than the first one aborting the load.
    expect(result.loaded).toEqual([]);
    expect(result.failures).toHaveLength(2);
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
});
