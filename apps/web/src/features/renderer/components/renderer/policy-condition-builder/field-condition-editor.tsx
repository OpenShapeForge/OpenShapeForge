// SPDX-License-Identifier: BUSL-1.1
import {
  ConditionBuilder,
  type ConditionBuilderProps,
} from "@/features/renderer/components/renderer/condition-builder";
import {
  getConditionGroupItems,
  isConditionGroup,
  isConditionRule,
} from "@/features/renderer/runtime/conditions";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import type {
  CompilerConditionInput,
  CompilerConditionOperandInput,
  CompilerConditionOperator,
} from "@/generated/compiler/canonical-condition";
import {
  COMPILER_TO_POLICY_OPERATOR,
  POLICY_TO_COMPILER_OPERATOR,
} from "./options";
import { isRecord, normalizeFieldValue } from "./state";
import type { PolicyConditionLanguage, PolicyFieldCondition } from "./types";

function createLiteralOperand(value: unknown): CompilerConditionOperandInput {
  return { kind: "literal", value };
}

function fieldConditionToCompilerRule(
  value: PolicyFieldCondition,
): ConditionBuilderProps["value"] {
  const operator = POLICY_TO_COMPILER_OPERATOR[value.operator] ?? "equals";
  return {
    kind: "rule",
    operator,
    left: { kind: "path", path: value.field },
    ...(value.operator === "isEmpty" || value.operator === "isNotEmpty"
      ? {}
      : value.valueField !== undefined
        ? {
            right: {
              kind: "path",
              path: value.valueField,
            } satisfies CompilerConditionOperandInput,
          }
        : { right: createLiteralOperand(value.value ?? "") }),
  };
}

function extractSingleConditionRule(
  value: CompilerConditionInput,
): CompilerConditionInput | null {
  if (isConditionRule(value)) {
    return value;
  }

  if (!isConditionGroup(value)) {
    return null;
  }

  const items = getConditionGroupItems(value);
  if (items.length !== 1) {
    return null;
  }

  return extractSingleConditionRule(items[0]);
}

function compilerConditionToFieldCondition(
  value: CompilerConditionInput,
  fallback: PolicyFieldCondition,
): PolicyFieldCondition {
  const rule = extractSingleConditionRule(value);
  if (!rule || !isRecord(rule) || !("operator" in rule)) {
    return fallback;
  }
  const operator =
    COMPILER_TO_POLICY_OPERATOR[rule.operator as CompilerConditionOperator];
  if (!operator) {
    return fallback;
  }
  const left = rule.left;
  const field =
    isRecord(left) && left.kind === "path" && typeof left.path === "string"
      ? left.path
      : fallback.field;
  if (operator === "isEmpty" || operator === "isNotEmpty") {
    return { type: "field", field, operator };
  }
  const right = rule.right;
  if (isRecord(right) && right.kind === "path" && typeof right.path === "string") {
    return {
      type: "field",
      field,
      operator,
      valueField: right.path,
    };
  }
  const nextValue =
    isRecord(right) && right.kind === "literal"
      ? right.value
      : fallback.value ?? "";
  return {
    type: "field",
    field,
    operator,
    value: normalizeFieldValue(operator, nextValue) ?? "",
  };
}

export function FieldConditionEditor({
  value,
  lang,
  disabled,
  variableSuggestions,
  onChange,
}: {
  value: PolicyFieldCondition;
  lang: PolicyConditionLanguage;
  disabled?: boolean;
  variableSuggestions: VariableSuggestion[];
  onChange: (value: PolicyFieldCondition) => void;
}) {
  return (
    <ConditionBuilder
      value={fieldConditionToCompilerRule(value)}
      onChange={(nextValue) =>
        onChange(compilerConditionToFieldCondition(nextValue, value))
      }
      lang={lang}
      mode={{ kind: "free", defaultPath: value.field }}
      variableSuggestions={variableSuggestions}
      disabled={disabled}
    />
  );
}
