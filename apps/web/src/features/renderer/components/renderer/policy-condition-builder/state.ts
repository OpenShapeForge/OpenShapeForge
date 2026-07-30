// SPDX-License-Identifier: BUSL-1.1
import { FIELD_OPERATORS } from "./options";
import type {
  PolicyCondition,
  PolicyConditionType,
  PolicyFieldOperator,
} from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isPolicyFieldOperator(value: unknown): value is PolicyFieldOperator {
  return (
    typeof value === "string" &&
    FIELD_OPERATORS.some((entry) => entry.value === value)
  );
}

export function normalizeFieldValue(
  operator: PolicyFieldOperator,
  value: unknown,
) {
  if (operator === "isEmpty" || operator === "isNotEmpty") return undefined;
  if (operator === "in" || operator === "notIn") return asStringArray(value);
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return "";
}

export function normalizeCondition(value: unknown): PolicyCondition {
  if (!isRecord(value)) return { type: "always" };

  switch (value.type) {
    case "always":
    case "never":
    case "taskAssignee":
      return { type: value.type };
    case "actorRole":
      return { type: "actorRole", anyOf: asStringArray(value.anyOf) };
    case "actorGroup":
      return { type: "actorGroup", anyOf: asStringArray(value.anyOf) };
    case "field": {
      const operator = isPolicyFieldOperator(value.operator) ? value.operator : "eq";
      const field = typeof value.field === "string" ? value.field : "";
      const valueField =
        typeof value.valueField === "string" ? value.valueField : "";
      if (
        typeof value.valueField === "string" &&
        operator !== "isEmpty" &&
        operator !== "isNotEmpty" &&
        operator !== "in" &&
        operator !== "notIn"
      ) {
        return { type: "field", field, operator, valueField };
      }
      const fieldValue = normalizeFieldValue(operator, value.value);
      return fieldValue === undefined
        ? { type: "field", field, operator }
        : { type: "field", field, operator, value: fieldValue };
    }
    case "all":
    case "any":
      return {
        type: value.type,
        conditions: Array.isArray(value.conditions)
          ? value.conditions.map((entry) => normalizeCondition(entry))
          : [],
      };
    case "not":
      return { type: "not", condition: normalizeCondition(value.condition) };
    default:
      return { type: "always" };
  }
}

export function defaultCondition(type: PolicyConditionType): PolicyCondition {
  switch (type) {
    case "actorRole":
      return { type, anyOf: [] };
    case "actorGroup":
      return { type, anyOf: [] };
    case "field":
      return { type, field: "", operator: "eq", value: "" };
    case "all":
    case "any":
      return { type, conditions: [] };
    case "not":
      return { type, condition: { type: "always" } };
    case "always":
    case "never":
    case "taskAssignee":
      return { type };
  }
}

export function updateListValue(
  values: string[],
  index: number,
  nextValue: string,
): string[] {
  return values.map((value, valueIndex) =>
    valueIndex === index ? nextValue : value,
  );
}

export function conditionUsesField(condition: PolicyCondition): boolean {
  switch (condition.type) {
    case "field":
      return true;
    case "all":
    case "any":
      return condition.conditions.some((entry) => conditionUsesField(entry));
    case "not":
      return conditionUsesField(condition.condition);
    case "always":
    case "never":
    case "actorRole":
    case "actorGroup":
    case "taskAssignee":
      return false;
  }
}
