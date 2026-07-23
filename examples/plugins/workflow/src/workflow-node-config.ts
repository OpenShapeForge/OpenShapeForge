// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Workflow-node config registry generator.
 *
 * Reads YAML authoring files under `packages/compiler/config/authoring/workflow-nodes/**\/*.yaml`
 * (one file per hand-written workflow node, e.g. `ai/extract-parameters.yaml`),
 * applies the light structural checks in `validateWorkflowNodeConfig` (kind,
 * required top-level shape, unique nodeType, and every config/output field
 * carrying a `key` + `valueType`), and emits a single generated TypeScript
 * module to both the workflow runtime and the web-client designer. These checks
 * are intentionally shallow — they are not a full JSON-schema validation of
 * `config/schemas/workflow-node.schema.json`; they exist to turn malformed
 * authoring input into a clear generation-time error instead of a downstream
 * runtime or typecheck failure.
 *
 * The emitted module exposes each node's canonical `configFields: Field[]`, so the
 * runtime can resolve config-slot types (for typed variable hydration) and the
 * designer can use the same source of truth for its inspector.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Field, LocalizedText } from "../../../../packages/compiler/src/authoring/types.js";
import {
  enrichFieldsWithEntityIdRemoteOptions,
  loadWorkflowNodeSemanticTypes,
} from "./workflow-entity-nodes.js";

type WorkflowNodeConfigAuthoring = {
  schemaVersion: number;
  kind: "workflowNode";
  nodeType: string;
  category: string;
  label: LocalizedText;
  description?: LocalizedText;
  configFields: Field[];
  outputFields?: Field[];
};

function collectYamlFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectYamlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

const FIELD_VALUE_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "object",
]);

/**
 * Light structural validation for a parsed workflow-node authoring file. This
 * is deliberately shallow (see the module docstring): it guards the invariants
 * the generator relies on so a malformed YAML fails here with a clear message
 * instead of producing a broken catalog seed / generated type.
 */
function validateWorkflowNodeConfig(parsed: unknown, filePath: string): WorkflowNodeConfigAuthoring {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Workflow-node authoring file ${filePath} is not a YAML mapping.`);
  }

  const node = parsed as Record<string, unknown>;
  if (node.kind !== "workflowNode") {
    throw new Error(
      `Workflow-node authoring file ${filePath} has unexpected kind "${
        typeof node.kind === "string" ? node.kind : "<none>"
      }".`,
    );
  }
  if (typeof node.nodeType !== "string" || node.nodeType.length === 0) {
    throw new Error(`Workflow-node authoring file ${filePath} is missing a non-empty "nodeType".`);
  }
  if (typeof node.category !== "string" || node.category.length === 0) {
    throw new Error(
      `Workflow-node authoring file ${filePath} (${node.nodeType}) is missing a non-empty "category".`,
    );
  }
  if (!node.label || typeof node.label !== "object") {
    throw new Error(
      `Workflow-node authoring file ${filePath} (${node.nodeType}) is missing a "label" object.`,
    );
  }
  if (!Array.isArray(node.configFields)) {
    throw new Error(
      `Workflow-node authoring file ${filePath} (${node.nodeType}) is missing a "configFields" array.`,
    );
  }
  if (node.outputFields !== undefined && !Array.isArray(node.outputFields)) {
    throw new Error(
      `Workflow-node authoring file ${filePath} (${node.nodeType}) has a non-array "outputFields".`,
    );
  }

  validateFields(node.configFields as unknown[], filePath, node.nodeType, "configFields");
  if (Array.isArray(node.outputFields)) {
    validateFields(node.outputFields as unknown[], filePath, node.nodeType, "outputFields");
  }

  return node as WorkflowNodeConfigAuthoring;
}

/** Recursively assert every field carries a `key` and a known `valueType`. */
function validateFields(
  fields: unknown[],
  filePath: string,
  nodeType: string,
  path: string,
): void {
  fields.forEach((field, index) => {
    const location = `${path}[${index}]`;
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new Error(
        `Workflow-node authoring file ${filePath} (${nodeType}) has a non-object field at ${location}.`,
      );
    }
    const record = field as Record<string, unknown>;
    if (typeof record.key !== "string" || record.key.length === 0) {
      throw new Error(
        `Workflow-node authoring file ${filePath} (${nodeType}) has a field at ${location} missing a non-empty "key".`,
      );
    }
    if (typeof record.valueType !== "string" || !FIELD_VALUE_TYPES.has(record.valueType)) {
      throw new Error(
        `Workflow-node authoring file ${filePath} (${nodeType}) field "${record.key}" (${location}) has an invalid "valueType" (${
          typeof record.valueType === "string" ? `"${record.valueType}"` : "<missing>"
        }). Expected one of: ${[...FIELD_VALUE_TYPES].join(", ")}.`,
      );
    }
    if (Array.isArray(record.children)) {
      validateFields(record.children, filePath, nodeType, `${location}.children`);
    }
    if (record.item && typeof record.item === "object" && !Array.isArray(record.item)) {
      validateFields([record.item], filePath, nodeType, `${location}.item`);
    }
  });
}

