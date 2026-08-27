// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Workflow contract artifact generator — produces shared TypeScript type definitions
 * and data files consumed by the workflow engine, canonical renderer, and frontend.
 *
 * Pipeline position: runs once (not per-entity) to emit cross-cutting contract artifacts.
 * Extracts field-related interfaces from the compiler's types.ts, merges semantic type
 * catalogs from authoring YAML, serializes component defaults, and emits canonical
 * condition type definitions. Outputs are duplicated to multiple target directories
 * (workflow/contract, compiler, features/renderer/generated).
 *
 * Input:  Compiler types.ts source, authoring YAML catalogs (semantic-types, components).
 * Output: Map<string, string> — generated .ts files for node-field-contract, semantic-types,
 *         component-defaults, and canonical-condition types.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  generateWorkflowEntityNodeArtifacts,
  getWorkflowCoreEntityGraphqlRegistry,
} from "./workflow-entity-nodes.js";
import { generateWorkflowNodeConfigArtifacts } from "./workflow-node-config.js";

// The canonical kernel and authoring type sources stay in the compiler core —
// they are part of every compiled entity contract. This plugin only *copies*
// them into consumer-facing generated artifacts, so it reads them from the
// compiler package by path (deep reach-in is acceptable for an example plugin).
const COMPILER_AUTHORING_DIR = join(
  import.meta.dirname,
  "../../../../packages/compiler/src/authoring",
);
const TYPES_DIR = join(COMPILER_AUTHORING_DIR, "types");
const CANONICAL_DIR = join(COMPILER_AUTHORING_DIR, "canonical");

function toKebabCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/** Read all type source files and concatenate them so regex extraction works across the split modules. */
function readTypeSource(): string {
  const files = readdirSync(TYPES_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();
  return files
    .map((f) => readFileSync(join(TYPES_DIR, f), "utf-8"))
    .join("\n");
}

const CONTRACT_DECLARATIONS = [
  { kind: "interface", name: "LocalizedText" },
  { kind: "interface", name: "ValidationRule" },
  { kind: "interface", name: "FieldValidation" },
  { kind: "interface", name: "FieldReference" },
  { kind: "interface", name: "FieldPersisted" },
  { kind: "interface", name: "FieldRender" },
  { kind: "interface", name: "FieldPermissions" },
  { kind: "interface", name: "FieldAuthorizationRoles" },
  { kind: "interface", name: "FieldAuthorizationConfig" },
  { kind: "interface", name: "VisibilityCondition" },
  { kind: "interface", name: "VisibilityConfig" },
  { kind: "interface", name: "ComputedField" },
  { kind: "interface", name: "FieldOptionStatic" },
  { kind: "interface", name: "FieldOptions" },
  { kind: "interface", name: "SemanticTypeLookupDefinition" },
  { kind: "interface", name: "DataClassification" },
  { kind: "interface", name: "RetentionPolicy" },
  { kind: "interface", name: "ContextHints" },
  { kind: "interface", name: "SemanticTypeDefinition" },
  { kind: "interface", name: "FieldSuggestions" },
  { kind: "interface", name: "FieldRelationship" },
  { kind: "interface", name: "FieldRuntimeMetadata" },
  { kind: "interface", name: "FieldWorkflowInspector" },
  { kind: "type", name: "FieldCardinality" },
  { kind: "interface", name: "FieldAuthoringMetadata" },
  { kind: "interface", name: "Field" },
] as const;

function extractExportBlock(
  source: string,
  declaration: (typeof CONTRACT_DECLARATIONS)[number],
): string {
  const signature = new RegExp(
    `export\\s+${declaration.kind}\\s+${declaration.name}\\b`,
  );
  const match = signature.exec(source);
  const start = match?.index ?? -1;
  if (start < 0) {
    throw new Error(
      `Unable to find ${declaration.kind} ${declaration.name} in compiler types source`,
    );
  }

  if (declaration.kind === "type") {
    const equals = source.indexOf("=", start);
    if (equals === -1) {
      throw new Error(
        `Unable to find equals sign for ${declaration.kind} ${declaration.name}`,
      );
    }

    let depth = 0;
    let end = -1;
    for (let index = equals + 1; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{" || char === "(" || char === "[") {
        depth += 1;
      } else if (char === "}" || char === ")" || char === "]") {
        depth -= 1;
      } else if (char === ";" && depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (end === -1) {
      throw new Error(
        `Unable to find semicolon for ${declaration.kind} ${declaration.name}`,
      );
    }
    return source.slice(start, end).trim();
  }

  const firstBrace = source.indexOf("{", start);
  if (firstBrace === -1) {
    throw new Error(
      `Unable to find opening brace for ${declaration.kind} ${declaration.name}`,
    );
  }

  let depth = 0;
  let end = -1;

  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  if (end === -1) {
    throw new Error(
      `Unable to find closing brace for ${declaration.kind} ${declaration.name}`,
    );
  }

  let cursor = end;
  while (cursor < source.length && /\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  if (source[cursor] === ";") {
    cursor += 1;
  }

  return source.slice(start, cursor).trim();
}

function buildNodeFieldContractSource() {
  const typeSource = readTypeSource();
  const declarations = CONTRACT_DECLARATIONS.map((declaration) =>
    extractExportBlock(typeSource, declaration),
  );

  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/src/authoring/types.ts",
    "// Do not edit manually.",
    "",
    ...declarations.flatMap((declaration) => [declaration, ""]),
  ].join("\n");
}

type SemanticTypeCatalog = {
  types?: Record<string, unknown>;
};

type ComponentCatalog = {
  defaults?: Record<string, {
    label?: Record<string, string>;
    component: string;
    readOnly?: boolean;
  }>;
};

type FieldAuthoringProfileCatalog = {
  profiles?: Record<string, unknown>;
};

function loadYamlFile<T>(filePath: string): T {
  return parseYaml(readFileSync(filePath, "utf-8")) as T;
}

type CategorizedSemanticTypes = {
  core: Record<string, unknown>;
  context: Record<string, unknown>;
  entityIds: Record<string, unknown>;
};

function enrichEntityIdSemanticType(definition: unknown): unknown {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return definition;
  }

  const record = definition as Record<string, unknown>;
  if (record.kind !== "entityId") {
    return definition;
  }

  const listUrl = typeof record.listUrl === "string" ? record.listUrl.trim() : "";
  return {
    ...record,
    render: {
      display: "EntityReferenceDisplay",
      input: "EntityReferenceSelect",
      ...(record.render && typeof record.render === "object" && !Array.isArray(record.render)
        ? record.render
        : {}),
    },
    ...(listUrl && !record.options
      ? {
          options: {
            type: "remote",
            remoteUrl: listUrl,
          },
        }
      : {}),
  };
}

/**
 * Splits the hand-authored semantic-types catalog into the three partials
 * the runtime contract emits. Entries are routed by their `kind` field:
 *   - `kind: "entityId"` → `entityIds` partial (consumed by the workflow
 *     designer's `core-entity-options` route).
 *   - everything else → `core` or `context` based on which YAML it came
 *     from (catalogs/ vs contexts/<name>/).
 *
 * Replaces the old auto-generated entity-ID synthesis. After this change
 * the YAML catalog is the single source of truth for every semantic type
 * the runtime sees.
 */
function loadCategorizedSemanticTypes(
  authoringDir: string,
  readableEntitySlugs: ReadonlySet<string>,
): CategorizedSemanticTypes {
  const core: Record<string, unknown> = {};
  const context: Record<string, unknown> = {};
  const entityIds: Record<string, unknown> = {};

  const route = (
    key: string,
    definition: unknown,
    bucket: "core" | "context",
  ) => {
    const def = definition as { kind?: string; entity?: string } | undefined;
    if (def?.kind === "entityId") {
      if (def.entity && !readableEntitySlugs.has(toKebabCase(def.entity))) {
        return;
      }
      entityIds[key] = enrichEntityIdSemanticType(definition);
    } else if (bucket === "core") {
      core[key] = definition;
    } else {
      context[key] = definition;
    }
  };

  const corePath = join(authoringDir, "catalogs", "semantic-types.yaml");
  if (existsSync(corePath)) {
    const types = loadYamlFile<SemanticTypeCatalog>(corePath).types ?? {};
    for (const [key, definition] of Object.entries(types)) {
      route(key, definition, "core");
    }
  }

  const contextsDir = join(authoringDir, "contexts");
  if (existsSync(contextsDir)) {
    for (const entry of readdirSync(contextsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const contextPath = join(
        contextsDir,
        entry.name,
        "semantic-types.yaml",
      );
      if (!existsSync(contextPath)) {
        continue;
      }

      const types = loadYamlFile<SemanticTypeCatalog>(contextPath).types ?? {};
      for (const [key, definition] of Object.entries(types)) {
        route(key, definition, "context");
      }
    }
  }

  return { core, context, entityIds };
}

function loadFieldComponentDefaults(authoringDir: string) {
  const componentCatalogPath = join(authoringDir, "catalogs", "components.yaml");

  if (!existsSync(componentCatalogPath)) {
    return {};
  }

  return loadYamlFile<ComponentCatalog>(componentCatalogPath).defaults ?? {};
}

function loadFieldAuthoringProfiles(authoringDir: string) {
  const profileCatalogPath = join(authoringDir, "catalogs", "field-authoring-profiles.yaml");

  if (!existsSync(profileCatalogPath)) {
    return {};
  }

  return loadYamlFile<FieldAuthoringProfileCatalog>(profileCatalogPath).profiles ?? {};
}

const SEMANTIC_PARTIALS = [
  { suffix: "core", constName: "COMPILER_SEMANTIC_TYPES_CORE", source: "catalogs/semantic-types.yaml" },
  { suffix: "context", constName: "COMPILER_SEMANTIC_TYPES_CONTEXT", source: "contexts/*/semantic-types.yaml" },
  { suffix: "entity-ids", constName: "COMPILER_SEMANTIC_TYPES_ENTITY_IDS", source: "catalogs/semantic-types.yaml + contexts/*/semantic-types.yaml (entries with kind: entityId)" },
] as const;

function buildSemanticTypesPartialSource(
  importPath: string,
  constName: string,
  sourceDescription: string,
  types: Record<string, unknown>,
) {
  const serialized = JSON.stringify(types, null, 2);

  return [
    "// Generated by OpenShapeForge Service Compiler.",
    `// Source of truth: packages/compiler/config/authoring/${sourceDescription}`,
    "// Do not edit manually.",
    "",
    `import type { SemanticTypeDefinition } from "${importPath}";`,
    "",
    `export const ${constName} = ${serialized} as const satisfies Record<string, SemanticTypeDefinition>;`,
    "",
  ].join("\n");
}

function buildSemanticTypesBarrelSource(importPath: string) {
  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/config/authoring/**/semantic-types.yaml",
    "// Do not edit manually.",
    "",
    `import type { SemanticTypeDefinition } from "${importPath}";`,
    `import { COMPILER_SEMANTIC_TYPES_CORE } from "./semantic-types-core";`,
    `import { COMPILER_SEMANTIC_TYPES_CONTEXT } from "./semantic-types-context";`,
    `import { COMPILER_SEMANTIC_TYPES_ENTITY_IDS } from "./semantic-types-entity-ids";`,
    "",
    "export const COMPILER_SEMANTIC_TYPES = {",
    "  ...COMPILER_SEMANTIC_TYPES_CORE,",
    "  ...COMPILER_SEMANTIC_TYPES_CONTEXT,",
    "  ...COMPILER_SEMANTIC_TYPES_ENTITY_IDS,",
    `} as const satisfies Record<string, SemanticTypeDefinition>;`,
    "",
    "export type CompilerSemanticTypeKey = keyof typeof COMPILER_SEMANTIC_TYPES;",
    "",
    "export const COMPILER_SEMANTIC_TYPE_KEYS = Object.keys(COMPILER_SEMANTIC_TYPES) as CompilerSemanticTypeKey[];",
    "",
    "export { COMPILER_SEMANTIC_TYPES_CORE } from \"./semantic-types-core\";",
    "export { COMPILER_SEMANTIC_TYPES_CONTEXT } from \"./semantic-types-context\";",
    "export { COMPILER_SEMANTIC_TYPES_ENTITY_IDS } from \"./semantic-types-entity-ids\";",
    "",
  ].join("\n");
}

type SemanticTypeLookupManifestEntry = {
  semanticType: string;
  provider: string;
  remoteUrl: string;
  searchParam: string;
  entity?: string;
  filters?: Record<string, string | number | boolean>;
};

function normalizeLookupFilters(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const filters: Record<string, string | number | boolean> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (
      typeof rawValue === "string" ||
      typeof rawValue === "number" ||
      typeof rawValue === "boolean"
    ) {
      filters[key] = rawValue;
    }
  }
  return Object.keys(filters).length > 0 ? filters : undefined;
}

function buildSemanticTypeLookupManifest(
  categorized: CategorizedSemanticTypes,
): Record<string, SemanticTypeLookupManifestEntry> {
  const lookups: Record<string, SemanticTypeLookupManifestEntry> = {};
  const allTypes = {
    ...categorized.core,
    ...categorized.context,
    ...categorized.entityIds,
  };

  for (const [semanticType, rawDefinition] of Object.entries(allTypes)) {
    const definition = rawDefinition as {
      kind?: string;
      entity?: string;
      listUrl?: string;
      lookup?: {
        provider?: string;
        remoteUrl?: string;
        searchParam?: string;
        filters?: unknown;
      };
    };
    if (definition.lookup?.provider) {
      const remoteUrl =
        definition.lookup.remoteUrl?.trim() ||
        `/api/runtime/lookups?semanticType=${encodeURIComponent(semanticType)}`;
      lookups[semanticType] = {
        semanticType,
        provider: definition.lookup.provider,
        remoteUrl,
        searchParam: definition.lookup.searchParam?.trim() || "search",
        ...(definition.entity ? { entity: definition.entity } : {}),
        ...(normalizeLookupFilters(definition.lookup.filters)
          ? { filters: normalizeLookupFilters(definition.lookup.filters) }
          : {}),
      };
      continue;
    }

    if (definition.kind === "entityId" && definition.entity && definition.listUrl) {
      lookups[semanticType] = {
        semanticType,
        provider: "generatedEntity",
        entity: definition.entity,
        remoteUrl: definition.listUrl,
        searchParam: "search",
      };
    }
  }

  return lookups;
}

function buildSemanticTypeLookupsSource(
  lookups: Record<string, SemanticTypeLookupManifestEntry>,
) {
  const serialized = JSON.stringify(lookups, null, 2);

  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/config/authoring/**/semantic-types.yaml",
    "// Do not edit manually.",
    "",
    "export interface CompilerSemanticTypeLookupDefinition {",
    "  semanticType: string;",
    "  provider: string;",
    "  remoteUrl: string;",
    "  searchParam: string;",
    "  entity?: string;",
    "  filters?: Record<string, string | number | boolean>;",
    "}",
    "",
    `export const COMPILER_SEMANTIC_TYPE_LOOKUPS = ${serialized} as const satisfies Record<string, CompilerSemanticTypeLookupDefinition>;`,
    "",
    "export type CompilerSemanticTypeLookupKey = keyof typeof COMPILER_SEMANTIC_TYPE_LOOKUPS;",
    "",
  ].join("\n");
}

function emitSemanticTypesFiles(
  files: Map<string, string>,
  prefix: string,
  importPath: string,
  categorized: CategorizedSemanticTypes,
) {
  const categories = [categorized.core, categorized.context, categorized.entityIds] as const;

  for (let i = 0; i < SEMANTIC_PARTIALS.length; i++) {
    const partial = SEMANTIC_PARTIALS[i]!;
    files.set(
      `${prefix}/semantic-types-${partial.suffix}.ts`,
      buildSemanticTypesPartialSource(importPath, partial.constName, partial.source, categories[i]!),
    );
  }

  files.set(
    `${prefix}/semantic-types.ts`,
    buildSemanticTypesBarrelSource(importPath),
  );
}

function buildCoreEntityGraphqlRegistrySource(
  registry: Record<string, { plural: string; filterType: string; idField: string }>,
) {
  const serialized = JSON.stringify(registry, null, 2);
  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/config/authoring/entity definitions",
    "// Do not edit manually.",
    "//",
    "// Maps each entity's kebab-case slug to the GraphQL gateway names the",
    "// workflow designer's `core-entity-options` route uses to build minimal",
    "// list queries on the fly. Keep this in sync with the GraphQL generator.",
    "",
    "export interface CoreEntityGraphqlInfo {",
    "  /** GraphQL list field name (e.g. `relations`). */",
    "  plural: string;",
    "  /** GraphQL filter input-type name (e.g. `RelationFilter`). */",
    "  filterType: string;",
    "  /** Primary-key field name on the GraphQL node. */",
    "  idField: string;",
    "}",
    "",
    `export const COMPILER_CORE_ENTITY_GRAPHQL_REGISTRY = ${serialized} as const satisfies Record<string, CoreEntityGraphqlInfo>;`,
    "",
    "export type CoreEntityGraphqlRegistrySlug = keyof typeof COMPILER_CORE_ENTITY_GRAPHQL_REGISTRY;",
    "",
  ].join("\n");
}

function buildFieldComponentDefaultsSource(authoringDir: string) {
  const defaults = loadFieldComponentDefaults(authoringDir);
  const serialized = JSON.stringify(defaults, null, 2);

  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/config/authoring/catalogs/components.yaml",
    "// Do not edit manually.",
    "",
    `export const COMPILER_FIELD_COMPONENT_DEFAULTS = ${serialized} as const;`,
    "",
    "export type CompilerFieldTypeKey = keyof typeof COMPILER_FIELD_COMPONENT_DEFAULTS;",
    "",
  ].join("\n");
}

