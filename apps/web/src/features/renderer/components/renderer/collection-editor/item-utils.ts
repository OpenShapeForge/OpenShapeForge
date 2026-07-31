// SPDX-License-Identifier: BUSL-1.1
import { isFieldCardinalityCollection } from "@/features/renderer/edit/controls/complex/field-schema-editor/utils";
import { translateRendererText } from "@/features/renderer/runtime/field-utils";
import { resolveFieldIcon } from "@/features/renderer/runtime/field-icons";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type { Field } from "@/generated/compiler/field-contract";

import type { CollectionEditorLang } from "./types";

export function resolveCollectionItemLabel(
  item: unknown,
  index: number,
  lang: CollectionEditorLang,
  variableSuggestions: readonly VariableSuggestion[] = [],
): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return `Item ${index + 1}`;
  }

  const record = item as Record<string, unknown>;
  if (
    record.kind === "manual" &&
    record.field &&
    typeof record.field === "object" &&
    !Array.isArray(record.field)
  ) {
    return resolveCollectionItemLabel(
      record.field,
      index,
      lang,
      variableSuggestions,
    );
  }
  if (
    record.kind === "manual" &&
    record.value &&
    typeof record.value === "object" &&
    !Array.isArray(record.value)
  ) {
    return resolveCollectionItemLabel(
      record.value,
      index,
      lang,
      variableSuggestions,
    );
  }
  if (record.kind === "variable") {
    const source =
      typeof record.source === "string" ? record.source.trim() : "";
    const suggestion = source
      ? findVariableSuggestionForStoredValue(variableSuggestions, source)
      : null;
    const label = translateRendererText(
      record.label as Field["label"] | undefined,
      lang,
    );
    return (
      suggestion?.label ?? label ?? (lang === "nl" ? "Variabele" : "Variable")
    );
  }

  const label = translateRendererText(
    record.label as Field["label"] | undefined,
    lang,
  );
  if (label) return label;

  if (typeof record.key === "string" && record.key.trim().length > 0) {
    return record.key.trim();
  }
  if (typeof record.name === "string" && record.name.trim().length > 0) {
    return record.name.trim();
  }
  if (typeof record.title === "string" && record.title.trim().length > 0) {
    return record.title.trim();
  }

  return `Item ${index + 1}`;
}

function normalizeInterpolation(value: string) {
  const trimmed = value.trim();
  const interpolationMatch = trimmed.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  if (!interpolationMatch) {
    return trimmed;
  }

  return `{{${interpolationMatch[1].trim()}}}`;
}

function variableSuggestionMatchesStoredValue(
  suggestion: VariableSuggestion,
  storedValue: string,
): boolean {
  const normalized = normalizeInterpolation(storedValue);
  const insertText = normalizeInterpolation(suggestion.insertText);
  const path = normalizeInterpolation(suggestion.path);
  if (normalized === insertText || normalized === path) {
    return true;
  }

  const interpolationMatch = normalized.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  return interpolationMatch?.[1]?.trim() === suggestion.path.trim();
}

function findVariableSuggestionForStoredValue(
  suggestions: readonly VariableSuggestion[],
  storedValue: string,
): VariableSuggestion | null {
  return (
    suggestions.find((suggestion) =>
      variableSuggestionMatchesStoredValue(suggestion, storedValue),
    ) ?? null
  );
}

export function resolveCollectionItemIcon(
  item: unknown,
  itemField?: Field,
): string | null {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    if (
      "kind" in record &&
      (record as { kind?: unknown }).kind === "manual" &&
      "field" in record &&
      (record as { field?: unknown }).field &&
      typeof (record as { field?: unknown }).field === "object" &&
      !Array.isArray((record as { field?: unknown }).field)
    ) {
      return resolveCollectionItemIcon(
        (record as { field: unknown }).field,
        itemField,
      );
    }
    if (
      "kind" in record &&
      (record as { kind?: unknown }).kind === "manual" &&
      "value" in record &&
      (record as { value?: unknown }).value &&
      typeof (record as { value?: unknown }).value === "object" &&
      !Array.isArray((record as { value?: unknown }).value)
    ) {
      return resolveCollectionItemIcon(
        (record as { value: unknown }).value,
        itemField,
      );
    }
    if ("kind" in record && (record as { kind?: unknown }).kind === "variable") {
      return itemField
        ? resolveFieldIcon(itemField)
        : resolveFieldIcon({ valueType: "string" });
    }
    const looksLikeField =
      typeof record.key === "string" && typeof record.valueType === "string";
    if (looksLikeField) {
      const fromItem = resolveFieldIcon({
        valueType: record.valueType as Field["valueType"],
        cardinality: isFieldCardinalityCollection(record.cardinality)
          ? "collection"
          : "single",
        validation:
          typeof record.validation === "object" && record.validation
            ? (record.validation as Field["validation"])
            : undefined,
        semanticType:
          typeof record.semanticType === "string"
            ? record.semanticType
            : undefined,
      });
      if (fromItem) return fromItem;
    }
  }
  if (itemField) {
    return resolveFieldIcon(itemField);
  }
  return null;
}

export function generateItemId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `item-${Math.random().toString(36).slice(2, 11)}`;
}
