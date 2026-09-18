// SPDX-License-Identifier: BUSL-1.1
/**
 * The type axis itself: every field definition names one `osfType`.
 *
 * `semanticType` is renamed in place. A field that only had `valueType` gets
 * that value as its `osfType` (the seven base types are osf types). An
 * authored `valueType` beside a semantic type is dropped: the catalog entry
 * already declares the base. Runs over the whole document — entity fields,
 * nested children/item/shape, catalog shapes, workflow-node and connector
 * fields — because they all share the FieldDefinition contract. A map counts
 * as a field when it has a `key` and one of the type properties.
 */
import type { Document, Pair, Scalar, YAMLMap } from "yaml";
import { findPair, yaml } from "./corpus.ts";

export interface RenameReport {
  renamed: number;
  derivedFromValueType: number;
  valueTypesDropped: number;
  /** Files left alone because they are data, not compiler definitions. */
  skipped: string[];
  /** Type catalogs moved to `osf-types.yaml` / `kind: osfTypeCatalog`. */
  catalogs: string[];
}

/**
 * The catalog that defines the types is the OSF type catalog: its file is
 * `osf-types.yaml`, its kind `osfTypeCatalog`, and a document key
 * `semanticTypes:` (a registry or profile that groups them) is `osfTypes:`.
 */
export function renameTypeCatalog(file: { path: string; kind: string | undefined; doc: Document; renameTo?: string }, report: RenameReport): void {
  const root = file.doc.contents;
  if (!yaml.isMap(root)) return;
  const kind = findPair(root as YAMLMap, "kind");
  let touched = false;
  if (kind && yaml.isScalar(kind.value) && kind.value.value === "semanticTypeCatalog") {
    kind.value.value = "osfTypeCatalog";
    file.kind = "osfTypeCatalog";
    touched = true;
  }
  if (/(^|\/)semantic-types\.ya?ml$/.test(file.path)) {
    file.renameTo = file.path.replace(/semantic-types(\.ya?ml)$/, "osf-types$1");
    touched = true;
  }
  const renameKeys = (node: unknown): void => {
    if (yaml.isSeq(node)) { for (const item of node.items) renameKeys(item); return; }
    if (!yaml.isMap(node)) return;
    for (const pair of (node as YAMLMap).items as Pair[]) {
      if (yaml.isScalar(pair.key) && pair.key.value === "semanticTypes") { pair.key.value = "osfTypes"; touched = true; }
      renameKeys(pair.value);
    }
  };
  renameKeys(root);
  if (touched) report.catalogs.push(file.path);
}

/** Document kinds whose fields are compiler FieldDefinitions. */
export const DEFINITION_KINDS: ReadonlySet<string> = new Set([
  "coreEntity", "baseEntity", "entityPatch", "entityProfile", "semanticTypeCatalog", "osfTypeCatalog", "workflowNode",
  "connector", "view", "operationCatalog", "settingsDefinition", "settingsProvider", "fieldAuthoringProfileCatalog",
  "preferenceDefinitions",
]);

const DEFINITION_DIRECTORIES = /\/authoring\/(entities|catalogs|views|operations|connectors|workflow-nodes|domain-workflow-nodes|contexts)\//;

/**
 * Only compiler definitions are renamed. Seed and fixture files carry other
 * vocabularies as data (an integration's own field definitions, sample
 * rows) and keep `valueType`/`semanticType` unless `--include-seeds` asks.
 */
export function isDefinitionDocument(file: { path: string; kind: string | undefined }, includeSeeds = false): boolean {
  if (includeSeeds) return true;
  if (file.kind && DEFINITION_KINDS.has(file.kind)) return true;
  return DEFINITION_DIRECTORIES.test(`/${file.path}`);
}

const BASE_TYPES = new Set(["string", "integer", "number", "boolean", "date", "datetime", "object"]);

function isFieldMap(map: YAMLMap): boolean {
  return Boolean(findPair(map, "key")) && Boolean(findPair(map, "semanticType") || findPair(map, "valueType"));
}

function renameField(field: YAMLMap, report: RenameReport): void {
  const semantic = findPair(field, "semanticType");
  const value = findPair(field, "valueType");
  const osf = findPair(field, "osfType");
  if (semantic) {
    (semantic.key as Scalar).value = "osfType";
    report.renamed += 1;
  }
  if (value && (semantic || osf)) {
    field.items.splice(field.items.indexOf(value), 1);
    report.valueTypesDropped += 1;
  } else if (value) {
    const base = String((value.value as Scalar).value);
    if (!BASE_TYPES.has(base)) throw new Error(`field ${String((findPair(field, "key")!.value as Scalar).value)}: valueType ${base} is not a base type.`);
    (value.key as Scalar).value = "osfType";
    report.derivedFromValueType += 1;
    report.valueTypesDropped += 1;
  }
}

export function renameTypeAxis(node: unknown, report: RenameReport): void {
  if (yaml.isMap(node)) {
    const map = node as YAMLMap;
    if (isFieldMap(map)) renameField(map, report);
    // Catalog entries keep `valueType` untouched: they have no `key`, and
    // their base is what the compiler derives a field's baseType from.
    for (const pair of map.items as Pair[]) renameTypeAxis(pair.value, report);
  } else if (yaml.isSeq(node)) {
    for (const item of node.items) renameTypeAxis(item, report);
  }
}
