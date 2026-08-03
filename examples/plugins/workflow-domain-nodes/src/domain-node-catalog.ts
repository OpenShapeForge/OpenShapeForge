// SPDX-License-Identifier: BUSL-1.1
/**
 * Domain workflow-node catalog generator.
 *
 * Reads the node-config YAMLs under `<authoringDir>/domain-workflow-nodes/**` and
 * emits one document: the seed for the `catalog = 'domain'` slice of
 * `platform.workflow_node_catalog_entries`.
 *
 * **The directory name is the boundary.** Every plugin's `authoring/` tree is
 * appended as a layer and all layers merge into one build directory, which
 * erases which plugin contributed which file. The workflow plugin's generator
 * globs `workflow-nodes/` recursively and unfiltered, so a shared directory name
 * would put every one of these packs straight back into the standard catalog —
 * the one thing this split exists to prevent. Disjoint top-level names are what
 * keep the two catalogs apart, and nothing downstream can recover the
 * distinction once the trees have merged.
 *
 * Validation is the same shallow structural check the standard catalog applies:
 * `kind`, the required top-level shape, a unique `nodeType`, and a `key` plus a
 * known `valueType` on every field. It is deliberately not a full schema
 * validation — it exists so a malformed YAML fails here, naming the file, rather
 * than as an unreadable seed row or a runtime lookup that answers nonsense.
 *
 * **No TypeScript module is emitted alongside the seed**, unlike the standard
 * catalog. That module carries per-node resolved-config interfaces and a
 * node-type union, and its only importer is the workflow plugin's
 * `runtime/generated-node-bridge.ts`, which uses them to type a bridge handler.
 * These node types are deliberately unbridged (see `runtime.ts`), so the types
 * would have no consumer; the catalog DATA is read from Postgres at boot, not
 * imported. A module nobody imports is a second copy of the catalog that can
 * drift from the table without anything noticing.
 *
 * Determinism: the file walk sorts, the semantic-type merge sorts, key order is
 * fixed by object literals, and nothing reads the clock or the environment.
 * `check:generated` runs generation twice and byte-compares.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  Field,
  LocalizedText,
  SemanticTypeDefinition,
} from "../../../../packages/compiler/src/authoring/types.js";
import { enrichFieldsWithEntityIdOptions, loadSemanticTypes } from "./semantic-type-options.js";

/** The authoring subtree this plugin owns; see the note on the boundary above. */
const AUTHORING_SUBDIR = "domain-workflow-nodes";

/**
 * The `catalog` column value every emitted row carries. `runtime.ts` holds the
 * same literal and refuses a document that disagrees, which is how the two
 * halves stay in step without the API-side module importing this generator.
 */
const CATALOG = "domain";

/** File name within the plugin's generated root; `index.ts` supplies the root. */
export const DOMAIN_NODE_CATALOG_SEED_FILE = "node-catalog.seed.json";

type DomainWorkflowNodeConfig = {
  nodeType: string;
  category: string;
  label: LocalizedText;
  description?: LocalizedText;
  configFields: Field[];
  outputFields?: Field[];
};

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
 * Sorted on the flattened result rather than per directory, so the order is a
 * property of the path set and not of how the filesystem happens to return
 * directory entries.
 */
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
        `Domain workflow-node authoring file ${filePath} (${nodeType}) has a non-object field at ${location}.`,
      );
    }
    const record = field as Record<string, unknown>;
    if (typeof record.key !== "string" || record.key.length === 0) {
      throw new Error(
        `Domain workflow-node authoring file ${filePath} (${nodeType}) has a field at ${location} missing a non-empty "key".`,
      );
    }
    if (typeof record.valueType !== "string" || !FIELD_VALUE_TYPES.has(record.valueType)) {
      throw new Error(
        `Domain workflow-node authoring file ${filePath} (${nodeType}) field "${record.key}" (${location}) has an invalid "valueType" (${
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

function validateNodeConfig(parsed: unknown, filePath: string): DomainWorkflowNodeConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Domain workflow-node authoring file ${filePath} is not a YAML mapping.`);
  }

  const node = parsed as Record<string, unknown>;
  if (node.kind !== "workflowNode") {
    throw new Error(
      `Domain workflow-node authoring file ${filePath} has unexpected kind "${
        typeof node.kind === "string" ? node.kind : "<none>"
      }".`,
    );
  }
  if (typeof node.nodeType !== "string" || node.nodeType.length === 0) {
    throw new Error(
      `Domain workflow-node authoring file ${filePath} is missing a non-empty "nodeType".`,
    );
  }
  if (typeof node.category !== "string" || node.category.length === 0) {
    throw new Error(
      `Domain workflow-node authoring file ${filePath} (${node.nodeType}) is missing a non-empty "category".`,
    );
  }
  if (!node.label || typeof node.label !== "object") {
    throw new Error(
      `Domain workflow-node authoring file ${filePath} (${node.nodeType}) is missing a "label" object.`,
    );
  }
  if (!Array.isArray(node.configFields)) {
    throw new Error(
      `Domain workflow-node authoring file ${filePath} (${node.nodeType}) is missing a "configFields" array.`,
    );
  }
  if (node.outputFields !== undefined && !Array.isArray(node.outputFields)) {
    throw new Error(
      `Domain workflow-node authoring file ${filePath} (${node.nodeType}) has a non-array "outputFields".`,
    );
  }

  validateFields(node.configFields, filePath, node.nodeType, "configFields");
  if (Array.isArray(node.outputFields)) {
    validateFields(node.outputFields, filePath, node.nodeType, "outputFields");
  }

  const config: DomainWorkflowNodeConfig = {
    nodeType: node.nodeType,
    category: node.category,
    label: node.label as LocalizedText,
    configFields: node.configFields as Field[],
  };
  if (node.description !== undefined) {
    config.description = node.description as LocalizedText;
  }
  if (node.outputFields !== undefined) {
    config.outputFields = node.outputFields as Field[];
  }
  return config;
}

