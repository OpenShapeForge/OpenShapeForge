// SPDX-License-Identifier: BUSL-1.1
import type {
  CompilerConditionInput,
  CompilerConditionOperandInput,
} from "@/generated/compiler/canonical-condition";
import {
  conditionUsesUnaryOperator,
  getConditionGroupItems,
  getConditionGroupMode,
  isConditionGroup,
  normalizeConditionInput,
} from "./model";
import { createLiteralOperand } from "./operands";

function formatOperandSummary(operand: CompilerConditionOperandInput): string {
  if (operand.kind === "function") {
    const base = operand.name;
    if (operand.offset && operand.offset.days !== 0) {
      const sign = operand.offset.days > 0 ? "+" : "";
      return `${base}${sign}${operand.offset.days}d`;
    }
    return base;
  }

  if (operand.kind === "path") {
    const base = operand.path;
    if (operand.offset && operand.offset.days !== 0) {
      const sign = operand.offset.days > 0 ? "+" : "";
      return `${base}${sign}${operand.offset.days}d`;
    }
    return base;
  }

  return String(operand.value ?? "");
}

export function summarizeCondition(value: CompilerConditionInput | null | undefined): string {
  if (!value) {
    return "";
  }

  const normalized = normalizeConditionInput(value);
  if (isConditionGroup(normalized)) {
    const items = getConditionGroupItems(normalized).map((item) => summarizeCondition(item));
    const glue = getConditionGroupMode(normalized) === "any" ? " OR " : " AND ";
    return items.filter(Boolean).join(glue);
  }

  const left = formatOperandSummary(normalized.left);
  const rightOperand = normalized.right ?? createLiteralOperand("");
  const right = formatOperandSummary(rightOperand);

  if (conditionUsesUnaryOperator(normalized.operator)) {
    return `${left} ${normalized.operator}`;
  }

  return `${left} ${normalized.operator} ${right}`;
}
