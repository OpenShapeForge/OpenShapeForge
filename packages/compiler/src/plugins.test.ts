// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { collectAllArtifacts } from "./index.js";
import { compilerOwnedGeneratedRoots } from "./generated-artifact-paths.js";
import { mergePluginPlatformTables } from "./plugins.js";
import { isGeneratedCrudEligible, type PlatformSchemaManifest } from "./schema.js";

const repoRoot = resolve(import.meta.dir, "../../..");

/**
 * The determinism test collects the whole artifact corpus TWICE. Against the
 * full core catalog that is a few seconds of real compilation, over bun's 5s
 * default — so state the budget rather than let corpus growth read as a hang.
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
    const migrationRegistry = first.groups.pluginMigrations.find(
      (artifact) =>
        artifact.path === "apps/api/src/generated/plugin-migrations/registry.json",
    );
    expect(migrationRegistry).toBeDefined();
    const migrations = JSON.parse(migrationRegistry!.contents) as {
      version: number;
      migrations: Array<{ plugin: string; sql: string }>;
    };
    expect(migrations.version).toBe(1);
    expect(migrations.migrations.length).toBeGreaterThan(0);
    expect(new Set(migrations.migrations.map(({ plugin }) => plugin))).toEqual(
      new Set(["osf-compiler"]),
    );
    expect(migrations.migrations.every(({ sql }) => sql.includes("ALTER TABLE")))
      .toBe(true);
    const operationCatalog = JSON.parse(first.groups.operations.find((artifact) =>
      artifact.path.endsWith("operations/catalog.json"),
    )!.contents) as { operations: { key: string }[] };
    // The notebook example plugin ships its entities through its own
    // authoring layer; their Operations reach the catalog like the core's.
    expect(operationCatalog.operations.map((entry) => entry.key)).toContain("Notebook.publish");
    const runtimeFieldSchemas = JSON.parse(first.groups.operations.find((artifact) =>
      artifact.path.endsWith("operations/field-schema-registry.json"),
    )!.contents) as {
      version: number;
      fieldDefinitionSchema: { $ref: string };
      osfTypes: Record<string, unknown>;
      referentiedata: Record<string, unknown>;
    };
    expect(runtimeFieldSchemas).toMatchObject({
      version: 1,
      fieldDefinitionSchema: { $ref: "#/$defs/fieldDefinition" },
    });
    expect(runtimeFieldSchemas.osfTypes).toHaveProperty("fieldDefinition");
    expect(Object.keys(runtimeFieldSchemas.referentiedata).length).toBeGreaterThan(0);
    const fieldAuthoringRegistry = JSON.parse(first.groups.operations.find((artifact) =>
      artifact.path === "apps/api/src/generated/compiler/field-authoring-registry.json",
    )!.contents) as {
      version: number;
      fieldAuthoringProfiles: Record<string, Record<string, unknown>>;
      osfTypes: Record<string, Record<string, unknown>>;
      referentiedata: Record<string, {
        description?: string;
        items?: Array<{ label?: Record<string, string> }>;
      }>;
    };
    expect(fieldAuthoringRegistry.version).toBe(1);
    expect(fieldAuthoringRegistry.fieldAuthoringProfiles.caseVariable).toMatchObject({
      keyBehavior: "hiddenGeneratedStable",
      typePickerUsage: "requestInput",
    });
    expect(fieldAuthoringRegistry.osfTypes.email).toMatchObject({
      baseType: "string",
      classification: { sensitivity: "pii" },
    });
    expect(fieldAuthoringRegistry.referentiedata.RELATIONTYPE).toMatchObject({
      description: expect.any(String),
    });
    expect(fieldAuthoringRegistry.referentiedata.RELATIONTYPE?.items?.[0]?.label).toEqual({
      nl: "Persoon",
      en: "Person",
      fr: "Personne",
    });
    const openApi = JSON.parse(first.groups.db.find((artifact) =>
      artifact.path.endsWith("rest/openapi.json"),
    )!.contents) as { paths: Record<string, Record<string, { operationId?: string }>> };
    expect(openApi.paths["/api/core-versioning/notebook/{id}/publish"]?.post?.operationId)
      .toBe("Notebook.publish");
    const mcp = JSON.parse(first.groups.mcp[0]!.contents) as {
      operationTools: { key: string; name: string }[];
    };
    expect(mcp.operationTools).toContainEqual(expect.objectContaining({
      key: "Notebook.publish",
      name: "notebook_publish",
    }));
    const graphql = JSON.parse(first.groups.graphql[0]!.contents) as {
      operations: { key: string; field: string }[];
    };
    expect(graphql.operations).toContainEqual(expect.objectContaining({
      key: "Notebook.publish",
      field: "notebookPublish",
    }));
    expect(compilerOwnedGeneratedRoots).toContain("apps/api/src/generated/operations");
    expect(compilerOwnedGeneratedRoots).toContain("apps/api/src/generated/compiler");
    const manifest = JSON.parse(
      first.groups.db.find((artifact) => artifact.path.endsWith("manifest.json"))!
        .contents,
    ) as PlatformSchemaManifest;
    expect(manifest.tables.some((table) => table.pluginOwner !== undefined))
      .toBe(false);
    expect(
      manifest.tables.find((table) => table.name === "erp.blocks")?.constraints
        ?.length,
    ).toBeGreaterThan(0);

    expect(second.all.map((a) => [a.path, a.contents])).toEqual(
      first.all.map((a) => [a.path, a.contents]),
    );
  }, FULL_CORPUS_TIMEOUT_MS);

  test("no generated option source points at a web route: options come from an endpoint or an entity", async () => {
    // An identity alias's listUrl is navigation. A picker that fetched it would
    // get an HTML page; its records are the entity's own list Operation.
    const { all } = await collectAllArtifacts(repoRoot);
    const remoteUrls = new Set<string>();
    for (const artifact of all) {
      for (const match of artifact.contents.matchAll(/"?remoteUrl"?\s*:\s*"([^"]*)"/g)) remoteUrls.add(match[1]!);
    }
    expect(remoteUrls.size).toBeGreaterThan(0);
    expect([...remoteUrls].filter((url) => !url.startsWith("/api/"))).toEqual([]);
    // The designer's core-entity-options route never existed; nothing may point at it, authored or generated.
    expect(all.filter((artifact) => artifact.contents.includes("core-entity-options")).map((artifact) => artifact.path)).toEqual([]);
    const registry = JSON.parse(all.find((artifact: { path: string }) => artifact.path.endsWith("operations/field-schema-registry.json"))!.contents) as {
      osfTypes: Record<string, { kind?: string; optionSource?: { type: string; source?: string; valueField?: string } }>;
    };
    const aliases = Object.entries(registry.osfTypes).filter(([, type]) => type.kind === "entityId");
    expect(aliases.length).toBeGreaterThan(100);
    for (const [key, alias] of aliases) {
      expect(JSON.stringify(alias)).not.toContain("listUrl");
      if (alias.optionSource) expect(alias.optionSource).toEqual({ type: "entity", source: key.replace(/Id$/, "").replace(/^./, (c) => c.toUpperCase()), valueField: "id" });
    }
    expect(registry.osfTypes.relationId!.optionSource).toEqual({ type: "entity", source: "Relation", valueField: "id" });
    // TenantSetting has no list Operation: nothing to enumerate, so no source.
    expect(registry.osfTypes.tenantSettingId!.optionSource).toBeUndefined();
    // The web's GraphQL registry lists only entities whose list Operation is
    // projected to GraphQL; ContactDetail and PaymentDetail withhold it.
    const graphqlRegistry = all.find((artifact: { path: string }) => artifact.path === "apps/web/src/generated/compiler/core-entity-graphql-registry.ts")!.contents;
    expect(graphqlRegistry).toContain('"relation": {');
    expect(graphqlRegistry).not.toContain('"contact-detail"');
    expect(graphqlRegistry).not.toContain('"payment-detail"');
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
