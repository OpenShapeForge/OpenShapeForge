// SPDX-License-Identifier: BUSL-1.1
/**
 * Folds a legacy entity-level `relationships:` block into fields.
 *
 * - `belongsTo` becomes (or updates) the field that persists its foreign key.
 *   A missing field is created — key `<relationship key>Id`, the target as
 *   type, the column as storage — with `required` taken from the baseline
 *   storage manifest's nullability when one is given, and `false` (reported)
 *   otherwise. `--strict` refuses to create fields instead.
 * - `hasMany` is deleted; when its key or label differs from the derived
 *   default the referencing field on the target gets `relationship.inverse`.
 *   A `hasMany` with `via` stays an authored traversal collection.
 * - `manyToMany` is refused: it is never authored.
 */
import type { Pair, YAMLMap, YAMLSeq } from "yaml";
import { defaultInverseKey } from "../../packages/compiler/src/authoring/inverse-collections.ts";
import {
  type Corpus, type CorpusFile, type EntityRef,
  deletePair, entitiesOf, findFieldByColumn, findPair, getMap, getSeq, getString, insertPair, pairKey, plainEqual, toPlain, yaml,
} from "./corpus.ts";
import { derivedCollectionLabel, entityLabels } from "./inverse-fold.ts";

export interface LegacyFoldOptions {
  strict?: boolean;
  /** `true` when the baseline storage emitted the column NOT NULL; `undefined` when unknown. */
  columnRequired?: (entity: string, column: string) => boolean | undefined;
}

export interface LegacyFoldReport {
  belongsToFolded: string[];
  fieldsCreated: { entity: string; key: string; column: string; required: boolean; provenance: "baseline" | "unknown" }[];
  hasManyRemoved: string[];
  errors: string[];
}

const FIELD_KEY_ORDER = ["key", "osfType", "semanticType", "valueType", "required", "immutable", "defaultValue", "writtenBy"];

