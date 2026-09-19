#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
import { collectBlueprintOperations } from "./blueprint-operations.js";
import { collectJobOperations } from "./job-operations.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pruneGeneratedUiShards } from "./prune-generated-ui-shards.js";
import { dirname, join, resolve } from "node:path";
import {
  generateAuthoringUiArtifacts,
} from "./authoring/generate-ui-artifacts.js";
import { generateAuthoringKeycloakArtifacts } from "./authoring/generate-keycloak-artifacts.js";
import {
  activeManifestSource,
  loadActivePlatformCompile,
  resolveActiveAuthoringDir,
} from "./active-manifest.js";
import {
  buildCoreReferentiedataSnapshot,
  generateCoreReferentiedataArtifacts,
  loadCoreReferentiedataCatalog,
  type CoreReferentiedataSnapshot,
} from "./core-referentiedata-artifacts.js";
import { generateArtifacts } from "./generate.js";
import { renderConnectorCatalog } from "./generate-connectors.js";
import { renderGraphqlDocumentationCatalog } from "./generate-graphql.js";
import {
  collectPluginMigrationRegistry,
  PLUGIN_MIGRATION_REGISTRY_PATH,
  renderPluginMigrationRegistry,
} from "./generate-plugin-migrations.js";
import { buildModuleRegistry, MODULE_REGISTRY_PATH, renderModuleRegistry } from "./generate-modules.js";
import { MAX_DEDICATED_TOOLS, renderMcpCatalog, type McpCatalogInput } from "./generate-mcp.js";
import { loadAuthoringConfig } from "./authoring/layers.js";
import { loadOperationCatalogs } from "./authoring/operation-catalog.js";
import {
  auditOperationSurfaceCollisions,
  assertOperationRuntimeModules,
  buildStaticOperationCatalog,
  collectAuthoredEntityPluginOperations,
  collectAuthoredModulePluginOperations,
  collectEntityOperations,
  collectPluginOperations,
  CORE_OPERATION_MODULES,
  renderOperationCatalog,
} from "./generate-operations.js";
import type { GeneratedArtifact, PlatformSchemaManifest } from "./schema.js";
import type { CompiledEntityInfo } from "./plugins.js";
import type { CompiledField } from "./authoring/types.js";
import { renderEmptyApiPersistedOperationArtifact } from "./persisted-operations.js";
import { buildWebManifest, renderWebManifest } from "./authoring/web-manifest.js";
import {
  loadFieldAuthoringProfiles,
  loadFieldCompilationCatalogs,
} from "./authoring/loader.js";
import {
  createFieldSchemaCompiler,
  renderRuntimeFieldSchemaRegistry,
} from "./field-json-schema.js";
import {
  buildFieldAuthoringRegistry,
  FIELD_AUTHORING_REGISTRY_PATH,
  renderFieldAuthoringRegistry,
} from "./field-authoring-registry.js";
import {
  loadSettingsPolicy,
  renderSettingsPolicy,
  SETTINGS_POLICY_PATH,
} from "./settings.js";
import { validateRelationshipConstraints } from "./relationship-constraints.js";