function loadWorkflowNodeConfigs(authoringDir: string): WorkflowNodeConfigAuthoring[] {
  const rootDir = join(authoringDir, "workflow-nodes");
  const files = collectYamlFiles(rootDir);
  const entries: WorkflowNodeConfigAuthoring[] = [];
  const seenNodeTypes = new Map<string, string>();

  for (const filePath of files) {
    const parsed = parseYaml(readFileSync(filePath, "utf-8")) as unknown;
    const entry = validateWorkflowNodeConfig(parsed, filePath);

    const priorFile = seenNodeTypes.get(entry.nodeType);
    if (priorFile) {
      throw new Error(
        `Workflow-node authoring files ${priorFile} and ${filePath} both declare nodeType "${entry.nodeType}"; nodeType must be unique.`,
      );
    }
    seenNodeTypes.set(entry.nodeType, filePath);

    entries.push(entry);
  }

  return entries;
}

function buildEntrySerialized(entries: WorkflowNodeConfigAuthoring[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      nodeType: entry.nodeType,
      category: entry.category,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      configFields: entry.configFields,
      ...(entry.outputFields ? { outputFields: entry.outputFields } : {}),
    })),
    null,
    2,
  );
}

function pascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function resolvedConfigInterfaceName(nodeType: string): string {
  return `Generated${pascalCase(nodeType)}ResolvedConfig`;
}

function scalarResolvedType(field: Field): string {
  switch (field.valueType) {
    case "string":
    case "date":
    case "datetime":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}

function isCollectionField(field: Field): boolean {
  if (field.cardinality === "collection") return true;
  if (!field.cardinality || typeof field.cardinality !== "object") return false;
  if (field.cardinality.max === "unbounded") return true;
  return typeof field.cardinality.max === "number" && field.cardinality.max > 1;
}

function fieldShape(field: Field): Field[] {
  return Array.isArray(field.shape) && field.shape.length > 0
    ? field.shape
    : field.children ?? [];
}

function fieldResolvedType(field: Field): string {
  const bindingType = field.variables === "whole" || field.variables === "both"
    ? " | string"
    : "";
  if (isCollectionField(field)) {
    const itemField = field.item ?? { ...field, cardinality: "single" as const };
    return `${scalarResolvedType(itemField)}[]${bindingType}`;
  }
  if (field.valueType === "object" && fieldShape(field).length > 0) {
    return `Record<string, unknown>${bindingType}`;
  }
  return `${scalarResolvedType(field)}${bindingType}`;
}

function buildResolvedConfigTypes(entries: WorkflowNodeConfigAuthoring[]): string[] {
  const nodeTypeUnion = entries.length > 0
    ? entries.map((entry) => `  | ${JSON.stringify(entry.nodeType)}`).join("\n")
    : "  | never";

  const interfaceBlocks = entries.map((entry) => [
    `export interface ${resolvedConfigInterfaceName(entry.nodeType)} extends Record<string, unknown> {`,
    ...entry.configFields.map((field) => {
      const runtime = field.runtime && typeof field.runtime === "object"
        ? field.runtime as { required?: unknown }
        : null;
      // A field's resolved value is guaranteed present when it is declared
      // required in any of the ways the authoring schema allows (top-level
      // `required`, `validation.required`, or `runtime.required`) or when a
      // non-null default is supplied. Only `runtime.required` was previously
      // honored, so genuinely-required fields were mis-emitted as optional.
      const guaranteedValue = field.required === true ||
        field.validation?.required === true ||
        runtime?.required === true ||
        (field.defaultValue !== undefined && field.defaultValue !== null);
      const optional = guaranteedValue ? "" : "?";
      const nullable = guaranteedValue ? "" : " | null";
      return `  ${JSON.stringify(field.key)}${optional}: ${fieldResolvedType(field)}${nullable};`;
    }),
    "}",
  ].join("\n"));

  const mapBlock = [
    "export type GeneratedWorkflowNodeResolvedConfigMap = {",
    ...entries.map((entry) =>
      `  ${JSON.stringify(entry.nodeType)}: ${resolvedConfigInterfaceName(entry.nodeType)};`
    ),
    "};",
  ].join("\n");

  return [
    `export type GeneratedWorkflowNodeType =\n${nodeTypeUnion};`,
    "",
    ...interfaceBlocks.flatMap((block) => [block, ""]),
    mapBlock,
    "",
    "export type GeneratedWorkflowNodeResolvedConfig<T extends GeneratedWorkflowNodeType> =",
    "  GeneratedWorkflowNodeResolvedConfigMap[T];",
  ];
}

function buildGeneratedModuleSource(
  entries: WorkflowNodeConfigAuthoring[],
  fieldImportPath: string,
): string {
  const serialized = buildEntrySerialized(entries);

  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/config/authoring/workflow-nodes/**/*.yaml",
    "// Do not edit manually.",
    "",
    `import type { Field, LocalizedText } from "${fieldImportPath}";`,
    "",
    "export type GeneratedWorkflowNodeConfigEntry = {",
    "  nodeType: string;",
    "  category: string;",
    "  label: LocalizedText;",
    "  description?: LocalizedText;",
    "  configFields: Field[];",
    "  outputFields?: Field[];",
    "};",
    "",
    `export const generatedWorkflowNodeConfigs: GeneratedWorkflowNodeConfigEntry[] = ${serialized};`,
    "",
    "export const generatedWorkflowNodeConfigMap: Record<string, GeneratedWorkflowNodeConfigEntry> =",
    "  Object.fromEntries(generatedWorkflowNodeConfigs.map((entry) => [entry.nodeType, entry]));",
    "",
  ].join("\n");
}

