// SPDX-License-Identifier: BUSL-1.1
/**
 * Folds authored inverse collections into `relationship.inverse` on the
 * referencing field, and declares `inverse: false` where several references
 * to one entity would otherwise leave the derivation ambiguous.
 *
 * An authored collection is a field with an entity `osfType`/`semanticType`,
 * a collection cardinality and `relationship.inverse: <key>`. Its key, label
 * and collection policy are written on the referencing field only when they
 * differ from what the compiler derives, so the compiled artifacts stay the
 * same while the YAML says less. A `via` collection is a traversal without a
 * foreign key of its own and stays authored.
 */
import type { YAMLMap } from "yaml";
import { defaultInverseKey, defaultInverseLabel } from "../../packages/compiler/src/authoring/inverse-collections.ts";
import {
  type Corpus, type CorpusFile, type EntityRef,
  deletePair, entitiesOf, findFieldByKey, findPair, getMap, getSeq, getString, insertPair, plainEqual, toPlain, yaml,
} from "./corpus.ts";

export interface FoldReport {
  collectionsFolded: string[];
  ambiguityDeclared: string[];
  errors: string[];
}

const TYPE_KEYS = ["osfType", "semanticType"] as const;

export function fieldType(field: YAMLMap): string | undefined {
  for (const key of TYPE_KEYS) {
    const value = getString(field, key);
    if (value) return value;
  }
  return undefined;
}

export function isCollection(field: YAMLMap): boolean {
  const cardinality = field.get("cardinality", true);
  if (yaml.isScalar(cardinality)) return cardinality.value === "collection";
  if (yaml.isMap(cardinality)) {
    const max = getString(cardinality as YAMLMap, "max");
    return max === "unbounded" || (max !== undefined && Number(max) > 1);
  }
  return false;
}

export function isValueDefinition(root: YAMLMap): boolean {
  const base = root.get("baseEntity", true);
  return yaml.isScalar(base) && base.value === false && !findFieldByKey(root, "id");
}

export function entityLabels(entity: EntityRef): unknown {
  const labels = entity.root.get("labels", true);
  if (labels) return toPlain(labels);
  return { en: getString(entity.root, "title") ?? entity.name };
}

/** The label a derived inverse collection would carry: the child's plural labels. */
function derivedCollectionLabel(entity: EntityRef): unknown {
  const labels = entity.root.get("labels", true);
  const pluralLabels = entity.root.get("pluralLabels", true);
  return defaultInverseLabel({
    entity: entity.name,
    labels: labels ? (toPlain(labels) as Record<string, string>) : undefined,
    pluralLabels: pluralLabels ? (toPlain(pluralLabels) as Record<string, string>) : undefined,
    title: getString(entity.root, "title"),
  });
}

/** `relationship:` on a field, created in the conventional trailing position. */
function relationshipMap(field: YAMLMap): YAMLMap {
  const existing = getMap(field, "relationship");
  if (existing) return existing;
  const map = new yaml.YAMLMap();
  field.items.push(new yaml.Document().createPair("relationship", map));
  return map;
}

/**
 * The inverse declaration for one authored collection: only what differs
 * from the derived default.
 */
export function inverseDeclaration(collection: YAMLMap, child: EntityRef): Record<string, unknown> {
  const declaration: Record<string, unknown> = {};
  const key = getString(collection, "key")!;
  if (key !== defaultInverseKey(child.name)) declaration.key = key;
  const label = collection.get("label", true);
  if (label && !plainEqual(toPlain(label), derivedCollectionLabel(child))) declaration.label = toPlain(label);
  const relationship = getMap(collection, "relationship");
  if (relationship && getString(relationship, "ownership") === "owned") declaration.ownership = "owned";
  const sortable = collection.get("sortable", true);
  if (yaml.isScalar(sortable) && sortable.value === true) declaration.sortable = true;
  const childAuthorization = getString(collection, "childAuthorization");
  if (childAuthorization) declaration.childAuthorization = childAuthorization;
  const allowed = getSeq(collection, "allowedDefinitions");
  if (allowed) declaration.allowedDefinitions = toPlain(allowed);
  return declaration;
}

