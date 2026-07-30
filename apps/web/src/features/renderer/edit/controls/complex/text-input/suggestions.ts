// SPDX-License-Identifier: BUSL-1.1
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

export function filterSuggestions(
  suggestions: VariableSuggestion[],
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return suggestions;
  }

  return suggestions.filter((suggestion) => {
    const haystack = [
      suggestion.path,
      suggestion.displayPath,
      suggestion.fieldPath,
      ...(suggestion.aliases ?? []),
      suggestion.label,
      suggestion.sourceNodeLabel,
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

const CHIP_SOURCE_TONE = {
  background: "color-mix(in srgb, var(--color-brand-aquamarine-60) 12%, transparent)",
  border: "color-mix(in srgb, var(--color-brand-aquamarine-60) 30%, var(--color-border))",
  text: "color-mix(in srgb, var(--color-brand-aquamarine-100) 68%, var(--color-foreground))",
};

function withChipTone(suggestion: VariableSuggestion): VariableSuggestion {
  if (suggestion.sourceNodeId !== "chips") {
    return suggestion;
  }
  return {
    ...suggestion,
    sourceNodeTone: suggestion.sourceNodeTone ?? CHIP_SOURCE_TONE,
  };
}

export function mergeSuggestions(
  base: readonly VariableSuggestion[],
  extra: readonly VariableSuggestion[],
) {
  const seen = new Set<string>();
  const merged: VariableSuggestion[] = [];
  for (const suggestion of [...base, ...extra]) {
    if (seen.has(suggestion.path)) {
      continue;
    }
    seen.add(suggestion.path);
    merged.push(withChipTone(suggestion));
  }
  return merged;
}

export function normalizeChipQuery(query: string) {
  return query.trim().replace(/^chips\./i, "");
}

export function formatSuggestionValue(suggestion: VariableSuggestion) {
  return `${suggestion.sourceNodeLabel} - ${suggestion.displayLabel ?? suggestion.label}`;
}

export function normalizeVariablePath(value: string) {
  return value
    .trim()
    .replace(/^\{\{\s*/, "")
    .replace(/\s*\}\}$/, "")
    .trim();
}

export function findSuggestion(
  suggestions: VariableSuggestion[],
  path: string,
) {
  const normalizedPath = normalizeVariablePath(path);
  return suggestions.find((suggestion) =>
    [
      suggestion.path,
      suggestion.insertText,
      ...(suggestion.aliases ?? []),
    ].some((candidate) => normalizeVariablePath(candidate) === normalizedPath)
  ) ?? null;
}
