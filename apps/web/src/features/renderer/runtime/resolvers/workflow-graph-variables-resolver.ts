// SPDX-License-Identifier: BUSL-1.1
/**
 * WEB-020 — workflowGraphVariables resolver.
 *
 * Protocol adapter only. The real graph walk belongs to the workflow plugin's
 * designer, which pre-computes the suggestion list and passes it through
 * `params.suggestions`. This resolver exists so a workflow inspector speaks
 * the same `FormVariableSource` contract as entity forms.
 *
 * Returns `[]` when `params.suggestions` is missing or not an array — the form
 * then renders with an empty dropdown, matching silent-empty behaviour used
 * elsewhere.
 */
import type {
  VariableSuggestionResolver,
} from "@/features/renderer/runtime/variable-sources";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

export const workflowGraphVariablesResolver: VariableSuggestionResolver = {
  id: "workflowGraphVariables",
  getDependencyKey(params): string {
    return JSON.stringify(params ?? null);
  },
  resolve(params): VariableSuggestion[] {
    const pre = params?.suggestions;
    if (!Array.isArray(pre)) {
      return [];
    }
    return pre as VariableSuggestion[];
  },
};
