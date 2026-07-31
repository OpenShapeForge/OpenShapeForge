// SPDX-License-Identifier: BUSL-1.1
import type { CompilerConditionOperandInput } from "@/generated/compiler/canonical-condition";

/** New rule operands start without a path so authors pick from dynamic variables (`nodes.…`), not runtime `input.*` aliases. */
export function createPathOperand(path = ""): CompilerConditionOperandInput {
  return { kind: "path", path };
}

export function createLiteralOperand(value: unknown = ""): CompilerConditionOperandInput {
  return { kind: "literal", value };
}

export function createFunctionOperand(
  name: "today",
  offset?: { days: number },
): CompilerConditionOperandInput {
  if (offset && offset.days !== 0) {
    return { kind: "function", name, offset };
  }
  return { kind: "function", name };
}

function extractLiteralVariablePath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  const path = match?.[1]?.trim();
  if (!path || /[\s{}]/.test(path)) {
    return null;
  }

  return path;
}

export function normalizeConditionOperand(
  operand: CompilerConditionOperandInput | undefined,
  fallback: CompilerConditionOperandInput,
): CompilerConditionOperandInput {
  if (operand?.kind === "path" || operand?.kind === "function") {
    return operand;
  }

  if (operand?.kind === "literal") {
    const variablePath = extractLiteralVariablePath(operand.value);
    return variablePath ? createPathOperand(variablePath) : operand;
  }

  return fallback;
}
