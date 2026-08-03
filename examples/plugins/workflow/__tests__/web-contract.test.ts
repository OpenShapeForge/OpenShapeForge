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
import { resolve } from "node:path";
import type {
  PluginGenerateContext,
  CompilerPlugin,
} from "../../../../packages/compiler/src/plugins.js";
import type { PlatformSchemaManifest } from "../../../../packages/compiler/src/schema.js";
import { resolveAuthoringLayers } from "../../../../packages/compiler/src/authoring/layers.js";
import plugin from "../index.js";

const repoRoot = resolve(import.meta.dir, "../../../..");
const ROUTE_PATH = "apps/web/src/app/(plugins)/workflow/page.tsx";

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

describe("the workflow plugin's web route", () => {
  test("is emitted when apps/web is present, as a re-export of the plugin's own page", () => {
    const route = generate(true).find((artifact) => artifact.path === ROUTE_PATH);
    expect(route).toBeTruthy();
    // A re-export and nothing else. The page is hand-written under web/, where
    // typecheck:web reads it as source rather than as a string literal.
    expect(route!.contents).toContain("examples/plugins/workflow/web/workflow-page");
    expect(route!.contents).toContain("export { default }");
  });

  test("is not emitted when apps/web is absent", () => {
    // A repo that keeps the engine and drops the client must not be left
    // holding a Next.js route pointing into a directory that is not there.
    const paths = generate(false).map((artifact) => artifact.path);
    expect(paths).not.toContain(ROUTE_PATH);
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
