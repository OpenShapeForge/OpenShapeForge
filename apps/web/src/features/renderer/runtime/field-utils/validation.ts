// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { resolveFieldValidation } from "@/lib/field-rendering/compiler-field-rendering";
import { translateRendererText } from "./text";

type RendererCustomValidatorArgs = {
  field: Field;
  value: unknown;
  values: Record<string, unknown>;
  lang: string;
  params?: Record<string, unknown>;
};

type RendererCustomValidator = (
  args: RendererCustomValidatorArgs,
) => string | undefined;

export const defaultRendererValidationRegistry: Record<
  string,
  RendererCustomValidator
> = {
  iban: ({ lang, value }) => validateIbanValue(value, lang),
  elfproef: ({ lang, params, value }) =>
    validateElfproefValue(value, lang, params),
};

function getRuleValue(rule: unknown) {
  if (
    rule &&
    typeof rule === "object" &&
    "value" in rule &&
    (typeof (rule as { value?: unknown }).value === "string" ||
      typeof (rule as { value?: unknown }).value === "number" ||
      typeof (rule as { value?: unknown }).value === "boolean")
  ) {
    return (rule as { value: string | number | boolean }).value;
  }

  return rule;
}

function getRuleMessage(rule: unknown, lang: string) {
  if (
    rule &&
    typeof rule === "object" &&
    "message" in rule &&
    typeof (rule as { message?: unknown }).message === "object" &&
    (rule as { message?: Record<string, string> }).message
  ) {
    return translateRendererText(
      (rule as { message?: Record<string, string> }).message,
      lang,
    );
  }

  return "";
}

export function validateRendererFieldValue(
  field: Field,
  value: unknown,
  values: Record<string, unknown>,
  lang: string,
): string | undefined {
  if (field.computed) {
    return undefined;
  }

  const label = translateRendererText(field.label, lang) || field.key;
  const validation = resolveFieldValidation(field);
  const requiredRule = validation?.required ?? field.required;
  const requiredValue = getRuleValue(requiredRule);
  const requiredMessage = getRuleMessage(requiredRule, lang);
  // Note: `false` and `0` are valid values, not "empty". A required boolean
  // field must accept `false` (otherwise a toggle can never be turned off).
  const isEmpty =
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);

  if (requiredValue === true && isEmpty) {
    return (
      requiredMessage ||
      `${label} ${lang === "nl" ? "is verplicht." : "is required."}`
    );
  }

  if (isEmpty || !validation) {
    return undefined;
  }

  const stringValue = typeof value === "string" ? value : String(value);

  const minLength = getRuleValue(validation.minLength);
  if (typeof minLength === "number" && stringValue.length < minLength) {
    return (
      getRuleMessage(validation.minLength, lang) ||
      `${label} ${lang === "nl" ? "is te kort." : "is too short."}`
    );
  }

  const maxLength = getRuleValue(validation.maxLength);
  if (typeof maxLength === "number" && stringValue.length > maxLength) {
    return (
      getRuleMessage(validation.maxLength, lang) ||
      `${label} ${lang === "nl" ? "is te lang." : "is too long."}`
    );
  }

  const min = getRuleValue(validation.min);
  if (typeof min === "number" && typeof value === "number" && value < min) {
    return (
      getRuleMessage(validation.min, lang) ||
      `${label} ${lang === "nl" ? "is te laag." : "is too low."}`
    );
  }

  const max = getRuleValue(validation.max);
  if (typeof max === "number" && typeof value === "number" && value > max) {
    return (
      getRuleMessage(validation.max, lang) ||
      `${label} ${lang === "nl" ? "is te hoog." : "is too high."}`
    );
  }

  const pattern = getRuleValue(validation.pattern);
  if (typeof pattern === "string" && !new RegExp(pattern).test(stringValue)) {
    return (
      getRuleMessage(validation.pattern, lang) ||
      `${label} ${lang === "nl" ? "heeft geen geldig formaat." : "has an invalid format."}`
    );
  }

  for (const customRule of validation.custom ?? []) {
    const validator = defaultRendererValidationRegistry[customRule.name];
    if (!validator) {
      continue;
    }

    const message = validator({
      field,
      value,
      values,
      lang,
      params: customRule.params,
    });

    if (message) {
      return translateRendererText(customRule.message, lang) || message;
    }
  }

  return undefined;
}

function validateIbanValue(value: unknown, lang: string): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(normalized)) {
    return lang === "nl" ? "Voer een geldig IBAN in." : "Enter a valid IBAN.";
  }

  const rearranged = `${normalized.slice(4)}${normalized.slice(0, 4)}`;
  let remainder = 0;

  for (const character of rearranged) {
    const numericChunk =
      character >= "A" && character <= "Z"
        ? String(character.charCodeAt(0) - 55)
        : character;

    for (const digit of numericChunk) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }

  return remainder === 1
    ? undefined
    : lang === "nl"
      ? "Voer een geldig IBAN in."
      : "Enter a valid IBAN.";
}

function validateElfproefValue(
  value: unknown,
  lang: string,
  params?: Record<string, unknown>,
): string | undefined {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim().length === 0
  ) {
    return undefined;
  }

  const digits = String(value).replace(/\D+/g, "");
  if (digits.length === 0) {
    return undefined;
  }

  const variant =
    params?.variant === "bank" || params?.algorithm === "bank" ? "bank" : "bsn";
  const expectedLength =
    typeof params?.length === "number" && Number.isInteger(params.length)
      ? params.length
      : variant === "bsn"
        ? 9
        : digits.length;

  if (digits.length !== expectedLength) {
    return lang === "nl" ? "Voer een geldige waarde in." : "Enter a valid value.";
  }

  const numbers = digits.split("").map((digit) => Number(digit));
  const checksum =
    variant === "bsn"
      ? numbers.reduce((sum, digit, index) => {
          const weight =
            index === numbers.length - 1 ? -1 : numbers.length - index;
          return sum + digit * weight;
        }, 0)
      : numbers.reduce(
          (sum, digit, index) => sum + digit * (numbers.length - index),
          0,
        );

  return checksum % 11 === 0
    ? undefined
    : lang === "nl"
      ? "Voer een geldige waarde in."
      : "Enter a valid value.";
}
