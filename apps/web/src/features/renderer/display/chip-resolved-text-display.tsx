// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useMemo, useState } from "react";
import { TextDisplay } from "@/features/renderer/display/text-display";
import {
  extractChipKeysFromText,
  fetchChipVariableSuggestions,
  replaceChipTokens,
  type ChipVariableSuggestion,
} from "@/features/renderer/runtime/chip-variable-suggestions";

export function ChipResolvedTextDisplay({
  value,
}: {
  value: string;
}) {
  const chipKeys = useMemo(() => extractChipKeysFromText(value), [value]);
  const [suggestions, setSuggestions] = useState<ChipVariableSuggestion[]>([]);

  useEffect(() => {
    if (chipKeys.length === 0) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();
    fetchChipVariableSuggestions({ keys: chipKeys, signal: controller.signal })
      .then((nextSuggestions) => {
        if (!controller.signal.aborted) {
          setSuggestions(nextSuggestions);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setSuggestions([]);
        }
      });

    return () => controller.abort();
  }, [chipKeys]);

  return <TextDisplay>{replaceChipTokens(value, suggestions)}</TextDisplay>;
}