function buildFieldAuthoringProfilesSource(authoringDir: string) {
  const profiles = loadFieldAuthoringProfiles(authoringDir);
  const serialized = JSON.stringify(profiles, null, 2);

  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/config/authoring/catalogs/field-authoring-profiles.yaml",
    "// Do not edit manually.",
    "",
    "export interface CompilerFieldAuthoringProfileDefinition {",
    "  label?: Record<string, string>;",
    "  description?: Record<string, string>;",
    "  keyBehavior?: string;",
    "  excludedFieldTypes?: string[];",
    "  typePickerUsage?: string;",
    "  controls?: Record<string, boolean | string>;",
    "  lockedVisibleProperties?: string[];",
    "  valueAuthoring?: {",
    "    label?: Record<string, string>;",
    "    description?: Record<string, string>;",
    "    component?: string;",
    "  };",
    "}",
    "",
    `export const COMPILER_FIELD_AUTHORING_PROFILES = ${serialized} as const satisfies Record<string, CompilerFieldAuthoringProfileDefinition>;`,
    "",
    "export type CompilerFieldAuthoringProfileKey = keyof typeof COMPILER_FIELD_AUTHORING_PROFILES;",
    "",
    "export const COMPILER_FIELD_AUTHORING_PROFILE_KEYS = Object.keys(COMPILER_FIELD_AUTHORING_PROFILES) as CompilerFieldAuthoringProfileKey[];",
    "",
  ].join("\n");
}

