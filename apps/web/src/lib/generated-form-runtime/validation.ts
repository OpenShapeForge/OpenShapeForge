// SPDX-License-Identifier: BUSL-1.1
import type {
  GeneratedCustomValidationRule,
  GeneratedFormConfig,
  GeneratedFormFieldConfig,
  GeneratedFormFieldErrors,
} from "./types";
import {
  getDefaultValidationMessage,
  getRuleMessage,
  getRuleValue,
  translate,
} from "./errors";

function passesElfproef(value: string): boolean {
  if (!/^[0-9]{9}$/.test(value)) {
    return false;
  }

  const digits = value.split("").map((digit) => Number(digit));
  const checksum =
    digits[0] * 9
    + digits[1] * 8
    + digits[2] * 7
    + digits[3] * 6
    + digits[4] * 5
    + digits[5] * 4
    + digits[6] * 3
    + digits[7] * 2
    - digits[8];

  return checksum % 11 === 0;
}

function runCustomValidator(
  rule: GeneratedCustomValidationRule,
  value: string,
): boolean {
  switch (rule.name) {
    case "elfproef":
      return passesElfproef(value);
    default:
      return true;
  }
}

function getCustomValidationMessage(
  field: GeneratedFormFieldConfig,
  rule: GeneratedCustomValidationRule,
  lang: string,
): string {
  return (
    translate(rule.message, lang)
    || getDefaultValidationMessage(
      field.label,
      field.key,
      lang,
      "heeft een ongeldige waarde.",
      "has an invalid value.",
    )
  );
}

export function isGeneratedFieldRequired(field: GeneratedFormFieldConfig): boolean {
  const requiredRule = getRuleValue(field.validation?.required);
  return Boolean(field.required || requiredRule);
}

export function validateGeneratedFieldValue(
  field: GeneratedFormFieldConfig,
  value: unknown,
  _values: Record<string, unknown>,
  lang: string,
): string | undefined {
  const stringValue = typeof value === "string" ? value : value == null ? "" : String(value);
  const isEmpty = value == null || value === "";

  if (isGeneratedFieldRequired(field) && isEmpty) {
    return (
      getRuleMessage(field.validation?.required, lang)
      || getDefaultValidationMessage(
        field.label,
        field.key,
        lang,
        "is verplicht.",
        "is required.",
      )
    );
  }

  if (stringValue.length === 0) {
    return undefined;
  }

  const minLength = getRuleValue(field.validation?.minLength);
  if (typeof minLength === "number" && stringValue.length < minLength) {
    return (
      getRuleMessage(field.validation?.minLength, lang)
      || getDefaultValidationMessage(
        field.label,
        field.key,
        lang,
        `moet minimaal ${minLength} tekens bevatten.`,
        `must be at least ${minLength} characters.`,
      )
    );
  }

  const maxLength = getRuleValue(field.validation?.maxLength);
  if (typeof maxLength === "number" && stringValue.length > maxLength) {
    return (
      getRuleMessage(field.validation?.maxLength, lang)
      || getDefaultValidationMessage(
        field.label,
        field.key,
        lang,
        `mag maximaal ${maxLength} tekens bevatten.`,
        `must be at most ${maxLength} characters.`,
      )
    );
  }

  const min = getRuleValue(field.validation?.min);
  if (typeof min === "number" && typeof value === "number" && value < min) {
    return (
      getRuleMessage(field.validation?.min, lang)
      || getDefaultValidationMessage(
        field.label,
        field.key,
        lang,
        `moet minimaal ${min} zijn.`,
        `must be at least ${min}.`,
      )
    );
  }

  const max = getRuleValue(field.validation?.max);
  if (typeof max === "number" && typeof value === "number" && value > max) {
    return (
      getRuleMessage(field.validation?.max, lang)
      || getDefaultValidationMessage(
        field.label,
        field.key,
        lang,
        `mag maximaal ${max} zijn.`,
        `must be at most ${max}.`,
      )
    );
  }

  const pattern = getRuleValue(field.validation?.pattern);
  if (typeof pattern === "string" && !new RegExp(pattern).test(stringValue)) {
    return (
      getRuleMessage(field.validation?.pattern, lang)
      || getDefaultValidationMessage(
        field.label,
        field.key,
        lang,
        "heeft een ongeldig formaat.",
        "has an invalid format.",
      )
    );
  }

  for (const rule of field.validation?.custom ?? []) {
    if (!runCustomValidator(rule, stringValue)) {
      return getCustomValidationMessage(field, rule, lang);
    }
  }

  return undefined;
}

export function validateGeneratedFormValues(
  config: GeneratedFormConfig,
  values: Record<string, unknown>,
  lang: string,
): GeneratedFormFieldErrors | undefined {
  const fieldErrors: GeneratedFormFieldErrors = {};

  for (const field of config.fields) {
    const message = validateGeneratedFieldValue(field, values[field.key], values, lang);
    if (message) {
      fieldErrors[field.key] = message;
    }
  }

  return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined;
}

export { translate };
