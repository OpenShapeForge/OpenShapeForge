// SPDX-License-Identifier: BUSL-1.1
import type { Field, LocalizedText } from "@/generated/compiler/field-contract";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { isRecord } from "@/lib/json-record";
import type {
  OptionVariablePickerOption,
  OptionVariablePickerValueMode,
} from "./types";

export type HiddenOptionCopy = {
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
};

export function normalizeInterpolation(value: string) {
  const trimmed = value.trim();
  const interpolationMatch = trimmed.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  if (!interpolationMatch) {
    return trimmed;
  }

  return `{{${interpolationMatch[1].trim()}}}`;
}

function normalizedValueMatchesSuggestion(
  normalized: string,
  suggestion: VariableSuggestion,
): boolean {
  const candidates = [
    suggestion.insertText,
    suggestion.path,
    ...(suggestion.aliases ?? []),
  ];
  if (candidates.some((candidate) => normalized === normalizeInterpolation(candidate))) {
    return true;
  }
  const braceInner = /^\{\{\s*([^{}]+)\s*\}\}$/.exec(normalized);
  if (
    braceInner &&
    candidates.some(
      (candidate) =>
        braceInner[1].trim() ===
        normalizeInterpolation(candidate).replace(/^\{\{|\}\}$/g, ""),
    )
  ) {
    return true;
  }
  return false;
}

export function findSuggestionForStoredValue(
  suggestions: VariableSuggestion[],
  storedValue: string,
): VariableSuggestion | null {
  const trimmed = storedValue.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeInterpolation(trimmed);
  return (
    suggestions.find((suggestion) =>
      normalizedValueMatchesSuggestion(normalized, suggestion),
    ) ?? null
  );
}

export function resolveOptionLabel(
  label: string | LocalizedText | undefined,
  lang: "nl" | "en",
  fallback: string,
) {
  if (typeof label === "string" && label.trim().length > 0) {
    return label.trim();
  }

  if (label && typeof label === "object") {
    const localized = label[lang] ?? label.nl ?? label.en;
    if (typeof localized === "string" && localized.trim().length > 0) {
      return localized.trim();
    }
  }

  return fallback;
}

export function resolveHiddenOptionCopy(
  optionSectionLabel: string | undefined,
  lang: "nl" | "en",
): HiddenOptionCopy {
  const normalized = optionSectionLabel?.trim().toLowerCase() ?? "";
  const isTemplate = normalized.includes("template");
  const isWorkflow = normalized.includes("workflow");

  if (isTemplate) {
    return lang === "nl"
      ? {
          placeholder: "Kies een template",
          searchPlaceholder: "Zoek template",
          emptyMessage: "Geen templates gevonden.",
        }
      : {
          placeholder: "Choose a template",
          searchPlaceholder: "Search template",
          emptyMessage: "No templates found.",
        };
  }

  if (isWorkflow) {
    return lang === "nl"
      ? {
          placeholder: "Kies een workflow",
          searchPlaceholder: "Zoek workflow",
          emptyMessage: "Geen workflows gevonden.",
        }
      : {
          placeholder: "Choose a workflow",
          searchPlaceholder: "Search workflow",
          emptyMessage: "No workflows found.",
        };
  }

  return lang === "nl"
    ? {
        placeholder: "Kies een optie",
        searchPlaceholder: "Zoek optie",
        emptyMessage: "Geen opties gevonden.",
      }
    : {
        placeholder: "Choose an option",
        searchPlaceholder: "Search option",
        emptyMessage: "No options found.",
      };
}

export function optionMatchesQuery(
  option: OptionVariablePickerOption,
  query: string,
  lang: "nl" | "en",
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  const haystack = [
    option.value,
    resolveOptionLabel(option.label, lang, option.value),
    typeof option.description === "string" ? option.description : "",
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

export function suggestionMatchesQuery(
  suggestion: VariableSuggestion,
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  const haystack = [
    suggestion.path,
    suggestion.insertText,
    suggestion.displayPath,
    suggestion.fieldPath,
    ...(suggestion.aliases ?? []),
    suggestion.label,
    suggestion.sourceNodeLabel,
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

export function readStringRenderProp(
  field: Field | null | undefined,
  propName: string,
) {
  const value = field?.render?.props?.[propName];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeRemoteOption(raw: unknown): OptionVariablePickerOption | null {
  if (!isRecord(raw)) {
    return null;
  }

  const value =
    typeof raw.value === "string" && raw.value.trim().length > 0
      ? raw.value.trim()
      : typeof raw.id === "string" && raw.id.trim().length > 0
        ? raw.id.trim()
        : "";
  if (!value) {
    return null;
  }

  const label =
    typeof raw.label === "string" || isRecord(raw.label)
      ? (raw.label as string | LocalizedText)
      : undefined;
  const description =
    typeof raw.description === "string" ? raw.description : undefined;

  return {
    ...raw,
    value,
    label,
    description,
  };
}

export function normalizeRemoteOptions(data: unknown): OptionVariablePickerOption[] {
  const rawItems = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.items)
      ? data.items
      : [];

  return rawItems
    .map((item) => normalizeRemoteOption(item))
    .filter((item): item is OptionVariablePickerOption => item !== null);
}

export function getSuggestionStoredValue(
  suggestion: VariableSuggestion,
  valueMode: OptionVariablePickerValueMode,
) {
  return valueMode === "insertText" ? suggestion.insertText : suggestion.path;
}

export function getSelectedSuggestionLabel(suggestion: VariableSuggestion) {
  const label = suggestion.displayLabel ?? suggestion.label;
  return suggestion.sourceNodeLabel
    ? `${suggestion.sourceNodeLabel} - ${label}`
    : label;
}