function buildCanonicalConditionSource() {
  const raw = readFileSync(join(CANONICAL_DIR, "canonical-condition.ts"), "utf-8");
  const body = raw.replace(
    /^\/\/ Source file for canonical condition \/ expression TypeScript types\.[\s\S]*?Keep it self-contained — no imports\.\n/,
    "",
  );
  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/src/authoring/canonical/canonical-condition.ts",
    "// Do not edit manually.",
    "",
    body,
  ].join("\n");
}

function buildExpressionEvaluatorSource(): string {
  const raw = readFileSync(join(CANONICAL_DIR, "expression-evaluator.ts"), "utf-8");
  // Swap the "Source file for…" preamble for the standard generated-file header so
  // consumers know not to edit in place. The evaluator itself is copied verbatim.
  const body = raw.replace(
    /^\/\/ Source file for the shared canonical expression evaluator\.[\s\S]*?consumer repos by the workflow-contract generator\.\n/,
    "",
  );
  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/src/authoring/canonical/expression-evaluator.ts",
    "// Do not edit manually.",
    "",
    body,
  ].join("\n");
}

function buildLabelAutocompleteSource(contractImportPath: string): string {
  const raw = readFileSync(join(CANONICAL_DIR, "label-autocomplete.ts"), "utf-8");
  // Strip the source "Source file for…" preamble so consumers get the
  // generated-file header instead.
  const withoutPreamble = raw.replace(
    /^\/\/ Source file for the shared label-rule autocomplete helper\.[\s\S]*?per-action \/ per-handle gating \(see openshapeforge-workflow entity-workflow\.ts\)\.\n/,
    "",
  );
  // The source imports from "./field-contract.js" for tooling inside the
  // compiler repo; each emission target has its own contract-file basename
  // (e.g. `node-field-contract` in openshapeforge-workflow). Rewrite the import path so
  // the emitted file resolves the Field / ContextHints types against the
  // co-located generated contract file.
  const body = withoutPreamble.replace(
    /from\s+"\.\/field-contract\.js"/,
    `from "${contractImportPath}.js"`,
  );
  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/src/authoring/canonical/label-autocomplete.ts",
    "// Do not edit manually.",
    "",
    body,
  ].join("\n");
}