/**
 * A duplicate `nodeType` is refused rather than last-wins: the seed's rows are
 * keyed on it, so two files claiming one type would silently drop one of them.
 */
function loadNodeConfigs(rootDir: string): DomainWorkflowNodeConfig[] {
  const entries: DomainWorkflowNodeConfig[] = [];
  const seenNodeTypes = new Map<string, string>();

  for (const filePath of collectYamlFiles(rootDir)) {
    const config = validateNodeConfig(parseYaml(readFileSync(filePath, "utf-8")), filePath);

    const priorFile = seenNodeTypes.get(config.nodeType);
    if (priorFile) {
      throw new Error(
        `Domain workflow-node authoring files ${priorFile} and ${filePath} both declare nodeType "${config.nodeType}"; nodeType must be unique.`,
      );
    }
    seenNodeTypes.set(config.nodeType, filePath);

    entries.push(config);
  }

  return entries;
}

function enrichEntry(
  entry: DomainWorkflowNodeConfig,
  semanticTypes: Map<string, SemanticTypeDefinition>,
): DomainWorkflowNodeConfig {
  const enriched: DomainWorkflowNodeConfig = {
    ...entry,
    configFields: enrichFieldsWithEntityIdOptions(entry.configFields, semanticTypes),
  };
  if (entry.outputFields) {
    enriched.outputFields = enrichFieldsWithEntityIdOptions(entry.outputFields, semanticTypes);
  }
  return enriched;
}

/**
 * Optional properties are omitted rather than set to null, so a row round-trips
 * through the seed and back out of jsonb as the author wrote it. Key order is
 * fixed by this literal, which is half of why the output is byte-stable.
 */
function toSeedEntry(entry: DomainWorkflowNodeConfig): Record<string, unknown> {
  return {
    nodeType: entry.nodeType,
    category: entry.category,
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
    configFields: entry.configFields,
    ...(entry.outputFields ? { outputFields: entry.outputFields } : {}),
  };
}

function buildSeedDocument(entries: DomainWorkflowNodeConfig[]): string {
  const seedEntries = entries.map(toSeedEntry);
  // The checksum covers the entries alone, not the wrapper. It is written to
  // every row's `catalog_checksum` and compared there to decide whether a
  // migrate can skip the slice, so it has to describe exactly what was written
  // and nothing else — folding in `catalog` would make it disagree with itself
  // if the slice name ever moved.
  const checksum = createHash("sha256").update(JSON.stringify(seedEntries)).digest("hex");
  return JSON.stringify({ checksum, catalog: CATALOG, entries: seedEntries });
}

/**
 * Keyed by file name within the plugin's generated root, so the generator owns
 * what it calls its output and `index.ts` owns where that root is.
 *
 * The seed is emitted even when the authoring subtree is absent — a host repo
 * that registered the plugin without its layer, or a layer not yet staged. An
 * absent document and an empty one are different facts to `db:migrate`: only
 * the second one clears the rows a previous build left behind.
 */
export function generateDomainNodeCatalogArtifacts(authoringDir: string): Map<string, string> {
  const entries = loadNodeConfigs(join(authoringDir, AUTHORING_SUBDIR));
  const semanticTypes = loadSemanticTypes(authoringDir);
  const enriched = entries.map((entry) => enrichEntry(entry, semanticTypes));

  return new Map([[DOMAIN_NODE_CATALOG_SEED_FILE, buildSeedDocument(enriched)]]);
}
