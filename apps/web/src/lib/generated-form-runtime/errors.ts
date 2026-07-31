// SPDX-License-Identifier: BUSL-1.1
import type { LocalizedText, ValidationRuleValue } from "./types";

export function translate(text: LocalizedText | string | null | undefined, lang: string): string {
  if (!text) {
    return "";
  }

  if (typeof text === "string") {
    return text;
  }

  return text[lang] ?? text.en ?? Object.values(text)[0] ?? "";
}

export function getRuleValue(rule: ValidationRuleValue | undefined): boolean | number | string | undefined {
  if (rule == null) {
    return undefined;
  }

  return typeof rule === "object" && "value" in rule ? rule.value : rule;
}

export function getRuleMessage(rule: ValidationRuleValue | undefined, lang: string): string | undefined {
  if (!rule || typeof rule !== "object" || !("message" in rule)) {
    return undefined;
  }

  return translate(rule.message ?? null, lang) || undefined;
}

export function getDefaultValidationMessage(
  label: LocalizedText | undefined,
  fieldKey: string,
  lang: string,
  messageNl: string,
  messageEn: string,
): string {
  const fieldLabel = translate(label, lang) || fieldKey;
  return `${fieldLabel} ${lang === "nl" ? messageNl : messageEn}`;
}