export function generateWorkflowContractArtifacts(authoringDir: string): Map<string, string> {
  const files = new Map<string, string>();
  const coreEntityGraphqlRegistry = getWorkflowCoreEntityGraphqlRegistry(authoringDir);
  const categorizedSemanticTypes = loadCategorizedSemanticTypes(
    authoringDir,
    new Set(Object.keys(coreEntityGraphqlRegistry)),
  );
  const semanticTypeLookupManifest = buildSemanticTypeLookupManifest(categorizedSemanticTypes);

  const fieldContractSource = buildNodeFieldContractSource();
  const componentDefaultsSource = buildFieldComponentDefaultsSource(authoringDir);
  const fieldAuthoringProfilesSource = buildFieldAuthoringProfilesSource(authoringDir);
  const canonicalConditionSource = buildCanonicalConditionSource();
  const expressionEvaluatorSource = buildExpressionEvaluatorSource();
  const coreEntityGraphqlRegistrySource = buildCoreEntityGraphqlRegistrySource(
    coreEntityGraphqlRegistry,
  );
  const semanticTypeLookupsSource = buildSemanticTypeLookupsSource(
    semanticTypeLookupManifest,
  );

  for (const prefix of ["workflow/contract", "compiler", "generated/compiler", "features/renderer/generated"]) {
    const contractFile = prefix === "workflow/contract" ? "node-field-contract" : "field-contract";
    const importPath = `./${contractFile}`;
    files.set(`${prefix}/${contractFile}.ts`, fieldContractSource);
    files.set(`${prefix}/component-defaults.ts`, componentDefaultsSource);
    files.set(`${prefix}/field-authoring-profiles.ts`, fieldAuthoringProfilesSource);
    files.set(`${prefix}/canonical-condition.ts`, canonicalConditionSource);
    files.set(`${prefix}/expression-evaluator.ts`, expressionEvaluatorSource);
    files.set(`${prefix}/label-autocomplete.ts`, buildLabelAutocompleteSource(importPath));
    files.set(`${prefix}/core-entity-graphql-registry.ts`, coreEntityGraphqlRegistrySource);
    files.set(`${prefix}/semantic-type-lookups.ts`, semanticTypeLookupsSource);
    emitSemanticTypesFiles(files, prefix, importPath, categorizedSemanticTypes);
  }

  const workflowEntityNodeFiles = generateWorkflowEntityNodeArtifacts(authoringDir);
  for (const [filePath, content] of workflowEntityNodeFiles) {
    files.set(filePath, content);
  }

  const workflowNodeConfigFiles = generateWorkflowNodeConfigArtifacts(authoringDir);
  for (const [filePath, content] of workflowNodeConfigFiles) {
    files.set(filePath, content);
  }

  return files;
}