function lowerCamel(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function siblingStorageClass(root: YAMLMap): string {
  for (const item of getSeq(root, "fields")?.items ?? []) {
    if (!yaml.isMap(item)) continue;
    const persisted = getMap(item as YAMLMap, "persisted");
    const storageClass = persisted && getString(persisted, "storageClass");
    if (storageClass) return storageClass;
  }
  return "core";
}

/** The comment above a relationship entry becomes the created field's description. */
function entryComment(entry: YAMLMap, relationships: YAMLSeq, index: number): string | undefined {
  const raw = (index === 0 ? relationships.commentBefore : undefined) ?? entry.commentBefore ?? undefined;
  const text = raw?.split("\n").map((line) => line.replace(/^\s?#?\s?/, "").trim()).filter(Boolean).join(" ");
  return text || undefined;
}

function createBelongsToField(
  entity: EntityRef, entry: YAMLMap, relationships: YAMLSeq, index: number, options: LegacyFoldOptions, report: LegacyFoldReport,
): YAMLMap {
  const relationshipKey = getString(entry, "key")!;
  const target = getString(entry, "target")!;
  const column = getString(entry, "foreignKey")!;
  const key = `${lowerCamel(relationshipKey)}Id`;
  const baseline = options.columnRequired?.(entity.name, column);
  const required = baseline ?? false;
  const language = getString(entity.root, "language") ?? "en";
  const comment = entryComment(entry, relationships, index);
  const field = new yaml.YAMLMap();
  const doc = new yaml.Document();
  const push = (name: string, value: unknown) => field.items.push(doc.createPair(name, value) as Pair);
  push("key", key);
  push("osfType", target);
  push("required", required);
  const label = entry.get("label", true);
  if (label) push("label", toPlain(label));
  if (comment) push("description", { [language]: comment });
  push("persisted", { column, storageClass: siblingStorageClass(entity.root) });
  if (comment) field.commentBefore = ` ${comment}`;
  const fields = getSeq(entity.root, "fields") ?? (() => {
    const seq = new yaml.YAMLSeq();
    insertPair(entity.root, "fields", seq, ["schemaVersion", "kind", "module", "entity", "title", "description", "language", "labels", "domains", "displayTemplate", "filterField", "baseEntity", "authorization", "retention", "indexes", "versioning"]);
    return seq;
  })();
  fields.items.push(field);
  report.fieldsCreated.push({ entity: entity.name, key, column, required, provenance: baseline === undefined ? "unknown" : "baseline" });
  return field;
}

export function foldLegacyBelongsTo(corpus: Corpus, file: CorpusFile, options: LegacyFoldOptions, report: LegacyFoldReport): void {
  if (file.kind !== "coreEntity" || !yaml.isMap(file.doc.contents)) return;
  const root = file.doc.contents as YAMLMap;
  const owner = getString(root, "entity")!;
  const entity = entitiesOf(corpus, file).get(owner);
  const relationships = getSeq(root, "relationships");
  if (!entity || !relationships) return;
  for (let index = relationships.items.length - 1; index >= 0; index -= 1) {
    const item = relationships.items[index];
    if (!yaml.isMap(item)) {
      report.errors.push(`${owner}: relationships[${index}] is not a map.`);
      continue;
    }
    const entry = item as YAMLMap;
    const kind = getString(entry, "kind");
    const key = getString(entry, "key") ?? `#${index}`;
    if (kind === "manyToMany") {
      report.errors.push(`${owner}.${key}: manyToMany is never authored; model the junction as an entity with two references.`);
      continue;
    }
    if (kind !== "belongsTo") continue;
    const target = getString(entry, "target");
    const column = getString(entry, "foreignKey");
    if (!target || !column) {
      report.errors.push(`${owner}.${key}: belongsTo needs target and foreignKey.`);
      continue;
    }
    let field = findFieldByColumn(root, column);
    if (!field) {
      if (options.strict) {
        report.errors.push(`${owner}.${key}: no field persists column ${column} (strict mode refuses to create one).`);
        continue;
      }
      field = createBelongsToField(entity, entry, relationships, index, options, report);
    } else {
      deletePair(field, "valueType");
      insertPair(field, "osfType", target, ["key"]);
      deletePair(field, "semanticType");
      const label = entry.get("label", true);
      if (label && !field.has("label")) insertPair(field, "label", toPlain(label), FIELD_KEY_ORDER);
      if (getMap(field, "relationship")?.has("foreignKey")) deletePair(getMap(field, "relationship")!, "foreignKey");
    }
    relationships.items.splice(index, 1);
    const fieldKey = getString(field, "key")!;
    if (fieldKey !== key) renameRelationshipReferences(root, key, fieldKey);
    report.belongsToFolded.push(`${owner}.${key} -> ${owner}.${fieldKey}`);
  }
  if (relationships.items.length === 0) deletePair(root, "relationships");
}

/**
 * Views reference a relationship by key: `layout.context.relationships`,
 * a tab or group's `relationship`, a RelationshipUsage `name`, a timeline
 * include. When a belongsTo relationship becomes a field with another key,
 * every such reference in `interfaces` and the legacy `ui` block follows.
 */
export function renameRelationshipReferences(root: YAMLMap, from: string, to: string): void {
  const visit = (node: unknown, underUsage: boolean): void => {
    if (yaml.isSeq(node)) {
      for (const item of node.items) {
        if (yaml.isScalar(item) && item.value === from && underUsage) item.value = to;
        else visit(item, underUsage);
      }
      return;
    }
    if (!yaml.isMap(node)) return;
    for (const pair of (node as YAMLMap).items as Pair[]) {
      const key = pairKey(pair);
      if (key === "relationship" && yaml.isScalar(pair.value) && pair.value.value === from) pair.value.value = to;
      else if (key === "relationship" && yaml.isMap(pair.value)) renameUsage(pair.value as YAMLMap, from, to);
      else if (key === "relationships") visit(pair.value, true);
      else visit(pair.value, false);
    }
  };
  const renameUsage = (usage: YAMLMap, from: string, to: string) => {
    const name = usage.get("name", true);
    if (yaml.isScalar(name) && name.value === from) name.value = to;
  };
  for (const section of ["interfaces", "ui"]) {
    const block = root.get(section, true);
    if (yaml.isMap(block)) {
      visit(block, false);
      // RelationshipUsage objects inside `relationships:` lists carry `name`.
      const walkUsages = (node: unknown): void => {
        if (yaml.isSeq(node)) { for (const item of node.items) walkUsages(item); return; }
        if (!yaml.isMap(node)) return;
        for (const pair of (node as YAMLMap).items as Pair[]) {
          if (pairKey(pair) === "relationships" && yaml.isSeq(pair.value)) {
            for (const item of pair.value.items) if (yaml.isMap(item)) renameUsage(item as YAMLMap, from, to);
          }
          walkUsages(pair.value);
        }
      };
      walkUsages(block);
    }
  }
}

export function foldLegacyHasMany(corpus: Corpus, file: CorpusFile, report: LegacyFoldReport): void {
  if (file.kind !== "coreEntity" || !yaml.isMap(file.doc.contents)) return;
  const root = file.doc.contents as YAMLMap;
  const owner = getString(root, "entity")!;
  const entities = entitiesOf(corpus, file);
  const ownerRef = entities.get(owner);
  const relationships = getSeq(root, "relationships");
  if (!ownerRef || !relationships) return;
  for (let index = relationships.items.length - 1; index >= 0; index -= 1) {
    const item = relationships.items[index];
    if (!yaml.isMap(item)) continue;
    const entry = item as YAMLMap;
    if (getString(entry, "kind") !== "hasMany") continue;
    const key = getString(entry, "key") ?? `#${index}`;
    const target = getString(entry, "target");
    const column = getString(entry, "foreignKey");
    const child = target ? entities.get(target) : undefined;
    if (!child || !column) {
      report.errors.push(`${owner}.${key}: hasMany needs a loaded target and foreignKey.`);
      continue;
    }
    const reference = findFieldByColumn(child.root, column);
    if (!reference) {
      report.errors.push(`${owner}.${key}: ${target} has no field persisting ${column}; fold ${target}'s belongsTo first.`);
      continue;
    }
    const via = getString(entry, "via");
    if (via) {
      const local = findFieldByColumn(root, via) ?? (getSeq(root, "fields")?.items.find((candidate) => yaml.isMap(candidate) && getString(candidate as YAMLMap, "key") === via) as YAMLMap | undefined);
      const localKey = local ? getString(local, "key")! : via;
      const collection = { key, ...(entry.has("label") ? { label: toPlain(entry.get("label", true)) } : {}), osfType: target, cardinality: "collection",
        relationship: { inverse: getString(reference, "key"), via: localKey } };
      getSeq(root, "fields")!.items.push(new yaml.Document().createNode(collection));
    } else {
      const declaration: Record<string, unknown> = {};
      if (key !== defaultInverseKey(child.name)) declaration.key = key;
      const label = entry.get("label", true);
      if (label && !plainEqual(toPlain(label), derivedCollectionLabel(ownerRef))) declaration.label = toPlain(label);
      if (Object.keys(declaration).length) {
        const relationship = getMap(reference, "relationship") ?? (() => {
          const map = new yaml.YAMLMap();
          reference.items.push(new yaml.Document().createPair("relationship", map));
          return map;
        })();
        if (findPair(relationship, "inverse")) {
          report.errors.push(`${owner}.${key}: ${target}.${getString(reference, "key")} already declares an inverse.`);
          continue;
        }
        insertPair(relationship, "inverse", declaration, ["ownership"]);
      }
    }
    relationships.items.splice(index, 1);
    report.hasManyRemoved.push(`${owner}.${key}${via ? " (via, kept as traversal field)" : ""}`);
  }
  if (relationships.items.length === 0) deletePair(root, "relationships");
}