function buildCatalogChecksum(entries: WorkflowNodeConfigAuthoring[]): string {
  return createHash("sha256").update(buildEntrySerialized(entries)).digest("hex");
}

function buildApiCatalogSource(
  entries: WorkflowNodeConfigAuthoring[],
  checksum: string,
): string {
  return [
    "// Generated by OpenShapeForge Service Compiler.",
    "// Source of truth: packages/compiler/config/authoring/workflow-nodes/**/*.yaml",
    "// Do not edit manually.",
    "//",
    "// NOTE: the catalog DATA now lives in Postgres",
    "// (platform.workflow_node_catalog_entries) and is read at runtime via the",
    "// Redis-cached node-catalog loader. This module only emits TYPES plus the",
    "// checksum that keys the cache and gates the seed. See node-catalog.seed.json.",
    "",
    "export type GeneratedWorkflowNodeCatalogEntry = {",
    "  nodeType: string;",
    "  category: string;",
    "  label: Record<string, string>;",
    "  description?: Record<string, string>;",
    "  configFields: unknown[];",
    "  outputFields?: unknown[];",
    "};",
    "",
    ...buildResolvedConfigTypes(entries),
    "",
    `export const workflowNodeCatalogChecksum = ${JSON.stringify(checksum)};`,
    "",
  ].join("\n");
}

function buildNodeCatalogSeedData(
  entries: WorkflowNodeConfigAuthoring[],
  checksum: string,
): string {
  return JSON.stringify({
    checksum,
    catalog: "standard",
    entries: entries.map((entry) => ({
      nodeType: entry.nodeType,
      category: entry.category,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      configFields: entry.configFields,
      ...(entry.outputFields ? { outputFields: entry.outputFields } : {}),
    })),
  });
}

export function generateWorkflowNodeConfigArtifacts(
  authoringDir: string,
): Map<string, string> {
  const files = new Map<string, string>();

  // Best-effort discovery: if the authoring dir doesn't exist yet, emit empty files
  // so downstream consumers always have an importable module.
  let entries: WorkflowNodeConfigAuthoring[] = [];
  const rootDir = join(authoringDir, "workflow-nodes");
  if (existsSync(rootDir) && statSync(rootDir).isDirectory()) {
    entries = loadWorkflowNodeConfigs(authoringDir);
  }

  // Enrich every workflow-node config field whose `semanticType` is a known
  // entity-ID key (e.g. `surveyId`, `relationId`) with the designer's remote
  // option metadata — single source of truth rule: authors never have to
  // restate picker URLs or component choices in workflow-node YAMLs. The
  // catalog (entries with `kind: entityId`) is the source.
  const semanticTypes = loadWorkflowNodeSemanticTypes(authoringDir);
  entries = entries.map((entry) => ({
    ...entry,
    configFields: enrichFieldsWithEntityIdRemoteOptions(semanticTypes, entry.configFields),
    outputFields: entry.outputFields
      ? enrichFieldsWithEntityIdRemoteOptions(semanticTypes, entry.outputFields)
      : undefined,
  }));

  // Workflow runtime: import Field from relative path.
  files.set(
    "workflow/generated/workflow-nodes.generated.ts",
    buildGeneratedModuleSource(entries, "../contract/node-field-contract"),
  );

  // Web-client designer: import Field from shared generated contract alias.
  files.set(
    "features/workflow/lib/nodes/generated/workflow-nodes.generated.ts",
    buildGeneratedModuleSource(entries, "@/generated/compiler/field-contract"),
  );

  const catalogChecksum = buildCatalogChecksum(entries);
  files.set("api/workflow/node-catalog.ts", buildApiCatalogSource(entries, catalogChecksum));
  files.set(
    "api/workflow/node-catalog.seed.json",
    buildNodeCatalogSeedData(entries, catalogChecksum),
  );

  return files;
}
