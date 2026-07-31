// SPDX-License-Identifier: BUSL-1.1
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { CONDITION_TYPES, FIELD_OPERATORS } from "./options";
import { normalizeCondition } from "./state";
import type {
  PolicyCondition,
  PolicyConditionLanguage,
  PolicyConditionType,
  PolicyFieldCondition,
  PolicyFieldOperator,
} from "./types";

function formatPolicyValue(
  value: unknown,
  lang: PolicyConditionLanguage,
): string {
  if (Array.isArray(value)) {
    return value.map((entry) => formatPolicyValue(entry, lang)).join(", ");
  }
  if (typeof value === "boolean") {
    return lang === "nl" ? (value ? "Ja" : "Nee") : value ? "Yes" : "No";
  }
  if (value == null || value === "") {
    return "-";
  }
  return String(value);
}

function getPolicyFieldOperatorLabel(
  operator: PolicyFieldOperator,
  lang: PolicyConditionLanguage,
): string {
  return (
    FIELD_OPERATORS.find((entry) => entry.value === operator)?.label[lang] ??
    operator
  );
}

function getPolicyConditionTypeLabel(
  type: PolicyConditionType,
  lang: PolicyConditionLanguage,
): string {
  return (
    CONDITION_TYPES.find((entry) => entry.value === type)?.label[lang] ?? type
  );
}

function findFieldSuggestion(
  field: string,
  variableSuggestions: readonly VariableSuggestion[],
) {
  return variableSuggestions.find((suggestion) => suggestion.path === field);
}

function formatFieldConditionForDisplay(
  condition: PolicyFieldCondition,
  lang: PolicyConditionLanguage,
  variableSuggestions: readonly VariableSuggestion[],
) {
  const suggestion = findFieldSuggestion(condition.field, variableSuggestions);
  const fieldLabel =
    (suggestion?.displayLabel ?? suggestion?.label ?? condition.field) || "-";
  const operator = getPolicyFieldOperatorLabel(condition.operator, lang);
  const unary =
    condition.operator === "isEmpty" || condition.operator === "isNotEmpty";
  if (unary) {
    return `${fieldLabel} ${operator}`;
  }

  const options = suggestion?.options;
  const rawValue = condition.value;
  const valueFieldSuggestion =
    condition.valueField !== undefined
      ? findFieldSuggestion(condition.valueField, variableSuggestions)
      : null;
  const value = valueFieldSuggestion
    ? (valueFieldSuggestion.displayLabel ??
      valueFieldSuggestion.label ??
      condition.valueField)
    : condition.valueField
      ? condition.valueField
      : Array.isArray(rawValue) && options?.length
        ? rawValue
            .map(
              (entry) =>
                options.find((option) => option.value === entry)?.label ?? entry,
            )
            .join(", ")
        : typeof rawValue === "string" && options?.length
          ? (options.find((option) => option.value === rawValue)?.label ??
            rawValue)
          : formatPolicyValue(rawValue, lang);

  return `${fieldLabel} ${operator} ${value}`;
}

function formatPolicyConditionLine(
  condition: PolicyCondition,
  lang: PolicyConditionLanguage,
  variableSuggestions: readonly VariableSuggestion[],
) {
  switch (condition.type) {
    case "always":
    case "never":
    case "taskAssignee":
      return getPolicyConditionTypeLabel(condition.type, lang);
    case "actorRole":
      return `${getPolicyConditionTypeLabel(condition.type, lang)}: ${
        condition.anyOf.join(", ") || "-"
      }`;
    case "actorGroup":
      return `${getPolicyConditionTypeLabel(condition.type, lang)}: ${
        condition.anyOf.join(", ") || "-"
      }`;
    case "field":
      return formatFieldConditionForDisplay(condition, lang, variableSuggestions);
    case "not":
      return `${getPolicyConditionTypeLabel(condition.type, lang)}:`;
    case "all":
    case "any":
      return getPolicyConditionTypeLabel(condition.type, lang);
  }
}

function PolicyConditionDisplayNode({
  condition,
  lang,
  variableSuggestions,
  level = 0,
}: {
  condition: PolicyCondition;
  lang: PolicyConditionLanguage;
  variableSuggestions: readonly VariableSuggestion[];
  level?: number;
}) {
  if (condition.type === "all" || condition.type === "any") {
    const children = condition.conditions;
    return (
      <div className={level > 0 ? "border-l border-border/60 pl-3" : undefined}>
        <p className="text-sm font-medium text-foreground">
          {formatPolicyConditionLine(condition, lang, variableSuggestions)}
        </p>
        {children.length > 0 ? (
          <ul className="mt-1 space-y-1 pl-4">
            {children.map((child, index) => (
              <li
                key={index}
                className="list-disc marker:text-muted-foreground/70"
              >
                <PolicyConditionDisplayNode
                  condition={child}
                  lang={lang}
                  variableSuggestions={variableSuggestions}
                  level={level + 1}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm italic text-muted-foreground">
            {lang === "nl" ? "Geen voorwaarden" : "No conditions"}
          </p>
        )}
      </div>
    );
  }

  if (condition.type === "not") {
    return (
      <div className={level > 0 ? "border-l border-border/60 pl-3" : undefined}>
        <p className="text-sm font-medium text-foreground">
          {formatPolicyConditionLine(condition, lang, variableSuggestions)}
        </p>
        <div className="mt-1">
          <PolicyConditionDisplayNode
            condition={condition.condition}
            lang={lang}
            variableSuggestions={variableSuggestions}
            level={level + 1}
          />
        </div>
      </div>
    );
  }

  return (
    <span className="text-sm leading-6 text-foreground">
      {formatPolicyConditionLine(condition, lang, variableSuggestions)}
    </span>
  );
}

export function PolicyConditionDisplay({
  value,
  lang,
  variableSuggestions = [],
}: {
  value: unknown;
  lang: PolicyConditionLanguage;
  variableSuggestions?: readonly VariableSuggestion[];
}) {
  const condition = normalizeCondition(value);
  return (
    <div className="space-y-1">
      <PolicyConditionDisplayNode
        condition={condition}
        lang={lang}
        variableSuggestions={variableSuggestions}
      />
    </div>
  );
}
