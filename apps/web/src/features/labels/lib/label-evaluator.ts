// SPDX-License-Identifier: BUSL-1.1
import type {
  CompilerConditionInput,
  CompilerConditionOperator,
} from "@/generated/compiler/canonical-condition";
import {
  getValueAtPath,
  parseRendererPath,
} from "@/features/renderer/runtime/path-utils";
import {
  isConditionGroup,
  isConditionRule,
  getConditionGroupItems,
  getConditionGroupMode,
} from "@/features/renderer/runtime/conditions";

export type LabelRule = {
  id: string;
  label: string;
  variant: string;
  condition: CompilerConditionInput | null;
  descriptionTemplate: string | null;
  priority: number;
};

export type EvaluatedLabel = {
  id: string;
  label: string;
  variant: string;
  description: string | null;
};

/**
 * Evaluate label rules against entity data and return matching labels
 * sorted by priority (highest first).
 */
export function evaluateLabels(
  rules: LabelRule[],
  entityData: Record<string, unknown>,
): EvaluatedLabel[] {
  return rules
    .filter((rule) => evaluateCondition(rule.condition, entityData))
    .sort((a, b) => b.priority - a.priority)
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      variant: rule.variant,
      description: rule.descriptionTemplate
        ? interpolateTemplate(rule.descriptionTemplate, entityData)
        : null,
    }));
}

/**
 * Evaluate a CompilerConditionInput against entity data.
 * Returns true if the condition matches (or if condition is null/empty).
 */
function evaluateCondition(
  condition: CompilerConditionInput | null | undefined,
  data: Record<string, unknown>,
): boolean {
  if (!condition) {
    return true;
  }

  if (isConditionGroup(condition)) {
    const items = getConditionGroupItems(condition);
    if (items.length === 0) {
      return true;
    }

    const mode = getConditionGroupMode(condition);
    return mode === "any"
      ? items.some((item) => evaluateCondition(item, data))
      : items.every((item) => evaluateCondition(item, data));
  }

  if (isConditionRule(condition)) {
    const left = resolveOperand(condition.left, data);
    const operator = condition.operator;

    if (isUnaryOperator(operator)) {
      return evaluateUnary(operator, left);
    }

    const right = resolveOperand(condition.right ?? { kind: "literal", value: "" }, data);
    return evaluateBinary(operator, left, right);
  }

  return true;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function applyDateOffset(value: unknown, offset: { days: number } | undefined): unknown {
  if (!offset || offset.days === 0) return value;
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return value;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  date.setDate(date.getDate() + offset.days);
  return date.toISOString().slice(0, 10);
}

function resolveOperand(
  operand: { kind: string; path?: string; value?: unknown; name?: string; offset?: { days: number } },
  data: Record<string, unknown>,
): unknown {
  if (operand.kind === "function" && operand.name === "today") {
    const today = new Date().toISOString().slice(0, 10);
    return applyDateOffset(today, operand.offset);
  }
  if (operand.kind === "path" && typeof operand.path === "string") {
    const value = getValueAtPath(data, parseRendererPath(operand.path));
    return applyDateOffset(value, operand.offset);
  }
  return operand.value;
}

function isUnaryOperator(operator: CompilerConditionOperator): boolean {
  return operator === "isEmpty" || operator === "isNotEmpty";
}

function evaluateUnary(operator: CompilerConditionOperator, value: unknown): boolean {
  const empty =
    value == null || value === "" || (Array.isArray(value) && value.length === 0);

  return operator === "isEmpty" ? empty : !empty;
}

function evaluateBinary(
  operator: CompilerConditionOperator,
  left: unknown,
  right: unknown,
): boolean {
  switch (operator) {
    case "equals":
      return left === right || String(left) === String(right);
    case "notEquals":
      return left !== right && String(left) !== String(right);
    case "greaterThan":
      return (compareValues(left, right) ?? -1) > 0;
    case "greaterThanOrEquals":
      return (compareValues(left, right) ?? -1) >= 0;
    case "lessThan":
      return (compareValues(left, right) ?? 1) < 0;
    case "lessThanOrEquals":
      return (compareValues(left, right) ?? 1) <= 0;
    case "contains":
      return typeof left === "string" && typeof right === "string"
        ? left.includes(right)
        : false;
    case "notContains":
      return typeof left === "string" && typeof right === "string"
        ? !left.includes(right)
        : true;
    case "startsWith":
      return typeof left === "string" && typeof right === "string"
        ? left.startsWith(right)
        : false;
    case "endsWith":
      return typeof left === "string" && typeof right === "string"
        ? left.endsWith(right)
        : false;
    case "in":
      return Array.isArray(right) ? right.includes(left) : false;
    case "notIn":
      return Array.isArray(right) ? !right.includes(left) : true;
    default:
      return false;
  }
}

function compareValues(left: unknown, right: unknown): number | null {
  if (left == null || right == null) return null;
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return String(left).localeCompare(String(right), "nl");
}

/**
 * Replace `{{path}}` placeholders in a template string with values from entity data.
 */
function interpolateTemplate(
  template: string,
  data: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const value = getValueAtPath(data, parseRendererPath(path.trim()));
    if (value == null) return "";
    return String(value);
  });
}
