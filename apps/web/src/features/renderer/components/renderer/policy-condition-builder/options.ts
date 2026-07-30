// SPDX-License-Identifier: BUSL-1.1
import type { CompilerConditionOperator } from "@/generated/compiler/canonical-condition";
import type {
  PolicyConditionLanguage,
  PolicyConditionType,
  PolicyFieldOperator,
} from "./types";

type LocalizedOption<TValue extends string> = {
  value: TValue;
  label: Record<PolicyConditionLanguage, string>;
};

export const CONDITION_TYPES: Array<LocalizedOption<PolicyConditionType>> = [
  { value: "always", label: { nl: "Altijd toestaan", en: "Always allow" } },
  { value: "never", label: { nl: "Nooit toestaan", en: "Never allow" } },
  { value: "actorRole", label: { nl: "Actor heeft rol", en: "Actor has role" } },
  {
    value: "actorGroup",
    label: { nl: "Actor zit in groep", en: "Actor is in group" },
  },
  {
    value: "taskAssignee",
    label: {
      nl: "Actor is taaktoegewezene",
      en: "Actor is task assignee",
    },
  },
  { value: "field", label: { nl: "Veldwaarde", en: "Field value" } },
  { value: "all", label: { nl: "Alle voorwaarden", en: "All conditions" } },
  {
    value: "any",
    label: { nl: "Een van de voorwaarden", en: "Any condition" },
  },
  { value: "not", label: { nl: "Niet", en: "Not" } },
];

export const FIELD_OPERATORS: Array<LocalizedOption<PolicyFieldOperator>> = [
  { value: "eq", label: { nl: "is gelijk aan", en: "equals" } },
  { value: "neq", label: { nl: "is niet gelijk aan", en: "does not equal" } },
  { value: "in", label: { nl: "is een van", en: "is one of" } },
  { value: "notIn", label: { nl: "is niet een van", en: "is not one of" } },
  { value: "gt", label: { nl: "is groter dan", en: "is greater than" } },
  { value: "lt", label: { nl: "is kleiner dan", en: "is less than" } },
  {
    value: "gte",
    label: { nl: "is groter dan of gelijk aan", en: "is greater than or equal to" },
  },
  {
    value: "lte",
    label: { nl: "is kleiner dan of gelijk aan", en: "is less than or equal to" },
  },
  { value: "contains", label: { nl: "bevat", en: "contains" } },
  {
    value: "notContains",
    label: { nl: "bevat niet", en: "does not contain" },
  },
  { value: "isEmpty", label: { nl: "is leeg", en: "is empty" } },
  { value: "isNotEmpty", label: { nl: "is niet leeg", en: "is not empty" } },
];

export const POLICY_TO_COMPILER_OPERATOR: Record<
  PolicyFieldOperator,
  CompilerConditionOperator
> = {
  eq: "equals",
  neq: "notEquals",
  in: "in",
  notIn: "notIn",
  gt: "greaterThan",
  lt: "lessThan",
  gte: "greaterThanOrEquals",
  lte: "lessThanOrEquals",
  contains: "contains",
  notContains: "notContains",
  isEmpty: "isEmpty",
  isNotEmpty: "isNotEmpty",
};

export const COMPILER_TO_POLICY_OPERATOR: Partial<
  Record<CompilerConditionOperator, PolicyFieldOperator>
> = {
  equals: "eq",
  notEquals: "neq",
  in: "in",
  notIn: "notIn",
  greaterThan: "gt",
  lessThan: "lt",
  greaterThanOrEquals: "gte",
  lessThanOrEquals: "lte",
  contains: "contains",
  notContains: "notContains",
  isEmpty: "isEmpty",
  isNotEmpty: "isNotEmpty",
};
