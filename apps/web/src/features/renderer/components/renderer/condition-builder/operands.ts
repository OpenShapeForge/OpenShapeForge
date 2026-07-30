// SPDX-License-Identifier: BUSL-1.1
import type {
  CompilerConditionOperandInput,
  CompilerConditionOperator,
} from "@/generated/compiler/canonical-condition";
import {
  conditionUsesUnaryOperator,
  createLiteralOperand,
} from "@/features/renderer/runtime/conditions";
import { LIST_LITERAL_OPERATORS } from "./operator-options";

export function operandToInputValue(
  operand: CompilerConditionOperandInput | undefined,
) {
  if (!operand) {
    return "";
  }

  if (operand.kind === "path") {
    return operand.path;
  }

  if (operand.kind === "function") {
    return "";
  }

  if (Array.isArray(operand.value)) {
    return operand.value.join(", ");
  }

  if (typeof operand.value === "string" || typeof operand.value === "number") {
    return String(operand.value);
  }

  if (typeof operand.value === "boolean") {
    return operand.value ? "true" : "false";
  }

  return "";
}

export function parseLiteralInput(
  operator: CompilerConditionOperator,
  input: string,
): CompilerConditionOperandInput {
  if (operator === "in" || operator === "notIn") {
    return createLiteralOperand(
      input
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    );
  }

  if (input === "true") return createLiteralOperand(true);
  if (input === "false") return createLiteralOperand(false);

  const numeric = Number(input);
  if (input.trim().length > 0 && !Number.isNaN(numeric) && `${numeric}` === input.trim()) {
    return createLiteralOperand(numeric);
  }

  return createLiteralOperand(input);
}

export function listLiteralValues(
  operand: CompilerConditionOperandInput | undefined,
): string[] {
  if (operand?.kind !== "literal") {
    return [];
  }

  if (Array.isArray(operand.value)) {
    return operand.value
      .flatMap((entry) =>
        typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
          ? [String(entry)]
          : [],
      )
      .filter((entry) => entry.trim().length > 0);
  }

  if (
    typeof operand.value === "string" ||
    typeof operand.value === "number" ||
    typeof operand.value === "boolean"
  ) {
    const nextValue = String(operand.value);
    if (nextValue.trim().length > 0) {
      return [nextValue];
    }
  }

  return [];
}

export function normalizeRightOperandForOperator(
  operator: CompilerConditionOperator,
  operand: CompilerConditionOperandInput | undefined,
): CompilerConditionOperandInput {
  if (conditionUsesUnaryOperator(operator)) {
    return operand ?? createLiteralOperand("");
  }

  if (operand?.kind !== "literal") {
    return operand ?? createLiteralOperand("");
  }

  if (LIST_LITERAL_OPERATORS.has(operator)) {
    return createLiteralOperand(listLiteralValues(operand));
  }

  if (Array.isArray(operand.value)) {
    return createLiteralOperand(listLiteralValues(operand)[0] ?? "");
  }

  return operand;
}
