// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
// Source file for the shared label-rule autocomplete helper.
// This file is copied (with the field-contract import path rewritten per target)
// into consumer repos by the workflow-contract generator. Keep the logic
// self-contained — only Field / ContextHints types are imported so the behaviour
// stays DB/IO agnostic.
//
// Responsibilities:
//  - Translate a runtime `LabelRuleAutocompleteEntry` into a synthetic `Field`
//    that the workflow variable-suggestion provider can render.
//  - Tag every synthetic field with `hints.sourceHint = LABEL_RULE_SOURCE_HINT`
//    so renderers can distinguish runtime label values from persisted columns.
//  - Merge synthetic entries into an existing list of persisted fields without
//    shadowing keys that already exist (persisted wins), and without duplicating
//    keys that appear twice in the incoming rule list.
//
// The module does not fetch rules, resolve the entity type, or know anything
// about node actions — callers preload rules and filter the output if they need
// per-action / per-handle gating (see openshapeforge-workflow entity-workflow.ts).

import type { Field, ContextHints } from "./field-contract.js";

/** The minimal shape this module needs from a label rule record. */
export type LabelRuleAutocompleteEntry = {
  key: string;
  outputType: "boolean" | "number" | "string";
};

/**
 * Tag written to `Field.hints.sourceHint` so the workflow variable-suggestion
 * provider can mark the resulting suggestion as a runtime label-rule entry
 * instead of a persisted entity field. Scoped with a prefix so it can never
 * collide with the compiler's own `aggregate:{Target}:{relationship}` hint.
 */
export const LABEL_RULE_SOURCE_HINT = "labelRule";

function labelRuleOutputTypeToFieldValueType(
  outputType: LabelRuleAutocompleteEntry["outputType"],
): Field["valueType"] {
  switch (outputType) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return "string";
  }
}

function labelRuleToField(rule: LabelRuleAutocompleteEntry): Field {
  const hints: ContextHints = {
    sourceHint: LABEL_RULE_SOURCE_HINT,
  };
  return {
    key: rule.key,
    valueType: labelRuleOutputTypeToFieldValueType(rule.outputType),
    label: { nl: rule.key, en: rule.key },
    description: {
      nl: "Berekende waarde uit label_rules (runtime).",
      en: "Computed value from label_rules (runtime).",
    },
    hints,
  };
}

/**
 * Append synthetic label-rule `Field` entries to an existing list of persisted
 * output fields. Skips keys that already exist on the persisted list so the
 * static field wins on collision, and dedupes repeated keys within `rules`.
 * Empty / whitespace-only rule keys are ignored.
 */
export function appendLabelRuleFieldsToOutputFields(
  outputFields: readonly Field[],
  rules: readonly LabelRuleAutocompleteEntry[],
): Field[] {
  if (rules.length === 0) {
    return outputFields.slice();
  }

  const existingKeys = new Set(
    outputFields
      .map((field) => (typeof field.key === "string" ? field.key.trim() : ""))
      .filter((key) => key.length > 0),
  );

  const seen = new Set<string>();
  const ruleFields: Field[] = [];
  for (const rule of rules) {
    const key = typeof rule.key === "string" ? rule.key.trim() : "";
    if (!key || existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    ruleFields.push(labelRuleToField({ key, outputType: rule.outputType }));
  }

  return [...outputFields, ...ruleFields];
}
