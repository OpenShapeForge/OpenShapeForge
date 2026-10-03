// SPDX-License-Identifier: BUSL-1.1
/**
 * Resolves variable suggestions for a given entity type from its compiled
 * field definitions (nested shapes included).
 *
 * The field data is a compiler-owned generated contract,
 * `@/generated/compiler/entity-fields` — one readable field list per entity,
 * emitted with the other renderer contract modules whenever `apps/web`
 * exists — so every reader here is synchronous and needs no network. The
 * flattened suggestions are cached per `<entity>:<lang>`.
 *
 * Used when a field has `suggestions.sourceField` pointing to a sibling field
 * whose value is an entity type name (e.g. "Relation"), by the `entityFields`
 * variable-source resolver, and by entity condition builders.
 */
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_ENTITY_FIELDS } from "@/generated/compiler/entity-fields";
import type { AggregateFilterableField, VariableSuggestion, VariableSuggestionAggregate } from "@/features/renderer/runtime/variable-suggestions";
import { resolveRendererReferenceItems } from "@/features/renderer/runtime/options-utils";
import { fieldRuntimeKind, isFieldCollection, isFieldObject, fieldValueType } from "@/lib/field-contract/field-v2";

// Flattened VariableSuggestion[] per `<entity>:<lang>`.
const flattenedCache = new Map<string, VariableSuggestion[]>();

/** The compiled readable fields of an entity; an unknown entity has none. */
function rawFields(entityName: string): Field[] {
  return COMPILER_ENTITY_FIELDS[entityName] ?? [];
}

/** Parse the compiler-generated `hints.sourceHint` for aggregate fields. Format: `aggregate:{TargetEntity}:{relationshipKey}` */
function parseAggregateHint(field: Field): { targetEntity: string; relationship: string } | null {
  const hint = field.hints?.sourceHint;
  if (!hint || !hint.startsWith("aggregate:")) return null;
  const parts = hint.split(":");
  if (parts.length < 3) return null;
  return { targetEntity: parts[1]!, relationship: parts[2]! };
}

type NormalizedLang = "en" | "nl";

/** Resolve a compiler-generated i18n label to the user's language, falling back to the other locale, then the key. */
function resolveLabel(
  label: { en?: string; nl?: string } | undefined,
  fallbackKey: string,
  lang: NormalizedLang,
): string {
  if (lang === "en") {
    return label?.en ?? label?.nl ?? fallbackKey;
  }
  return label?.nl ?? label?.en ?? fallbackKey;
}

/** Build filterable fields for an aggregate relationship by looking up the target entity's scalar fields. */
function buildFilterableFields(targetEntityName: string, lang: NormalizedLang): AggregateFilterableField[] {
  return rawFields(targetEntityName)
    .filter((f) => f.key !== "id" && !isFieldObject(f) && !isFieldCollection(f))
    .map((f) => {
      const resolved = resolveRendererReferenceItems(f);
      return {
        key: f.key,
        label: resolveLabel(f.label, f.key, lang),
        type: fieldRuntimeKind(f),
        options: resolved.length > 0
          ? resolved.map((opt) => ({
              value: opt.value,
              label: resolveLabel(opt.label, opt.value, lang),
            }))
          : undefined,
      };
    });
}

