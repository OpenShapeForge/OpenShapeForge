// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";

const SUPPORTED_LOCALES_FOR_VALIDATION = ["nl", "en", "fr"] as const;

/**
 * For a `localized` field, return the active-locale slot of the stored
 * `LocalizedText`-shaped value. For non-localized fields, return the value
 * unchanged. Used so existing string-based validation rules (`required`,
 * `minLength`, etc.) operate on the active locale instead of the wrapping
 * object, without forking the validator.
 */
export function unwrapLocalizedValue(field: Field, value: unknown, lang: string): unknown {
  if (!field.localized) {
    return value;
  }
  const locale = (SUPPORTED_LOCALES_FOR_VALIDATION as readonly string[]).includes(lang)
    ? (lang as "nl" | "en" | "fr")
    : "nl";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[locale] ?? "";
  }
  return value;
}
