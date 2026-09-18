// SPDX-License-Identifier: BUSL-1.1
/**
 * Inverse collections are derived, never authored.
 *
 * A single entity reference (`osfType: <Entity>`) on entity A gives the target
 * entity a collection of A records. The referencing field may shape that
 * collection through `relationship.inverse`: an object overrides the derived
 * key, label and collection policy; `false` declines the collection. When
 * several fields of one entity reference the same target, nothing is derived
 * by default and each field has to choose, so a collection never silently
 * follows the wrong foreign key.
 *
 * The one authored collection form that remains is the read-only `via`
 * traversal, which has no single foreign key of its own to derive from.
 */
import type { Field, LocalizedText } from "./types.js";
import type { FieldDefinitionInverseCollection } from "./types/field-definition.js";
import { fieldCardinality, pluralize, uncapitalize } from "./compiler/helpers.js";

export interface InverseCollectionSource {
  entity: string;
  labels?: LocalizedText | undefined;
  title?: string | undefined;
  fields: readonly Field[];
  /** Value definitions store no rows of their own, so nothing can point back at them. */
  valueDefinition?: boolean;
}

/** `AgreementParty` -> `agreementParties`. */
export function defaultInverseKey(childEntity: string): string {
  return pluralize(uncapitalize(childEntity));
}

/** The child entity's own labels; a plural form is an authored override. */
export function defaultInverseLabel(child: Pick<InverseCollectionSource, "entity" | "labels" | "title">): LocalizedText {
  return child.labels ?? { en: child.title ?? child.entity };
}

/**
 * Fields of `source` that are single references to `target`, i.e. the fields
 * whose inverse collections live on `target`.
 */
export function singleReferencesTo(
  source: InverseCollectionSource,
  target: string,
  isEntityType: (osfType: string) => boolean,
): Field[] {
  if (source.valueDefinition) return [];
  return source.fields.filter((field) =>
    field.osfType === target && isEntityType(field.osfType) && fieldCardinality(field) === "single",
  );
}

export function deriveInverseCollection(
  source: InverseCollectionSource,
  field: Field,
  declaration: FieldDefinitionInverseCollection | undefined,
): Field {
  const derived: Field = {
    key: declaration?.key ?? defaultInverseKey(source.entity),
    label: declaration?.label ?? defaultInverseLabel(source),
    osfType: source.entity,
    cardinality: "collection",
    ...(declaration?.sortable ? { sortable: true } : {}),
    ...(declaration?.childAuthorization ? { childAuthorization: declaration.childAuthorization } : {}),
    ...(declaration?.allowedDefinitions ? { allowedDefinitions: [...declaration.allowedDefinitions] } : {}),
    relationship: { inverse: field.key, ownership: declaration?.ownership ?? "reference" },
  };
  return derived;
}

/**
 * Every collection `target` receives from the given sources, sorted by key so
 * the result does not depend on entity load order.
 */
export function deriveInverseCollections(
  target: string,
  sources: Iterable<InverseCollectionSource>,
  isEntityType: (osfType: string) => boolean,
): Field[] {
  const derived: Field[] = [];
  for (const source of sources) {
    const references = singleReferencesTo(source, target, isEntityType);
    const ambiguous = references.length > 1;
    for (const field of references) {
      const declaration = field.relationship?.inverse;
      if (declaration === false) continue;
      if (typeof declaration === "string") {
        throw new Error(`${source.entity}.${field.key}: a single reference names its inverse collection as an object ({ key, label }), not as a field key.`);
      }
      if (ambiguous && !declaration) {
        throw new Error(
          `${source.entity}: fields ${references.map((candidate) => candidate.key).join(", ")} all reference ${target}; ` +
          `declare relationship.inverse ({ key } or false) on each so the derived collections on ${target} are unambiguous.`,
        );
      }
      derived.push(deriveInverseCollection(source, field, declaration));
    }
  }
  derived.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let index = 1; index < derived.length; index += 1) {
    if (derived[index]!.key === derived[index - 1]!.key) {
      throw new Error(`${target}.${derived[index]!.key}: inverse collections from ${derived[index - 1]!.osfType} and ${derived[index]!.osfType} collide; give one an explicit inverse key.`);
    }
  }
  return derived;
}

/** A field that already carries a derived collection, so a second pass adds nothing. */
export function matchesDerivedCollection(existing: Field, derived: Field): boolean {
  return existing.osfType === derived.osfType &&
    fieldCardinality(existing) === "collection" &&
    existing.relationship?.inverse === derived.relationship?.inverse;
}

/**
 * Appends the derived collections to `fields`. An authored field with a
 * derived key is a collision unless it is the same derived collection from an
 * earlier normalization pass.
 */
export function withInverseCollections(entity: string, fields: readonly Field[], derived: readonly Field[]): Field[] {
  const result = [...fields];
  for (const collection of derived) {
    const existing = result.find((field) => field.key === collection.key);
    if (!existing) {
      result.push(collection);
      continue;
    }
    if (!matchesDerivedCollection(existing, collection)) {
      throw new Error(`${entity}.${collection.key}: an authored field collides with the inverse collection derived from ${collection.osfType}.${collection.relationship!.inverse}; rename one or declare relationship.inverse on the referencing field.`);
    }
  }
  return result;
}
