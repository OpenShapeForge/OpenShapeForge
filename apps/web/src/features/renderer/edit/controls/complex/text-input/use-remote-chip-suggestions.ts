// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useState } from "react";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { fetchChipVariableSuggestions } from "@/features/renderer/runtime/chip-variable-suggestions";
import { normalizeChipQuery } from "./suggestions";
import type { TriggerMatch } from "./types";

export function useRemoteChipSuggestions({
  query,
  suggestions,
  triggerState,
}: {
  query: string;
  suggestions: readonly VariableSuggestion[];
  triggerState: TriggerMatch | null;
}) {
  const [remoteChipSuggestions, setRemoteChipSuggestions] = useState<VariableSuggestion[]>([]);

  useEffect(() => {
    if (!triggerState) {
      setRemoteChipSuggestions((current) => current.length === 0 ? current : []);
      return;
    }

    const hasPreloadedChipSuggestions = suggestions.some(
      (suggestion) => suggestion.sourceNodeId === "chips",
    );
    const shouldFetchChips =
      !hasPreloadedChipSuggestions &&
      (triggerState.trigger === "$" ||
        triggerState.trigger === "@" ||
        query.trim().toLowerCase().startsWith("chips."));
    if (!shouldFetchChips) {
      setRemoteChipSuggestions((current) => current.length === 0 ? current : []);
      return;
    }

    const controller = new AbortController();
    fetchChipVariableSuggestions({
      query: normalizeChipQuery(query),
      signal: controller.signal,
    })
      .then((nextSuggestions) => {
        if (!controller.signal.aborted) {
          setRemoteChipSuggestions(nextSuggestions);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRemoteChipSuggestions((current) => current.length === 0 ? current : []);
        }
      });

    return () => controller.abort();
  }, [query, suggestions, triggerState]);

  return remoteChipSuggestions;
}
