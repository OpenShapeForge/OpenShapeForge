// SPDX-License-Identifier: BUSL-1.1
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

export type ChipVariableSuggestion = VariableSuggestion & {
  resolvedValue: string;
  isActive?: boolean;
  variableSource: "chip";
};

const CHIP_TOKEN_PATTERN = /\{\{\s*chips\.([^{}]+?)\s*\}\}/g;
const CHIP_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export function extractChipKeysFromText(value: string): string[] {
  const keys = new Set<string>();
  for (const match of value.matchAll(CHIP_TOKEN_PATTERN)) {
    const key = match[1]?.trim();
    if (key && CHIP_KEY_PATTERN.test(key)) {
      keys.add(key);
    }
  }
  return Array.from(keys);
}

export function replaceChipTokens(
  value: string,
  suggestions: readonly Pick<ChipVariableSuggestion, "fieldPath" | "resolvedValue">[],
) {
  const valuesByKey = new Map(
    suggestions.map((suggestion) => [suggestion.fieldPath, suggestion.resolvedValue]),
  );
  return value.replace(CHIP_TOKEN_PATTERN, (raw, key: string) => {
    const normalized = key.trim();
    if (!CHIP_KEY_PATTERN.test(normalized)) {
      return raw;
    }
    return valuesByKey.get(normalized) ?? raw;
  });
}

export async function fetchChipVariableSuggestions(input: {
  query?: string;
  keys?: readonly string[];
  signal?: AbortSignal;
} = {}): Promise<ChipVariableSuggestion[]> {
  const params = new URLSearchParams();
  const query = input.query?.trim();
  if (query) {
    params.set("q", query);
  }
  if (input.keys && input.keys.length > 0) {
    params.set("keys", input.keys.join(","));
  }
  const response = await fetch(`/api/chips/suggestions?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    signal: input.signal,
  });
  if (!response.ok) {
    return [];
  }
  const payload = await response.json().catch(() => null);
  return Array.isArray(payload?.suggestions)
    ? (payload.suggestions as ChipVariableSuggestion[])
    : [];
}