export function foldAuthoredCollections(corpus: Corpus, file: CorpusFile, report: FoldReport): void {
  if (file.kind !== "coreEntity" || !yaml.isMap(file.doc.contents)) return;
  const root = file.doc.contents as YAMLMap;
  const owner = getString(root, "entity")!;
  const entities = entitiesOf(corpus, file);
  const fields = getSeq(root, "fields");
  if (!fields) return;
  for (let index = fields.items.length - 1; index >= 0; index -= 1) {
    const item = fields.items[index];
    if (!yaml.isMap(item)) continue;
    const collection = item as YAMLMap;
    const type = fieldType(collection);
    const child = type ? entities.get(type) : undefined;
    if (!child || !isCollection(collection)) continue;
    const relationship = getMap(collection, "relationship");
    const inverse = relationship ? getString(relationship, "inverse") : undefined;
    if (!inverse || (relationship && getString(relationship, "via"))) continue;
    const key = getString(collection, "key")!;
    const reference = findFieldByKey(child.root, inverse);
    if (!reference || fieldType(reference) !== owner || isCollection(reference)) {
      report.errors.push(`${owner}.${key}: inverse ${type}.${inverse} is not a single reference to ${owner}.`);
      continue;
    }
    const unknown = collection.items.map((pair) => String((pair.key as { value: unknown }).value))
      .filter((name) => !["key", "label", "osfType", "semanticType", "cardinality", "relationship", "sortable", "childAuthorization", "allowedDefinitions", "description"].includes(name));
    if (unknown.length) {
      report.errors.push(`${owner}.${key}: collection carries ${unknown.join(", ")}, which the inverse declaration cannot express.`);
      continue;
    }
    const referenceRelationship = relationshipMap(reference);
    const existing = findPair(referenceRelationship, "inverse");
    if (existing) {
      report.errors.push(`${type}.${inverse} already declares an inverse; ${owner}.${key} cannot be folded onto it.`);
      continue;
    }
    const declaration = inverseDeclaration(collection, child);
    if (Object.keys(declaration).length) insertPair(referenceRelationship, "inverse", declaration, ["ownership"]);
    fields.items.splice(index, 1);
    report.collectionsFolded.push(`${owner}.${key} -> ${type}.${inverse}${Object.keys(declaration).length ? ` ${JSON.stringify(declaration)}` : ""}`);
  }
}

/** Several single references to one entity: each declares its inverse, or none. */
export function declareAmbiguousInverses(corpus: Corpus, file: CorpusFile, report: FoldReport): void {
  if (file.kind !== "coreEntity" || !yaml.isMap(file.doc.contents)) return;
  const root = file.doc.contents as YAMLMap;
  if (isValueDefinition(root)) return;
  const owner = getString(root, "entity")!;
  const entities = entitiesOf(corpus, file);
  const groups = new Map<string, YAMLMap[]>();
  for (const item of getSeq(root, "fields")?.items ?? []) {
    if (!yaml.isMap(item)) continue;
    const field = item as YAMLMap;
    const type = fieldType(field);
    if (!type || !entities.has(type) || isCollection(field)) continue;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(field);
  }
  for (const [target, references] of groups) {
    if (references.length < 2) continue;
    for (const field of references) {
      const relationship = getMap(field, "relationship");
      if (relationship && findPair(relationship, "inverse")) continue;
      insertPair(relationshipMap(field), "inverse", false, ["ownership"]);
      report.ambiguityDeclared.push(`${owner}.${getString(field, "key")} -> ${target}`);
    }
  }
}

/** Removes an empty `relationship: {}` left behind by earlier edits. */
export function pruneEmptyRelationship(field: YAMLMap): void {
  const relationship = getMap(field, "relationship");
  if (relationship && relationship.items.length === 0) deletePair(field, "relationship");
}
