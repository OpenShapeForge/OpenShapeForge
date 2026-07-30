// SPDX-License-Identifier: BUSL-1.1
import { fetchChipVariableSuggestions } from "@/features/renderer/runtime/chip-variable-suggestions";
import type {
  VariableSuggestionResolver,
} from "@/features/renderer/runtime/variable-sources";

export const chipsResolver: VariableSuggestionResolver = {
  id: "chips",
  getDependencyKey(params): string {
    return JSON.stringify(params ?? null);
  },
  resolve(): ReturnType<typeof fetchChipVariableSuggestions> {
    return fetchChipVariableSuggestions();
  },
};
