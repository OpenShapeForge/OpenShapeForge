// SPDX-License-Identifier: BUSL-1.1
/**
 * Resolves variable suggestions for a given entity type by looking up its
 * compiled field definitions (relationships + aggregate fields included).
 *
 * The field data lives in Postgres (platform.entity_field_suggestions) and is
 * served over GraphQL; client consumers fetch it per entity through the route
 * `/api/renderer/entity-field-suggestions/<entity>` and cache it here. The
 * public read functions stay SYNCHRONOUS (`getEntityFieldSuggestions`,
 * `getEntityConditionFilterFields`): on a cache miss they return `[]` and kick
 * off a background fetch, then notify subscribers (see
 * `use-entity-field-suggestions-version.ts`) so the renderer re-renders with the
 * loaded data. The `variableSources` resolver path uses the async
 * `loadEntityFieldSuggestions` instead.
 *
 * Used when a field has `suggestions.sourceField` pointing to a sibling field
 * whose value is an entity type name (e.g. "Relation"), and by the workflow
 * designer's entity trigger-condition builder.
 */
import type { Field } from "@/generated/compiler/field-contract";
import type { AggregateFilterableField, VariableSuggestion, VariableSuggestionAggregate } from "@/features/renderer/runtime/variable-suggestions";
import { resolveRendererReferenceItems } from "@/features/renderer/runtime/options-utils";
import { fieldRuntimeKind, isFieldCollection, isFieldObject } from "@/lib/field-contract/field-v2";

// ── Client cache + external store ──────────────────────────────────────────
// Raw compiler Field[] per entity (PascalCase name), fetched from the route.
const rawFieldsCache = new Map<string, Field[]>();
const rawFieldsInFlight = new Map<string, Promise<Field[]>>();
// Flattened VariableSuggestion[] per `<entity>:<lang>`.
const flattenedCache = new Map<string, VariableSuggestion[]>();

let version = 0;
const listeners = new Set<() => void>();

function bumpVersion(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Subscribe to cache updates; returns an unsubscribe fn. For useSyncExternalStore. */
export function subscribeEntityFieldSuggestions(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** Monotonic version, bumped whenever a fetch populates the cache. */
export function getEntityFieldSuggestionsVersion(): number {
  return version;
}

async function fetchRawFields(entityName: string): Promise<Field[]> {
  const cached = rawFieldsCache.get(entityName);
  if (cached) return cached;
  const inFlight = rawFieldsInFlight.get(entityName);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const response = await fetch(
      `/api/renderer/entity-field-suggestions/${encodeURIComponent(entityName)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(`entity-field-suggestions fetch failed: ${response.status}`);
    }
    const fields = (await response.json()) as Field[];
    const safe = Array.isArray(fields) ? fields : [];
    rawFieldsCache.set(entityName, safe);
    return safe;
  })();

  rawFieldsInFlight.set(entityName, promise);
  try {
    return await promise;
  } finally {
    rawFieldsInFlight.delete(entityName);
  }
}

/** Collect aggregate target entity names referenced via `hints.sourceHint`. */
function collectAggregateTargets(fields: Field[], out: Set<string> = new Set()): Set<string> {
  for (const field of fields) {
    const target = parseAggregateHint(field)?.targetEntity;
    if (target) out.add(target);
    if (isFieldObject(field) && field.children?.length) {
      collectAggregateTargets(field.children, out);
    }
  }
  return out;
}

/** Synchronous peek into the raw-field cache (used by aggregate expansion). */
function getCachedRawFields(entityName: string): Field[] | undefined {
  return rawFieldsCache.get(entityName);
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
  const targetFields = getCachedRawFields(targetEntityName);
  if (!targetFields) return [];

  return targetFields
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
        : field.valueType === "integer" || field.valueType === "number"
        ? "number"
        : field.valueType === "boolean"
          ? "boolean"
          : field.valueType === "object"
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
      semanticType:
        typeof field.semanticType === "string" && field.semanticType.trim().length > 0
          ? field.semanticType.trim()
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
 * Asynchronously loads and flattens an entity's field suggestions, ensuring the
 * entity AND any aggregate-target entities its fields reference are fetched
 * first (so `buildFilterableFields` can read them from the cache). Caches the
 * flattened result by `<entity>:<lang>` and notifies subscribers. Used by the
 * `entityFields` variable-source resolver.
 */
export async function loadEntityFieldSuggestions(
  entityTypeName: string | undefined | null,
  lang: string,
): Promise<VariableSuggestion[]> {
  if (!entityTypeName || entityTypeName.trim().length === 0) {
    return [];
  }
  const name = entityTypeName.trim();
  const normalizedLang: NormalizedLang = lang === "en" ? "en" : "nl";
  const cacheKey = `${name}:${normalizedLang}`;
  const cached = flattenedCache.get(cacheKey);
  if (cached) return cached;

  const fields = await fetchRawFields(name);
  if (fields.length === 0) {
    flattenedCache.set(cacheKey, []);
    return [];
  }
  // Ensure aggregate-target entities are loaded so buildFilterableFields can
  // read their scalar fields synchronously during flatten.
  const targets = collectAggregateTargets(fields);
  await Promise.all(
    [...targets].map((target) =>
      getCachedRawFields(target) ? Promise.resolve() : fetchRawFields(target).then(() => undefined),
    ),
  );

  const result = flattenFieldsToSuggestions(fields, normalizedLang, "", "", name);
  flattenedCache.set(cacheKey, result);
  bumpVersion();
  return result;
}

/**
 * Returns variable suggestions for a given entity type name (e.g., "Relation",
 * "Case") with labels resolved in the caller's language.
 *
 * SYNCHRONOUS: returns the cached flattened result, or `[]` on a miss while
 * kicking off a background fetch (browser only). When the fetch completes the
 * cache version bumps; components that subscribe via
 * `useEntityFieldSuggestionsVersion` re-render and this call then returns the
 * loaded suggestions.
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

  // Cache miss: warm the cache in the background (browser only — there is no
  // origin to fetch from during SSR). The version bump on completion re-renders
  // subscribed consumers.
  if (typeof window !== "undefined") {
    void loadEntityFieldSuggestions(name, normalizedLang).catch(() => {
      // Network/parse errors are swallowed; pickers stay empty (cache-only).
    });
  }
  return [];
}

export type EntityConditionFilterField = {
  key: string;
  label: string;
  description?: string;
  fieldType: string;
  inputKind: "text" | "number" | "boolean" | "select";
  semanticType?: string;
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
      ...(suggestion.semanticType ? { semanticType: suggestion.semanticType } : {}),
      ...(suggestion.options?.length ? { options: suggestion.options } : {}),
    }));
}

/** FOR TESTS ONLY. Clears all caches and resets the version. */
export function __resetEntityFieldSuggestionsCacheForTest(): void {
  rawFieldsCache.clear();
  rawFieldsInFlight.clear();
  flattenedCache.clear();
  version = 0;
}

/**
 * FOR TESTS ONLY. Seeds the raw-field cache so the (otherwise fetch-backed)
 * loader resolves without network access. Mirrors what a successful route fetch
 * would populate.
 */
export function __primeEntityRawFieldsForTest(entityName: string, fields: Field[]): void {
  rawFieldsCache.set(entityName, fields);
}
