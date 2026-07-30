// SPDX-License-Identifier: BUSL-1.1
import type { LabelRule } from "./label-evaluator";

export function recordToLabelRule(
  rule: Record<string, unknown>,
): LabelRule {
  return {
    id: String(rule.id),
    label: String(rule.label ?? ""),
    variant: String(rule.variant ?? "default"),
    condition: readCondition(rule),
    descriptionTemplate: (rule.descriptionTemplate as string | null) ?? null,
    priority: Number(rule.priority ?? 0),
  };
}

function readCondition(rule: Record<string, unknown>): LabelRule["condition"] {
  const expression = rule.expression ?? rule.condition;
  return (expression as LabelRule["condition"]) ?? null;
}
