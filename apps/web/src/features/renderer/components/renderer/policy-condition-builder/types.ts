// SPDX-License-Identifier: BUSL-1.1
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";

export type PolicyConditionLanguage = "nl" | "en";

export type PolicyFieldOperator =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "notContains"
  | "isEmpty"
  | "isNotEmpty";

export type PolicyCondition =
  | { type: "always" }
  | { type: "never" }
  | { type: "actorRole"; anyOf: string[] }
  | { type: "actorGroup"; anyOf: string[] }
  | { type: "taskAssignee" }
  | {
      type: "field";
      field: string;
      operator: PolicyFieldOperator;
      value?: string | string[] | number | boolean | null;
      valueField?: string;
    }
  | { type: "all"; conditions: PolicyCondition[] }
  | { type: "any"; conditions: PolicyCondition[] }
  | { type: "not"; condition: PolicyCondition };

export type PolicyConditionType = PolicyCondition["type"];
export type PolicyFieldCondition = Extract<PolicyCondition, { type: "field" }>;

export type PolicyConditionBuilderProps = {
  id?: string;
  value: unknown;
  lang: PolicyConditionLanguage;
  disabled?: boolean;
  entityType?: string | null;
  variableSuggestions?: VariableSuggestion[];
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  onChange: (value: PolicyCondition) => void;
};
