// SPDX-License-Identifier: BUSL-1.1
/**
 * Corpus model for the one-type-axis migration: every YAML file in the
 * repository as an editable `yaml` Document, plus an index of the core
 * entities per authoring root so cross-file passes (inverse collections,
 * legacy relationship blocks) can find the other side of a relationship.
 *
 * Documents are edited in place through the `yaml` node API so comments,
 * key order and quoting survive; only the touched nodes change.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Document, Pair, Scalar, YAMLMap, YAMLSeq } from "yaml";

const requireCompiler = createRequire(new URL("../../packages/compiler/package.json", import.meta.url));
export const yaml: typeof import("yaml") = requireCompiler("yaml");

export interface CorpusFile {
  /** Repository-relative path. */
  path: string;
  source: string;
  /** JSON of the parsed document at load time; the change criterion. */
  semantic: string;
  doc: Document;
  kind: string | undefined;
  /** Authoring root (the parent of `entities/`), when the file is an entity. */
  authoringRoot: string | undefined;
}

export interface EntityRef {
  name: string;
  file: CorpusFile;
  root: YAMLMap;
}

export interface Corpus {
  files: CorpusFile[];
  /** authoringRoot -> entity name -> entity. */
  entities: Map<string, Map<string, EntityRef>>;
}

export const scalarValue = (node: unknown): string | undefined =>
  yaml.isScalar(node) ? String((node as Scalar).value) : undefined;

export function pairKey(pair: Pair): string | undefined {
  return scalarValue(pair.key);
}

export function getMap(map: YAMLMap, key: string): YAMLMap | undefined {
  const value = map.get(key, true);
  return yaml.isMap(value) ? (value as YAMLMap) : undefined;
}

export function getSeq(map: YAMLMap, key: string): YAMLSeq | undefined {
  const value = map.get(key, true);
  return yaml.isSeq(value) ? (value as YAMLSeq) : undefined;
}

export function getString(map: YAMLMap, key: string): string | undefined {
  return scalarValue(map.get(key, true));
}

export function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => pairKey(pair) === key);
}

export function deletePair(map: YAMLMap, key: string): boolean {
  const index = map.items.findIndex((pair) => pairKey(pair) === key);
  if (index < 0) return false;
  map.items.splice(index, 1);
  return true;
}

/**
 * Inserts `key: value` before the first key that is not in `after`, so a new
 * property lands where hand authoring puts it instead of at the end.
 */
export function insertPair(map: YAMLMap, key: string, value: unknown, after: readonly string[]): Pair {
  const existing = findPair(map, key);
  if (existing) {
    existing.value = value;
    return existing;
  }
  const doc = new yaml.Document();
  const pair = doc.createPair(key, value) as Pair;
  let at = map.items.length;
  for (let index = 0; index < map.items.length; index += 1) {
    if (!after.includes(pairKey(map.items[index]!) ?? "")) {
      at = index;
      break;
    }
  }
  map.items.splice(at, 0, pair);
  return pair;
}

/** Plain-object view of a node (labels, option lists) for comparisons. */
export function toPlain(node: unknown): unknown {
  if (yaml.isNode(node) || yaml.isPair(node)) return (node as { toJSON(): unknown }).toJSON();
  return node;
}

export function plainEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function findFieldByKey(root: YAMLMap, key: string): YAMLMap | undefined {
  for (const item of getSeq(root, "fields")?.items ?? []) {
    if (yaml.isMap(item) && getString(item as YAMLMap, "key") === key) return item as YAMLMap;
  }
  return undefined;
}

export function findFieldByColumn(root: YAMLMap, column: string): YAMLMap | undefined {
  for (const item of getSeq(root, "fields")?.items ?? []) {
    if (!yaml.isMap(item)) continue;
    const persisted = getMap(item as YAMLMap, "persisted");
    if (persisted && getString(persisted, "column") === column) return item as YAMLMap;
  }
  return undefined;
}

