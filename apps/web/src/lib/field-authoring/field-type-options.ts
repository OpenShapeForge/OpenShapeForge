// SPDX-License-Identifier: BUSL-1.1
/**
 * The options a field-type picker offers, read from the compiled contract:
 * the base value types from the component catalog, the list and the
 * field-definition-collection shapes, and every catalog osf type as a
 * "meaning" refining a base type. Synchronous and complete; a picker
 * narrows by search and by the authoring profile's `excludedFieldTypes`.
 */
import { COMPILER_FIELD_COMPONENT_DEFAULTS } from "@/generated/compiler/component-defaults";
import type { FieldCardinality, LocalizedText, OsfTypeDefinition } from "@/generated/compiler/field-contract";
import { COMPILER_OSF_TYPES } from "@/generated/compiler/osf-types";
import { FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE } from "./compiler-field-types";

export type FieldTypeLang = "nl" | "en";

export type FieldTypeOption = {
  value: string;
  kind: "base" | "semantic";
  label: string;
  description?: string;
  baseType: string;
  valueType: string;
  cardinality?: FieldCardinality;
  osfType?: string;
  icon?: string;
};

export const FIELD_DEFINITION_COLLECTION_VALUE = `semantic:${FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE}:collection`;

const LIST_LABELS: Record<FieldTypeLang, string> = { nl: "Lijst", en: "List" };
const FIELD_DEFINITION_COLLECTION_LABELS: Record<FieldTypeLang, string> = { nl: "Velddefinities", en: "Field definitions" };

function text(label: LocalizedText | undefined, lang: FieldTypeLang, fallback: string): string {
  return label?.[lang] ?? label?.en ?? label?.nl ?? fallback;
}

function baseOptions(lang: FieldTypeLang): FieldTypeOption[] {
  const defaults = COMPILER_FIELD_COMPONENT_DEFAULTS as Record<string, { label?: LocalizedText }>;
  const scalar = Object.keys(defaults)
    // `collection` is a cardinality in the component catalog, not a value type.
    .filter((key) => key !== "collection")
    .map((key): FieldTypeOption => ({ value: key, kind: "base", label: text(defaults[key]?.label, lang, key), baseType: key, valueType: key }));
  return [
    ...scalar,
    { value: "array", kind: "base", label: LIST_LABELS[lang], baseType: "string", valueType: "string", cardinality: "collection" },
    {
      value: FIELD_DEFINITION_COLLECTION_VALUE,
      kind: "base",
      label: FIELD_DEFINITION_COLLECTION_LABELS[lang],
      baseType: "object",
      valueType: "object",
      cardinality: "collection",
      osfType: FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE,
    },
  ];
}

function semanticOptions(lang: FieldTypeLang): FieldTypeOption[] {
  // A stored field definition (a form, a node's configuration) holds inline
  // identifier values, so a reference to an entity is its identity alias
  // (`relationId`), never the entity type that would ask for relational storage.
  return Object.entries(COMPILER_OSF_TYPES as Record<string, OsfTypeDefinition>)
    .map(([key, definition]): FieldTypeOption => ({
      value: definition.cardinality === "collection" ? `semantic:${key}:collection` : `semantic:${key}`,
      kind: "semantic",
      label: text(definition.label, lang, key),
      baseType: definition.baseType,
      valueType: definition.baseType,
      ...(definition.cardinality ? { cardinality: definition.cardinality } : {}),
      osfType: key,
      ...(definition.icon ? { icon: definition.icon } : {}),
    }))
    .sort((left, right) => left.label.localeCompare(right.label, lang));
}

const byLang = new Map<FieldTypeLang, FieldTypeOption[]>();

/** Every option, in the picker's order: base value types first, then meanings by label. */
export function allFieldTypeOptions(lang: FieldTypeLang): FieldTypeOption[] {
  let options = byLang.get(lang);
  if (!options) {
    options = [...baseOptions(lang), ...semanticOptions(lang)];
    byLang.set(lang, options);
  }
  return options;
}

export type FieldTypeQuery = {
  /** Case-insensitive match on label, description or osf type key. */
  search?: string;
  /** Authoring-profile type keys a picker withholds. */
  excludedFieldTypes?: readonly string[];
  limit?: number;
};

function typeKeyOf(option: FieldTypeOption): string {
  if (option.cardinality === "collection") {
    return option.osfType === FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE ? FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE : "collection";
  }
  return option.valueType;
}

function matches(option: FieldTypeOption, needle: string): boolean {
  return [option.label, option.description ?? "", option.osfType ?? "", option.value]
    .some((candidate) => candidate.toLowerCase().includes(needle));
}

export function fieldTypeOptions(lang: FieldTypeLang, query: FieldTypeQuery = {}): FieldTypeOption[] {
  const needle = query.search?.trim().toLowerCase() ?? "";
  const excluded = new Set(query.excludedFieldTypes ?? []);
  const matched = allFieldTypeOptions(lang).filter((option) =>
    !excluded.has(typeKeyOf(option)) && (needle.length === 0 || matches(option, needle)));
  return query.limit === undefined ? matched : matched.slice(0, query.limit);
}

/** The option a stored selection names, so a picker can label it. */
export function findFieldTypeOption(lang: FieldTypeLang, value: string): FieldTypeOption | undefined {
  return allFieldTypeOptions(lang).find((option) => option.value === value);
}
