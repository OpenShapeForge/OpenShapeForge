// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import {
  loadActivePlatformManifest,
  resolveActiveAuthoringDir,
} from "./active-manifest.js";
import { collectAllArtifacts } from "./index.js";
import { mergePluginPlatformTables } from "./plugins.js";
import { isGeneratedCrudEligible, type PlatformSchemaManifest } from "./schema.js";

const repoRoot = resolve(import.meta.dir, "../../..");

/**
 * Both tests below collect the whole artifact corpus TWICE, because what they
 * assert is determinism. Against the full core catalog that is a few seconds of
 * real compilation, over bun's 5s default — so state the budget rather than let
 * corpus growth read as a hang.
 */
const FULL_CORPUS_TIMEOUT_MS = 60_000;

describe("compiler plugins", () => {
  test("collectAllArtifacts runs configured plugins deterministically", async () => {
    const first = await collectAllArtifacts(repoRoot);
    const second = await collectAllArtifacts(repoRoot);

    const docs = first.groups.plugins.find((entry) => entry.name === "entity-docs");
    expect(docs).toBeTruthy();
    expect(docs!.artifacts.map((artifact) => artifact.path)).toEqual([
      "docs/entities.generated.md",
    ]);
    expect(docs!.artifacts[0]!.contents).toContain("## Relation (`erp.relations`)");
    expect(first.ownedPaths.files).toContain("docs/entities.generated.md");
    // Existing plugins use neither invariant contract. They emit no registry
    // and gain no owner metadata, preserving the pre-contract manifest bytes.
    expect(first.groups.pluginMigrations).toEqual([]);
    const manifest = JSON.parse(
      first.groups.db.find((artifact) => artifact.path.endsWith("manifest.json"))!
        .contents,
    ) as PlatformSchemaManifest;
    expect(
      manifest.tables.some(
        (table) => table.pluginOwner !== undefined || table.constraints !== undefined,
      ),
    ).toBe(false);

    expect(second.all.map((a) => [a.path, a.contents])).toEqual(
      first.all.map((a) => [a.path, a.contents]),
    );
  }, FULL_CORPUS_TIMEOUT_MS);

  test("plugin context exposes compiled entity contracts", async () => {
    const { groups } = await collectAllArtifacts(repoRoot);
    // The docs artifact is contract/manifest-driven; every CRUD-eligible
    // entity must appear exactly once.
    const docs = groups.plugins.find((entry) => entry.name === "entity-docs")!;
    const headings = docs.artifacts[0]!.contents.match(/^## /gm) ?? [];
    const crudTables = groups.db
      .filter((artifact) => artifact.path.endsWith("manifest.json"))
      .flatMap((artifact) =>
        (JSON.parse(artifact.contents) as PlatformSchemaManifest).tables.filter(
          (table) => isGeneratedCrudEligible(table) && table.source,
        ),
      );
    expect(headings.length).toBe(crudTables.length);
  }, FULL_CORPUS_TIMEOUT_MS);

  test("workflow plugin emits api workflow artifacts deterministically", async () => {
    const first = await collectAllArtifacts(repoRoot);
    const second = await collectAllArtifacts(repoRoot);

    const workflow = first.groups.plugins.find((entry) => entry.name === "workflow");
    expect(workflow).toBeTruthy();

    const paths = workflow!.artifacts.map((artifact) => artifact.path);
    expect(paths).toContain("apps/api/src/generated/workflow/node-catalog.seed.json");
    expect(paths).toContain("apps/api/src/generated/workflow/node-catalog.ts");
    expect(paths).toContain(
      "apps/api/src/generated/workflow/entity-workflow-nodes.generated.json",
    );

    // Web-side artifacts (contract, designer registries, seeds) only exist
    // when apps/web does — in a data-layer + API repo everything is api-side.
    if (!existsSync(join(repoRoot, "apps/web"))) {
      expect(paths.every((path) => path.startsWith("apps/api/"))).toBe(true);
    }

    // Double-run determinism, byte for byte.
    const secondWorkflow = second.groups.plugins.find((entry) => entry.name === "workflow");
    expect(secondWorkflow?.artifacts).toEqual(workflow!.artifacts);

    // The node-catalog seed carries the standard catalog with a stable checksum.
    const seed = JSON.parse(
      workflow!.artifacts.find((artifact) =>
        artifact.path.endsWith("node-catalog.seed.json"),
      )!.contents,
    ) as { checksum: string; catalog: string; entries: unknown[] };
    expect(seed.catalog).toBe("standard");
    expect(seed.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(seed.entries.length).toBeGreaterThan(0);

    // The plugin's authoring layer patches Relation back into workflow-node
    // generation (entityPatch), so the entity bridge index must list it.
    const bridge = JSON.parse(
      workflow!.artifacts.find((artifact) =>
        artifact.path.endsWith("entity-workflow-nodes.generated.json"),
      )!.contents,
    ) as { type: string }[];
    expect(bridge.map((entry) => entry.type)).toContain("entity.core.relation.create");

    // Its generated root is gated by the shared stale/orphan checks.
    expect(first.ownedPaths.roots).toContain("apps/api/src/generated/workflow");
  }, FULL_CORPUS_TIMEOUT_MS);

  test("workflow plugin contributes the platform workflow catalog tables", async () => {
    const manifest = await loadActivePlatformManifest(repoRoot);
    const tableNames = manifest.tables.map((table) => `${table.schema}.${table.name}`);
    expect(tableNames).toContain("platform.workflow_node_catalog_entries");
    expect(tableNames).toContain("platform.entity_trigger_registry");
    expect(tableNames).toContain("platform.entity_field_suggestions");

    const catalogTable = manifest.tables.find(
      (table) => table.schema === "platform" && table.name === "workflow_node_catalog_entries",
    )!;
    expect(catalogTable.tenantScoped).toBe(false);
    expect(catalogTable.generatedCrud).toBe(false);
    expect(catalogTable.columns.map((column) => column.name)).toContain("catalog_checksum");
  });

  test("a plugin's sidebar entry reaches the resolved app shell", () => {
    // The route file itself is asserted in the plugin's own suite, which can
    // import it; this package cannot, because examples/ is outside its rootDir.
    // What belongs here is the layer resolution: an appShellPatch from a plugin
    // layer has to survive into the tree the web generator reads.
    const shell = YAML.parse(
      readFileSync(join(resolveActiveAuthoringDir(repoRoot), "appShell.yaml"), "utf8"),
    ) as { kind: string; navigation: { sidebarItems: { key: string; route?: unknown }[] } };

    expect(shell.kind).toBe("appShell");
    const entry = shell.navigation.sidebarItems.find((item) => item.key === "workflow");
    expect(entry).toBeTruthy();
    expect(entry!.route).toEqual({ en: "/workflow", nl: "/workflow" });
    // The base layer's entries survive: the patch appends rather than replaces.
    expect(shell.navigation.sidebarItems.some((item) => item.key === "data")).toBe(true);
  });

  test("plugin platform-table collisions are rejected", () => {
    const manifest = {
      tables: [{ schema: "platform", name: "schema_migrations" }],
    } as unknown as PlatformSchemaManifest;
    expect(() =>
      mergePluginPlatformTables(
        manifest,
        [
          {
            name: "bad-plugin",
            contributePlatformTables: () => [
              { schema: "platform", name: "schema_migrations" } as never,
            ],
          },
        ],
        { repoRoot, authoringDir: "", webPresent: false },
      ),
    ).toThrow(/already exists/);
  });

  test("marks ownership only when a plugin table uses versioned constraints", () => {
    const legacy = {
      version: 1,
      tables: [],
    } as PlatformSchemaManifest;
    mergePluginPlatformTables(
      legacy,
      [
        {
          name: "demo",
          contributePlatformTables: () => [
            {
              schema: "demo",
              name: "plain",
              tenantScoped: false,
              columns: [],
            },
          ],
        },
      ],
      { repoRoot, authoringDir: "", webPresent: false },
    );
    expect(legacy.tables[0]!.pluginOwner).toBeUndefined();

    const invariant = { version: 1, tables: [] } as PlatformSchemaManifest;
    mergePluginPlatformTables(
      invariant,
      [
        {
          name: "demo",
          contributePlatformTables: () => [
            {
              schema: "demo",
              name: "locked",
              tenantScoped: false,
              columns: [{ name: "id", type: "uuid", required: true }],
              constraints: [
                {
                  version: "0001_locked-key",
                  name: "locked_pkey",
                  kind: "primaryKey",
                  columns: ["id"],
                },
              ],
            },
          ],
        },
      ],
      { repoRoot, authoringDir: "", webPresent: false },
    );
    expect(invariant.tables[0]!.pluginOwner).toBe("demo");
  });
});