function flattenFieldsToSuggestions(
  fields: Field[],
  lang: NormalizedLang,
  prefix = "",
  labelPrefix = "",
  entityName = "",
  parentAggregate?: VariableSuggestionAggregate,
): VariableSuggestion[] {
  const suggestions: VariableSuggestion[] = [];

  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.key}` : field.key;
    const label = resolveLabel(field.label, field.key, lang);
    const displayLabel = labelPrefix ? `${labelPrefix} > ${label}` : label;
    const valueType =
      isFieldCollection(field)
        ? "array"
        : fieldValueType(field) === "integer" || fieldValueType(field) === "number"
        ? "number"
        : fieldValueType(field) === "boolean"
          ? "boolean"
          : fieldValueType(field) === "object"
            ? "object"
            : "string";

    // Detect aggregate metadata from compiler hints or parent context
    let aggregate: VariableSuggestionAggregate | undefined = parentAggregate;
    const aggHint = parseAggregateHint(field);
    if (aggHint) {
      aggregate = {
        function: "count",
        relationship: aggHint.relationship,
        filterableFields: buildFilterableFields(aggHint.targetEntity, lang),
      };
    }

    // Resolve reference/enum options so the condition builder can render a
    // dropdown for the literal operand instead of a free-text input when the
    // variable is a reference-typed field (e.g., Task.status → TAAKSTATUS).
    const resolvedOptions = resolveRendererReferenceItems(field);
    const options = resolvedOptions.length > 0
      ? resolvedOptions.map((opt) => ({
          value: opt.value,
          label: resolveLabel(opt.label, opt.value, lang),
        }))
      : undefined;

    suggestions.push({
      path,
      displayPath: path,
      fieldPath: path,
      insertText: `{{${path}}}`,
      label,
      displayLabel: displayLabel !== label ? displayLabel : undefined,
      sourceNodeId: "entity",
      sourceNodeLabel: entityName,
      fieldType: fieldRuntimeKind(field),
      valueType,
      osfType:
        typeof field.osfType === "string" && field.osfType.trim().length > 0
          ? field.osfType.trim()
          : undefined,
      options,
      aggregate,
    });

    if (isFieldObject(field) && field.children?.length) {
      suggestions.push(
        ...flattenFieldsToSuggestions(field.children, lang, path, displayLabel, entityName, aggregate),
      );
    }
  }

  return suggestions;
}

/**
 * Returns variable suggestions for a given entity type name (e.g., "Relation",
 * "Case") with labels resolved in the caller's language, flattened once per
 * `<entity>:<lang>` and cached.
 *
 * `lang` accepts any string; anything other than `"en"` is treated as Dutch.
 */
export function getEntityFieldSuggestions(
  entityTypeName: string | undefined | null,
  lang: string,
): VariableSuggestion[] {
  if (!entityTypeName || entityTypeName.trim().length === 0) {
    return [];
  }
  const name = entityTypeName.trim();
  const normalizedLang: NormalizedLang = lang === "en" ? "en" : "nl";
  const cacheKey = `${name}:${normalizedLang}`;
  const cached = flattenedCache.get(cacheKey);
  if (cached) return cached;

  const result = flattenFieldsToSuggestions(rawFields(name), normalizedLang, "", "", name);
  flattenedCache.set(cacheKey, result);
  return result;
}

/** The same suggestions behind a promise, for the async variable-source resolver contract. */
export async function loadEntityFieldSuggestions(
  entityTypeName: string | undefined | null,
  lang: string,
): Promise<VariableSuggestion[]> {
  return getEntityFieldSuggestions(entityTypeName, lang);
}

export type EntityConditionFilterField = {
  key: string;
  label: string;
  description?: string;
  fieldType: string;
  inputKind: "text" | "number" | "boolean" | "select";
  osfType?: string;
  options?: Array<{ value: string; label: string }>;
};

function resolveInputKind(
  suggestion: VariableSuggestion,
): EntityConditionFilterField["inputKind"] {
  if (suggestion.options?.length) {
    return "select";
  }
  if (suggestion.valueType === "boolean" || suggestion.fieldType === "boolean") {
    return "boolean";
  }
  if (
    suggestion.valueType === "number" ||
    suggestion.fieldType === "integer" ||
    suggestion.fieldType === "number"
  ) {
    return "number";
  }
  return "text";
}

/**
 * Returns condition-builder metadata for entity-record filters from the same
 * field source used by label rules. Includes nested belongsTo scalar fields and
 * aggregate count fields, excluding object/array containers. SYNCHRONOUS with
 * the same cache-miss-then-fetch behavior as `getEntityFieldSuggestions`.
 */
export function getEntityConditionFilterFields(
  entityTypeName: string | undefined | null,
  lang: string,
): EntityConditionFilterField[] {
  return getEntityFieldSuggestions(entityTypeName, lang)
    .filter((suggestion) =>
      suggestion.valueType === "string" ||
      suggestion.valueType === "number" ||
      suggestion.valueType === "boolean"
    )
    .map((suggestion) => ({
      key: suggestion.path,
      label: suggestion.displayLabel ?? suggestion.label,
      fieldType: suggestion.fieldType ?? suggestion.valueType,
      inputKind: resolveInputKind(suggestion),
      ...(suggestion.osfType ? { osfType: suggestion.osfType } : {}),
      ...(suggestion.options?.length ? { options: suggestion.options } : {}),
    }));
}