export type {
  FieldDefinition,
  FieldDefinitionAuthoringMetadata,
  FieldDefinitionCardinality,
  FieldDefinitionDeriveOnCreate,
  FieldDefinitionEqualityConstraint,
  FieldDefinitionRelationship,
  FieldDefinitionRelationshipConstraints,
  FieldDefinitionRuntimeMetadata,
  FieldDefinitionOsfType,
  FieldDefinitionOsfTypeKind,
  FieldDefinitionSuggestions,
  FieldDefinitionValidation,
  FieldDefinitionValueType,
  FieldDefinitionVariableMode,
  FieldDefinitionWorkflowInspector,
  CompiledField,
  CompiledEntityOperation,
  ComponentCatalog,
  McpDeclarativeAdapterUrls,
  McpDeclarativeOperationUrl,
  McpDeclarativeRequestHeaderMapping,
  McpDeclarativeRequestMapping,
  OsfTypeDefinition,
} from "./authoring/types.js";
export type {
  CompilerPlugin,
  CompiledEntityInfo,
  CompiledPluginOperation,
  CompiledStaticEntityOperation,
  CompiledStaticOperation,
  EntityOperationCatalog,
  JsonSchema,
  JsonValue,
  PluginBaseContext,
  PluginGenerateContext,
  PluginExecutionCompatibility,
  PluginOperationAuth,
  PluginOperationContract,
  PluginOperationError,
  PluginSchemaMigration,
  StaticOperationCatalog,
} from "./plugins.js";
export { buildWebManifest, renderWebManifest } from "./authoring/web-manifest.js";
export { collectPluginSeedFixtures, prepareRuntimeModules } from "./prepare-runtime.js";
export { resolveModelFields } from "./authoring/compiler/model.js";
export { BASE_TYPES, isBaseType, resolveBaseType, osfTypeDefinitionOf, withBaseTypes } from "./authoring/entity-fields.js";
export { defaultInverseKey, defaultInverseLabel, deriveInverseCollections } from "./authoring/inverse-collections.js";
export {
  entityOperationControlSchema,
  entityOperationJsonSchemas,
  entityRecordOutputSchema,
  entityRelationshipColumn,
  entityRelationshipKeys,
  withEntityRelationshipKeys,
  writableEntityFields,
} from "./entity-operation-json-schema.js";
export type {
  EntityRelationshipKey,
  EntityRelationshipTarget,
} from "./entity-operation-json-schema.js";
export {
  compiledFieldSchema,
  compiledObjectSchema,
  createFieldSchemaCompiler,
  renderRuntimeFieldSchemaRegistry,
  runtimeFieldSchemaRegistry,
} from "./field-json-schema.js";
export {
  buildFieldAuthoringRegistry,
  FIELD_AUTHORING_REGISTRY_PATH,
  renderFieldAuthoringRegistry,
} from "./field-authoring-registry.js";
export type { FieldAuthoringRegistry } from "./field-authoring-registry.js";
export type { FieldAuthoringProfile } from "./authoring/loader.js";
export {
  compileSettingsPolicy,
  loadSettingsPolicy,
  renderSettingsPolicy,
  SETTINGS_POLICY_PATH,
} from "./settings.js";
export type {
  AuthoringConfig,
  AuthoringSettingValue,
} from "./authoring/layers.js";
export type {
  BooleanSettingDefinition,
  ChoiceSettingDefinition,
  EffectiveSetting,
  EffectiveSettingsPolicy,
  IntegerSettingDefinition,
  OwnedSettingsSource,
  ProviderSettingDefinition,
  SettingDefinition,
  SettingsDefinitionSource,
  SettingsOwner,
  SettingsProviderSource,
  StringSetSettingDefinition,
} from "./settings.js";
export type {
  CompiledFieldSchemaOptions,
  FieldSchemaCompiler,
} from "./field-json-schema.js";
export type {
  WebCollectionView,
  WebEntityView,
  WebEntityInterface,
  WebFieldGroup,
  WebFieldProjection,
  WebManifestOptions,
  WebManifestV1,
  WebOperationIntent,
  WebOperationRef,
  WebRecordTab,
  WebRecordView,
  WebRelationshipProjection,
  WebViewMode,
} from "./authoring/web-manifest.js";

const defaultRepoRoot = resolve(import.meta.dir, "../../..");

export type ArtifactCollection = {
  groups: {
    db: GeneratedArtifact[];
    graphql: GeneratedArtifact[];
    mcp: GeneratedArtifact[];
    connectors: GeneratedArtifact[];
    modules: GeneratedArtifact[];
    pluginMigrations: GeneratedArtifact[];
    settings: GeneratedArtifact[];
    operations: GeneratedArtifact[];
    referentiedata: GeneratedArtifact[];
    ui: GeneratedArtifact[];
    keycloak: GeneratedArtifact[];
    plugins: { name: string; artifacts: GeneratedArtifact[] }[];
  };
  all: GeneratedArtifact[];
  /** Plugin-owned output paths, merged into the check gates. */
  ownedPaths: { roots: string[]; files: string[] };
};

/**
 * Pair each MCP-opted-in contract with its physical table identity.
 *
 * The table name is read back from the manifest rather than recomputed, so the
 * `schema.table` string the MCP runtime dispatches on is by construction the
 * same one the CRUD layer keys its table map on. An entity whose table did not
 * make it into the manifest is skipped — the backend manifest already fails
 * the build for an `mcp:` block without generated CRUD, so this is a guard
 * against surprises, not an expected path.
 */
function mcpCatalogInputs(
  entities: CompiledEntityInfo[],
  manifest: PlatformSchemaManifest,
): McpCatalogInput[] {
  const tableByEntityName = new Map(
    manifest.tables
      .filter((table) => table.source?.authoringEntityName)
      .map((table) => [
        table.source!.authoringEntityName!,
        `${table.schema}.${table.name}`,
      ]),
  );
  return entities.flatMap((entity) => {
    if (!entity.contract.mcp) return [];
    const table = tableByEntityName.get(entity.contract.entity.name);
    if (!table) return [];
    return [{ slug: entity.slug, contract: entity.contract, table }];
  });
}

