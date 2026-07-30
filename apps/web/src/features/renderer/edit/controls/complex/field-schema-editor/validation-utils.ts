// SPDX-License-Identifier: BUSL-1.1
import type {
  Field,
  FieldValidation,
  LocalizedText,
  ValidationRule,
} from "@/generated/compiler/field-contract";
import type { ValidationRuleKey } from "./types";
import { isRecord, hasMeaningfulValue, trimToUndefined, setLocalizedTextValue } from "./value-utils";

export function getValidationRuleValue(rule: FieldValidation[ValidationRuleKey]) {
  if (rule == null) {
    return undefined;
  }

  if (typeof rule === "object" && "value" in rule) {
    return rule.value;
  }

  return rule;
}

export function getValidationRuleMessage(
  rule: FieldValidation[ValidationRuleKey],
) {
  return rule && typeof rule === "object" && "message" in rule
    ? (rule.message as LocalizedText | undefined)
    : undefined;
}

export function buildValidationRule(
  value: boolean | number | string | undefined,
  message?: LocalizedText,
) {
  if (value === undefined) {
    return undefined;
  }

  if (message && Object.keys(message).length > 0) {
    return {
      value,
      message,
    } satisfies ValidationRule;
  }

  return value;
}

export function normalizeValidation(
  validation: FieldValidation | undefined,
): FieldValidation | undefined {
  if (!validation) {
    return undefined;
  }

  const next: FieldValidation = {};

  if (validation.required !== undefined) next.required = validation.required;
  if (validation.minLength !== undefined) next.minLength = validation.minLength;
  if (validation.maxLength !== undefined) next.maxLength = validation.maxLength;
  if (validation.min !== undefined) next.min = validation.min;
  if (validation.max !== undefined) next.max = validation.max;
  if (validation.pattern !== undefined) next.pattern = validation.pattern;

  if (validation.custom?.length) {
    next.custom = validation.custom.filter(
      (rule) => trimToUndefined(rule.name) !== undefined || hasMeaningfulValue(rule.params),
    );
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function updateValidationRuleValue(
  field: Field,
  key: ValidationRuleKey,
  nextValue: boolean | number | string | undefined,
) {
  const nextValidation = {
    ...(field.validation ?? {}),
    [key]: buildValidationRule(
      nextValue,
      getValidationRuleMessage(field.validation?.[key]),
    ),
  } satisfies FieldValidation;

  return {
    ...field,
    validation: normalizeValidation(nextValidation),
  };
}

export function updateValidationRuleMessage(
  field: Field,
  key: ValidationRuleKey,
  lang: "nl" | "en",
  nextText: string,
  fallbackValue?: boolean | number | string,
) {
  const currentRule = field.validation?.[key];
  const currentValue = getValidationRuleValue(currentRule);
  const nextValue = currentValue ?? fallbackValue;

  if (nextValue === undefined) {
    return field;
  }

  const nextMessage = setLocalizedTextValue(
    getValidationRuleMessage(currentRule),
    lang,
    nextText,
  );

  const nextValidation = {
    ...(field.validation ?? {}),
    [key]: buildValidationRule(nextValue, nextMessage),
  } satisfies FieldValidation;

  return {
    ...field,
    validation: normalizeValidation(nextValidation),
  };
}

export function getEffectiveRequired(field: Field) {
  const cardinality = field.cardinality;
  if (isRecord(cardinality) && typeof cardinality.min === "number") {
    return cardinality.min > 0;
  }
  const validationRequired = getValidationRuleValue(field.validation?.required);
  return field.required === true || validationRequired === true;
}
