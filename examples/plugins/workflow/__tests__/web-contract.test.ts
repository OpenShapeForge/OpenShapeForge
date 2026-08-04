// SPDX-License-Identifier: BUSL-1.1
/**
 * The web half of the plugin contract: a route this plugin owns, gated on the
 * app it extends existing.
 *
 * Lives here rather than in the compiler's own suite because it imports the
 * plugin, and `packages/compiler` cannot — `examples/` is outside its
 * `rootDir`. The compiler side asserts the other half, that the plugin's
 * `appShellPatch` reaches the resolved authoring tree.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/__tests__/web-contract.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  PluginGenerateContext,
  CompilerPlugin,
} from "../../../../packages/compiler/src/plugins.js";
import type { PlatformSchemaManifest } from "../../../../packages/compiler/src/schema.js";
import { resolveAuthoringLayers } from "../../../../packages/compiler/src/authoring/layers.js";
import plugin from "../index.js";

const repoRoot = resolve(import.meta.dir, "../../../..");
const ROUTE_PATH = "apps/web/src/app/(plugins)/workflow/page.tsx";
/** The editor. `[id]` is a Next dynamic segment, so the name is load-bearing. */
const DEFINITION_ROUTE_PATH = "apps/web/src/app/(plugins)/workflow/[id]/page.tsx";

/**
 * `generate` reads only `authoringDir` and `webPresent`; `manifest` and
 * `entities` are part of the context type and unused by this plugin, so they
 * are supplied empty rather than assembled. If that stops being true this cast
 * is the thing that breaks, which is the correct place for it to break.
 */
function context(webPresent: boolean): PluginGenerateContext {
  return {
    repoRoot,
    authoringDir: resolveAuthoringLayers(repoRoot),
    webPresent,
    manifest: { tables: [] } as unknown as PlatformSchemaManifest,
    entities: [],
  };
}

function generate(webPresent: boolean) {
  const artifacts = (plugin as CompilerPlugin).generate!(context(webPresent));
  if (artifacts instanceof Promise) throw new Error("generate must stay synchronous");
  return artifacts;
}

/** The specifier a re-export route file points at, without its quotes. */
function specifierOf(contents: string): string {
  const match = /from "([^"]+)"/.exec(contents);
  if (!match) throw new Error(`No re-export specifier in:\n${contents}`);
  return match[1]!;
}

describe("the workflow plugin's web routes", () => {
  test("both are emitted when apps/web is present, as re-exports of the plugin's own pages", () => {
    const artifacts = generate(true);
    // A re-export and nothing else. The pages are hand-written under web/,
    // where typecheck:web reads them as source rather than as string literals.
    for (const [path, module] of [
      [ROUTE_PATH, "web/workflow-page"],
      [DEFINITION_ROUTE_PATH, "web/workflow-definition-page"],
    ]) {
      const route = artifacts.find((artifact) => artifact.path === path);
      expect(route).toBeTruthy();
      expect(route!.contents).toContain(`examples/plugins/workflow/${module}`);
      expect(route!.contents).toContain("export { default }");
    }
  });

  test("each specifier resolves to a page that is actually there", () => {
    // The one thing a string-concatenating emitter gets wrong: a route at a new
    // depth needs one more `../`, and an off-by-one is only visible at build
    // time. Resolved against the emitted path, so the count is checked rather
    // than restated.
    for (const route of generate(true).filter((artifact) =>
      artifact.path.startsWith("apps/web/src/app/"),
    )) {
      const target = resolve(
        repoRoot,
        dirname(route.path),
        specifierOf(route.contents),
      );
      expect(existsSync(`${target}.tsx`)).toBe(true);
    }
  });

  test("neither is emitted when apps/web is absent", () => {
    // A repo that keeps the engine and drops the client must not be left
    // holding a Next.js route pointing into a directory that is not there.
    const paths = generate(false).map((artifact) => artifact.path);
    expect(paths).not.toContain(ROUTE_PATH);
    expect(paths).not.toContain(DEFINITION_ROUTE_PATH);
    expect(paths.every((path) => path.startsWith("apps/api/"))).toBe(true);
  });

  test("declares its route root, so the stale/orphan gates sweep it", () => {
    // Without this, a route the plugin stops emitting would linger in apps/web
    // and keep serving — the failure mode `ownedPaths` exists to prevent.
    expect((plugin as CompilerPlugin).ownedPaths?.roots).toContain(
      "apps/web/src/app/(plugins)/workflow",
    );
  });

  test("emits byte-identical output across runs", () => {
    const first = generate(true);
    const second = generate(true);
    expect(second.map((a) => [a.path, a.contents])).toEqual(
      first.map((a) => [a.path, a.contents]),
    );
    // Sorted, so a directory walk that changed order cannot pass as a no-op.
    const paths = first.map((a) => a.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });
});
