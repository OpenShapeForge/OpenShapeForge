// SPDX-License-Identifier: BUSL-1.1
import type { CompilerConditionOperator } from "@/generated/compiler/canonical-condition";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type { ConditionBuilderLang } from "./types";

export type ConditionOperatorEntry = {
  value: CompilerConditionOperator;
  labelNl: string;
  labelEn: string;
};

export const CONDITION_OPERATORS: ConditionOperatorEntry[] = [
  { value: "equals", labelNl: "is gelijk aan", labelEn: "equals" },
  { value: "notEquals", labelNl: "is niet gelijk aan", labelEn: "does not equal" },
  { value: "greaterThan", labelNl: "is groter dan", labelEn: "is greater than" },
  { value: "greaterThanOrEquals", labelNl: "is groter of gelijk aan", labelEn: "is greater than or equal" },
  { value: "lessThan", labelNl: "is kleiner dan", labelEn: "is less than" },
  { value: "lessThanOrEquals", labelNl: "is kleiner of gelijk aan", labelEn: "is less than or equal" },
  { value: "contains", labelNl: "bevat", labelEn: "contains" },
  { value: "notContains", labelNl: "bevat niet", labelEn: "does not contain" },
  { value: "in", labelNl: "zit in lijst", labelEn: "is in list" },
  { value: "notIn", labelNl: "zit niet in lijst", labelEn: "is not in list" },
  { value: "isEmpty", labelNl: "is leeg", labelEn: "is empty" },
  { value: "isNotEmpty", labelNl: "is niet leeg", labelEn: "is not empty" },
];

const UNIVERSAL_OPERATORS: Set<CompilerConditionOperator> = new Set([
  "equals",
  "notEquals",
  "isEmpty",
  "isNotEmpty",
]);

const NUMERIC_OPERATORS: Set<CompilerConditionOperator> = new Set([
  "greaterThan",
  "greaterThanOrEquals",
  "lessThan",
  "lessThanOrEquals",
]);

const STRING_OPERATORS: Set<CompilerConditionOperator> = new Set([
  "contains",
  "notContains",
  "in",
  "notIn",
]);

const ARRAY_OPERATORS: Set<CompilerConditionOperator> = new Set([
  "contains",
  "notContains",
]);

export const LIST_LITERAL_OPERATORS: Set<CompilerConditionOperator> = new Set([
  "in",
  "notIn",
]);

export function getOperatorsForValueType(
  valueType: VariableSuggestion["valueType"] | undefined,
  fieldType?: VariableSuggestion["fieldType"],
): ConditionOperatorEntry[] {
  if (!valueType) return CONDITION_OPERATORS;

  if (fieldType === "date" || fieldType === "datetime") {
    return CONDITION_OPERATORS.filter(
      (op) => UNIVERSAL_OPERATORS.has(op.value) || NUMERIC_OPERATORS.has(op.value),
    );
  }

  switch (valueType) {
    case "number":
      return CONDITION_OPERATORS.filter(
        (op) => UNIVERSAL_OPERATORS.has(op.value) || NUMERIC_OPERATORS.has(op.value),
      );
    case "boolean":
      return CONDITION_OPERATORS.filter((op) => UNIVERSAL_OPERATORS.has(op.value));
    case "array":
      return CONDITION_OPERATORS.filter(
        (op) => ARRAY_OPERATORS.has(op.value) || op.value === "isEmpty" || op.value === "isNotEmpty",
      );
    case "string":
      return CONDITION_OPERATORS.filter(
        (op) => UNIVERSAL_OPERATORS.has(op.value) || STRING_OPERATORS.has(op.value),
      );
    default:
      return CONDITION_OPERATORS;
  }
}

export function getOperatorLabel(
  operator: CompilerConditionOperator,
  lang: ConditionBuilderLang,
) {
  const entry = CONDITION_OPERATORS.find((candidate) => candidate.value === operator);
  if (!entry) {
    return operator;
  }

  return lang === "nl" ? entry.labelNl : entry.labelEn;
}