export function authoringRootOf(path: string): string | undefined {
  const marker = "/entities/";
  const index = path.indexOf(marker);
  return index < 0 ? undefined : path.slice(0, index);
}

function listYamlFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  return [...new Set(output.split("\0"))].filter((path) => /\.ya?ml$/.test(path) && existsSync(join(root, path))).sort();
}

export function loadCorpus(root: string, paths: string[] = listYamlFiles(root)): Corpus {
  const files: CorpusFile[] = [];
  for (const path of paths) {
    const source = readFileSync(join(root, path), "utf8");
    if (path.includes("/templates/") && source.includes("{{-")) continue; // Helm templates are not YAML until rendered.
    const documents = yaml.parseAllDocuments(source);
    if (documents.length !== 1) continue; // Multi-document files carry no authoring; leave them alone.
    const doc = documents[0]!;
    if (doc.errors.length) throw new Error(`${path}: ${doc.errors[0]!.message}`);
    const kind = yaml.isMap(doc.contents) ? getString(doc.contents as YAMLMap, "kind") : undefined;
    files.push({ path, source, semantic: semanticText(doc), doc, kind, authoringRoot: authoringRootOf(path) });
  }
  return { files, entities: indexEntities(files) };
}

export function indexEntities(files: readonly CorpusFile[]): Corpus["entities"] {
  const entities: Corpus["entities"] = new Map();
  for (const file of files) {
    if (file.kind !== "coreEntity" || !file.authoringRoot || !yaml.isMap(file.doc.contents)) continue;
    const root = file.doc.contents as YAMLMap;
    const name = getString(root, "entity");
    if (!name) continue;
    if (!entities.has(file.authoringRoot)) entities.set(file.authoringRoot, new Map());
    const byName = entities.get(file.authoringRoot)!;
    if (byName.has(name)) throw new Error(`${file.path}: entity ${name} is also declared in ${byName.get(name)!.file.path}.`);
    byName.set(name, { name, file, root });
  }
  return entities;
}

export function entitiesOf(corpus: Corpus, file: CorpusFile): Map<string, EntityRef> {
  return (file.authoringRoot && corpus.entities.get(file.authoringRoot)) || new Map();
}

export function semanticText(doc: Document): string {
  return JSON.stringify(doc.toJS());
}

/** Rendering alone can re-wrap long scalars; only a semantic change counts. */
export function fileChanged(file: CorpusFile): boolean {
  return semanticText(file.doc) !== file.semantic;
}

/**
 * The yaml library pads every flow collection or none; hand authoring here
 * pads `{ a: b }` but not `[a, b]`. Follow each file's own majority per
 * bracket kind, and keep the padded rendering when stripping would change
 * what the text means (a bracket inside a quoted string).
 */
function matchFlowPadding(file: CorpusFile, text: string): string {
  let result = text;
  for (const [open, close] of [["[", "]"], ["{", "}"]] as const) {
    const escaped = `\\${open}`;
    const escapedClose = `\\${close}`;
    const padded = (file.source.match(new RegExp(`${escaped} \\S`, "g")) ?? []).length;
    const unpadded = (file.source.match(new RegExp(`${escaped}[^\\s${escapedClose}]`, "g")) ?? []).length;
    if (unpadded <= padded) continue;
    const stripped = result
      .replace(new RegExp(`${escaped} (?=\\S)`, "g"), open)
      .replace(new RegExp(`(?<=\\S) ${escapedClose}`, "g"), close);
    if (semanticText(yaml.parseDocument(stripped)) === semanticText(file.doc)) result = stripped;
  }
  return result;
}

export function renderFile(file: CorpusFile): string {
  // 120 columns reproduces the corpus's own wrapping of long descriptions
  // best; the yaml library does not retain original fold positions.
  return matchFlowPadding(file, file.doc.toString({ lineWidth: 120, flowCollectionPadding: true }));
}