/**
 * Every referentiedata group an entity points at, from either authoring
 * spelling: the documented `options.referentieGroep`, and the
 * `render.props.referentieGroep` the UI select components consume. Walks
 * nested children/item so a group referenced inside an object field counts.
 */
function collectReferentieGroepReferences(
  fields: readonly CompiledField[] | undefined,
  into: Map<string, Set<string>>,
  entityName: string,
): Map<string, Set<string>> {
  for (const field of fields ?? []) {
    const fromOptions =
      field.options?.type === "referentiedata" ? field.options.referentieGroep : undefined;
    const fromRender = field.render?.props?.referentieGroep;
    for (const groep of [fromOptions, fromRender]) {
      if (typeof groep === "string" && groep.length > 0) {
        const where = into.get(groep) ?? new Set<string>();
        where.add(`${entityName}.${field.key}`);
        into.set(groep, where);
      }
    }
    collectReferentieGroepReferences(field.children, into, entityName);
    if (field.item) collectReferentieGroepReferences([field.item], into, entityName);
  }
  return into;
}

/**
 * Fail closed on a `referentieGroep` that resolves to nothing.
 *
 * An unresolved group is silent by nature: the field degrades to an
 * unconstrained string, every gate stays green, and the only symptom is a
 * missing enum in generated output that nobody is looking at. A typo in the
 * group name therefore ships as a quietly weaker schema. Since the catalog and
 * the reference are both authored in this repo, a mismatch is always a
 * mistake — so it is a build error, like an unknown retention policyRef.
 */
function assertReferentieGroepsResolve(
  entities: CompiledEntityInfo[],
  snapshot: CoreReferentiedataSnapshot,
): void {
  const references = new Map<string, Set<string>>();
  for (const entity of entities) {
    collectReferentieGroepReferences(
      entity.contract.model.fields,
      references,
      entity.contract.entity.name,
    );
  }

  const failures = [...references.entries()]
    .filter(([groep]) => (snapshot[groep]?.length ?? 0) === 0)
    .map(
      ([groep, where]) =>
        `"${groep}" (referenced by ${[...where].sort().join(", ")}) ` +
        `${groep in snapshot ? "is defined but empty" : "is not defined"}`,
    )
    .sort();

  if (failures.length > 0) {
    throw new Error(
      `Referentiedata group(s) do not resolve:\n  - ${failures.join("\n  - ")}\n` +
        `Add them to catalogs/core-referentiedata.yaml (or fix the referentieGroep spelling). ` +
        `An unresolved group silently degrades the field to an unconstrained string.`,
    );
  }
}

/**
 * Collects every artifact the compiler would write, without touching disk.
 * The single entry point shared by `runCompiler` and the check scripts.
 */
