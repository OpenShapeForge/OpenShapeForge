// SPDX-License-Identifier: BUSL-1.1
import type {
  CompilerConditionInput,
  CompilerConditionMode,
  CompilerConditionOperandInput,
  CompilerConditionOperator,
} from "@/generated/compiler/canonical-condition";
import {
  createLiteralOperand,
  createPathOperand,
  normalizeConditionOperand,
} from "./operands";

const DEFAULT_OPERATOR: CompilerConditionOperator = "equals";

export function createConditionId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createConditionRule(
  left: CompilerConditionOperandInput = createPathOperand(),
): AuthoredConditionRule {
  return {
    kind: "rule",
    id: createConditionId("rule"),
    operator: DEFAULT_OPERATOR,
    left,
    right: createLiteralOperand(""),
  };
}

export function createConditionGroup(
  mode: CompilerConditionMode = "all",
  left?: CompilerConditionOperandInput,
): AuthoredConditionGroup {
  return {
    kind: "group",
    id: createConditionId("group"),
    mode,
    conditions: [createConditionRule(left)],
  };
}

/**
 * The authoring UI only emits leaf operands (path / literal / function) for
 * rule left/right. The wider `CompilerExpressionInput` recursive type supports
 * formula/aggregate/date/if/etc — those are compiler-internal and never shown
 * in the condition builder, so we narrow the guard to the authored shape.
 */
export type AuthoredConditionRule = {
  kind?: "rule";
  id?: string;
  operator: CompilerConditionOperator;
  left: CompilerConditionOperandInput;
  right?: CompilerConditionOperandInput;
};

export type AuthoredConditionGroup = {
  kind?: "group";
  id?: string;
  mode?: CompilerConditionMode;
  conditions?: CompilerConditionInput[];
  all?: CompilerConditionInput[];
  any?: CompilerConditionInput[];
};

export function isConditionGroup(
  value: unknown,
): value is AuthoredConditionGroup {
  return (
    value != null &&
    typeof value === "object" &&
    ((("kind" in value ? (value as { kind?: unknown }).kind : undefined) === "group") ||
      "conditions" in value ||
      "all" in value ||
      "any" in value)
  );
}

export function isConditionRule(
  value: unknown,
): value is AuthoredConditionRule {
  return value != null && typeof value === "object" && "operator" in value;
}

export function getConditionGroupItems(
  value: AuthoredConditionGroup,
) {
  if (Array.isArray(value.conditions)) {
    return value.conditions;
  }

  if (Array.isArray(value.all)) {
    return value.all;
  }

  if (Array.isArray(value.any)) {
    return value.any;
  }

  return [];
}

export function getConditionGroupMode(
  value: AuthoredConditionGroup,
): CompilerConditionMode {
  if (value.mode === "any") {
    return "any";
  }

  if (Array.isArray(value.any)) {
    return "any";
  }

  return "all";
}

export function replaceConditionGroupItems(
  value: AuthoredConditionGroup,
  items: CompilerConditionInput[],
): AuthoredConditionGroup {
  return {
    kind: "group",
    id:
      typeof value.id === "string" && value.id.trim().length > 0
        ? value.id
        : createConditionId("group"),
    mode: getConditionGroupMode(value),
    conditions: items,
  };
}

export function replaceConditionGroupMode(
  value: AuthoredConditionGroup,
  mode: CompilerConditionMode,
): AuthoredConditionGroup {
  return {
    kind: "group",
    id:
      typeof value.id === "string" && value.id.trim().length > 0
        ? value.id
        : createConditionId("group"),
    mode,
    conditions: getConditionGroupItems(value),
  };
}

export function normalizeConditionInput(
  value: unknown,
  defaultLeftPath = "",
): AuthoredConditionGroup | AuthoredConditionRule {
  if (isConditionGroup(value)) {
    const items = getConditionGroupItems(value).map((item) =>
      normalizeConditionInput(item, defaultLeftPath),
    );
    return {
      kind: "group",
      id:
        typeof value.id === "string" && value.id.trim().length > 0
          ? value.id
          : createConditionId("group"),
      mode: getConditionGroupMode(value),
      conditions: items,
    };
  }

  if (isConditionRule(value)) {
    return {
      kind: "rule",
      id:
        typeof value.id === "string" && value.id.trim().length > 0
          ? value.id
          : createConditionId("rule"),
      operator: value.operator,
      left: normalizeConditionOperand(value.left, createPathOperand(defaultLeftPath)),
      right: normalizeConditionOperand(value.right, createLiteralOperand("")),
    };
  }

  return createConditionRule(createPathOperand(defaultLeftPath));
}

export function bindConditionLeftOperand(
  value: CompilerConditionInput,
  left: CompilerConditionOperandInput,
): AuthoredConditionGroup | AuthoredConditionRule {
  const normalized = normalizeConditionInput(value);
  if (isConditionGroup(normalized)) {
    return replaceConditionGroupItems(
      normalized,
      getConditionGroupItems(normalized).map((item) => bindConditionLeftOperand(item, left)),
    );
  }

  return {
    ...normalized,
    left,
  };
}

export function conditionUsesUnaryOperator(operator: CompilerConditionOperator) {
  return operator === "isEmpty" || operator === "isNotEmpty";
}
