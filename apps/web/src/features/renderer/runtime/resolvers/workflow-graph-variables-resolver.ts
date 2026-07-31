// SPDX-License-Identifier: BUSL-1.1
/**
 * WEB-020 — workflowGraphVariables resolver.
 *
 * Protocol adapter only. The real graph walk stays in
 * `features/workflow/lib/workflow-variable-suggestion-provider.ts` (Phase 3),
 * and Canvas.tsx will pre-compute the suggestion list and pass it through
 * `params.suggestions` in Phase 5. This resolver exists so the workflow
 * inspector speaks the same `FormVariableSource` contract as entity forms.
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