export async function collectAllArtifacts(
  repoRoot: string = defaultRepoRoot,
): Promise<ArtifactCollection> {
  const authoringConfig = loadAuthoringConfig(repoRoot);
  const { manifest, entities, connectors, plugins, pluginEntries } =
    await loadActivePlatformCompile(repoRoot);
  const settingsPolicy = loadSettingsPolicy(repoRoot, authoringConfig, pluginEntries);
  validateRelationshipConstraints(entities);
  const authoringDir = resolveActiveAuthoringDir(repoRoot);
  // Web UI artifacts (CRUD pages, entity manifests, actions, workflow
  // contract) are only generated when the repo actually has a web app. A
  // data-layer + API repo skips them entirely; adding apps/web back
  // re-enables generation without compiler changes.
  const webPresent = existsSync(join(repoRoot, "apps/web"));
  const productWebPresent = existsSync(join(repoRoot, "apps/product-web"));
  // Built once, as a value, and shared by everything that needs it. Reading the
  // emitted snapshot back off disk would see the PREVIOUS run's file, since
  // artifacts are written only after every generator has produced its contents.
  const referentiedataCatalog = await loadCoreReferentiedataCatalog(repoRoot);
  const referentiedata = buildCoreReferentiedataSnapshot(referentiedataCatalog);
  assertReferentieGroepsResolve(entities, referentiedata);
  const pluginMigrationRegistry = collectPluginMigrationRegistry(manifest, plugins, {
    repoRoot,
    authoringDir,
    webPresent,
  });
  const operationContext = {
    repoRoot,
    authoringDir,
    webPresent,
  };
  const moduleOperationCatalogs = loadOperationCatalogs(authoringDir)
    .map(({ document }) => document);
  const operations = [
    ...collectBlueprintOperations(entities),
    ...collectJobOperations(),
    ...collectPluginOperations(plugins, operationContext),
    ...collectAuthoredEntityPluginOperations(entities, operationContext, referentiedata),
    ...collectAuthoredModulePluginOperations(moduleOperationCatalogs, operationContext),
  ].sort((left, right) => left.key.localeCompare(right.key));
  for (let index = 1; index < operations.length; index += 1) {
    if (operations[index - 1]!.key === operations[index]!.key) {
      throw new Error(
        `Duplicate canonical Operation key "${operations[index]!.key}". ` +
          "Keep its metadata in exactly one YAML or compiler contribution.",
      );
    }
  }
  const entityOperations = collectEntityOperations(entities);
  const moduleRegistry = buildModuleRegistry(repoRoot, pluginEntries);
  assertOperationRuntimeModules(operations, [
    ...CORE_OPERATION_MODULES,
    ...moduleRegistry.modules.map((module) => module.name),
  ]);
  // Standalone catalogs reach the web manifest as authored (bilingual names,
  // page placement) next to their lowered contracts (resolved REST address,
  // enforced auth); see WebStandaloneOperationsInput.
  const standaloneWeb = { catalogs: moduleOperationCatalogs, operations };
  const operationToolProjection = auditOperationSurfaceCollisions(
    operations,
    manifest,
    connectors,
    MAX_DEDICATED_TOOLS,
  );
  const operationCatalog = buildStaticOperationCatalog(
    operations,
    entityOperations,
    entities,
    referentiedata,
  );
  const fieldCompilationCatalogs = loadFieldCompilationCatalogs(authoringDir);
  const fieldAuthoringProfiles = loadFieldAuthoringProfiles(authoringDir);
  const fieldSchemas = createFieldSchemaCompiler({
    ...fieldCompilationCatalogs,
    referentiedata,
  });
  const context = {
    repoRoot,
    authoringDir,
    webPresent,
    manifest,
    entities,
    operationCatalog,
    fieldSchemas,
    settingsPolicy,
  };
  const executionCompatibility = plugins.flatMap((plugin) => {
    const authored = typeof plugin.executionCompatibility === "function"
      ? plugin.executionCompatibility(context)
      : plugin.executionCompatibility;
    return authored ? [{ plugin: plugin.name, contribution: authored }] : [];
  });
  const groups: ArtifactCollection["groups"] = {
    db: generateArtifacts(manifest, {
      source: activeManifestSource,
      // Resolves the operation keys authored in `writtenBy` into routes, and
      // fails the build on a key no operation answers to.
      operations: operationCatalog.operations,
      openApi: {
        entities,
        referentiedata,
        operations,
        ...(authoringConfig.restApi ? { documentation: authoringConfig.restApi } : {}),
      },
    }),
    graphql: [
      {
        path: "apps/api/src/generated/graphql/documentation.json",
        contents: renderGraphqlDocumentationCatalog(
          entities.map((entity) => entity.contract),
          activeManifestSource,
          referentiedata,
          operations,
        ),
      },
      ...(!webPresent ? [renderEmptyApiPersistedOperationArtifact()] : []),
    ],
    mcp: [
      {
        path: "apps/api/src/generated/mcp/tools.json",
        contents: renderMcpCatalog(
          mcpCatalogInputs(entities, manifest),
          activeManifestSource,
          referentiedata,
          operations,
          executionCompatibility,
          operationToolProjection,
        ),
      },
    ],
    operations: [
      {
        path: "apps/api/src/generated/operations/catalog.json",
        contents: renderOperationCatalog(operationCatalog),
      },
      {
        path: "apps/api/src/generated/operations/field-schema-registry.json",
        contents: renderRuntimeFieldSchemaRegistry({
          osfTypes: fieldCompilationCatalogs.osfTypes,
          referentiedata,
        }),
      },
      {
        path: FIELD_AUTHORING_REGISTRY_PATH,
        contents: renderFieldAuthoringRegistry(buildFieldAuthoringRegistry({
          fieldAuthoringProfiles,
          osfTypes: fieldCompilationCatalogs.osfTypes,
          referentiedataCatalog,
        })),
      },
      {
        path: "apps/api/src/generated/compiler/canonical-condition.ts",
        contents: await readFile(join(import.meta.dir, "authoring/canonical/canonical-condition.ts"), "utf8"),
      },
      {
        path: "apps/api/src/generated/compiler/expression-evaluator.ts",
        contents: await readFile(join(import.meta.dir, "authoring/canonical/expression-evaluator.ts"), "utf8"),
      },
    ],
    connectors: [
      {
        path: "apps/api/src/generated/connectors/catalog.json",
        contents: renderConnectorCatalog(connectors, manifest),
      },
    ],
    // Which plugins ship a runtime half. Always emitted so the API's boot-time
    // import is unconditional; see generate-modules.ts for why the API is told
    // rather than reading authoring.config.yaml itself.
    modules: [
      {
        path: MODULE_REGISTRY_PATH,
        contents: renderModuleRegistry(moduleRegistry),
      },
    ],
    // Omitted when no plugin contributes invariant DDL, preserving existing
    // host output byte-for-byte. The API treats an absent registry as empty.
    pluginMigrations:
      pluginMigrationRegistry.migrations.length === 0
        ? []
        : [
            {
              path: PLUGIN_MIGRATION_REGISTRY_PATH,
              contents: renderPluginMigrationRegistry(pluginMigrationRegistry),
            },
          ],
    settings: [
      {
        path: SETTINGS_POLICY_PATH,
        contents: renderSettingsPolicy(settingsPolicy),
      },
    ],
    referentiedata: await generateCoreReferentiedataArtifacts(repoRoot, referentiedata),
    // Headless hosts get the API's empty persisted-operation manifest from the
    // graphql group above. Web hosts generate the populated API + web pair as
    // part of their UI corpus.
    ui: [
      ...(webPresent ? await generateAuthoringUiArtifacts(authoringDir, repoRoot, standaloneWeb, referentiedata) : []),
      ...(productWebPresent
        ? [{
            path: "apps/product-web/src/generated/web-manifest.json",
            contents: renderWebManifest(buildWebManifest(
              entities,
              { locale: "nl", routeLocale: "en" },
              standaloneWeb,
              referentiedata,
            )),
          }]
        : []),
    ],
    keycloak: generateAuthoringKeycloakArtifacts(authoringDir),
    plugins: [],
  };

  for (const plugin of plugins) {
    if (plugin.generate) {
      groups.plugins.push({ name: plugin.name, artifacts: await plugin.generate(context) });
    }
  }

  const all = [
    ...groups.db,
    ...groups.graphql,
    ...groups.mcp,
    ...groups.operations,
    ...groups.connectors,
    ...groups.modules,
    ...groups.pluginMigrations,
    ...groups.settings,
    ...groups.referentiedata,
    ...groups.ui,
    ...groups.keycloak,
    ...groups.plugins.flatMap((entry) => entry.artifacts),
  ];
  const seenPaths = new Set<string>();
  for (const artifact of all) {
    if (seenPaths.has(artifact.path)) {
      throw new Error(`Artifact path collision: ${artifact.path} emitted twice.`);
    }
    seenPaths.add(artifact.path);
  }

  return {
    groups,
    all,
    ownedPaths: {
      roots: plugins.flatMap((plugin) => plugin.ownedPaths?.roots ?? []),
      files: plugins.flatMap((plugin) => plugin.ownedPaths?.files ?? []),
    },
  };
}

export type RunCompilerOptions = {
  /** Host repo root; defaults to this package's own monorepo root. */
  repoRoot?: string;
};

export async function runCompiler(options: RunCompilerOptions = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const { all } = await collectAllArtifacts(repoRoot);

  for (const artifact of all) {
    const target = join(repoRoot, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.contents, "utf8");
  }

  await pruneGeneratedUiShards(repoRoot, new Set(all.map((artifact) => artifact.path)));
  return all.map((artifact) => artifact.path);
}

if (import.meta.main) {
  // Host repos run `openshapeforge-compiler --repo-root .` (or set
  // OPENSHAPEFORGE_REPO_ROOT); without either, the compiler assumes it lives at
  // <repoRoot>/packages/compiler inside its own monorepo.
  const flagIndex = process.argv.indexOf("--repo-root");
  const repoRoot =
    flagIndex >= 0
      ? resolve(process.argv[flagIndex + 1] ?? ".")
      : process.env.OPENSHAPEFORGE_REPO_ROOT
        ? resolve(process.env.OPENSHAPEFORGE_REPO_ROOT)
        : undefined;
  const paths = await runCompiler(repoRoot ? { repoRoot } : {});
  for (const path of paths) {
    console.log(`generated ${path}`);
  }
}
