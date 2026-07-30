// SPDX-License-Identifier: BUSL-1.1
import type { Field as CompilerField } from "../../../../../generated/compiler/field-contract";
import { isFieldCollection } from "../../../../../lib/field-contract/field-v2";
import {
  stringifyRendererPath,
  type RendererPathPart,
} from "../../../runtime/path-utils";

const SUPPORTED_LOCALES = ["nl", "en", "fr"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function normalizeRendererLocale(lang: string): SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(lang)
    ? (lang as SupportedLocale)
    : "nl";
}

export function getLocalizedRendererRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return { nl: value, en: value };
  }
  return null;
}

export function resolveLocalizedRendererValue(
  value: unknown,
  locale: SupportedLocale,
): unknown {
  const record = getLocalizedRendererRecord(value);
  if (!record) {
    return "";
  }
  return (
    record[locale] ??
    record.nl ??
    record.en ??
    Object.values(record).find(
      (entry) => typeof entry === "string" && entry.length > 0,
    ) ??
    ""
  );
}

/**
 * Boolean fields always carry a defined value (true or false), so a
 * required-marker on a toggle is a UX trap. Authoring-time rejection lives in
 * packages/compiler/src/authoring/checks.ts::checkBooleanRequired.
 */
export function isEffectivelyRequired(
  field: CompilerField,
  generatedRequired: boolean | undefined,
): boolean {
  if (field.valueType === "boolean" && !isFieldCollection(field)) {
    return false;
  }
  return Boolean(generatedRequired ?? field.required);
}

export function getRenderableFieldNodeKey(
  field: CompilerField,
  path: readonly RendererPathPart[],
) {
  const domIdKey =
    typeof (field as CompilerField & { __domIdKey?: string }).__domIdKey ===
      "string" &&
    (field as CompilerField & { __domIdKey?: string }).__domIdKey?.trim().length
      ? (field as CompilerField & { __domIdKey?: string }).__domIdKey!.trim()
      : field.key;
  const pathKey = stringifyRendererPath(path);
  return pathKey.length > 0 ? `${domIdKey}::${pathKey}` : domIdKey;
}

export function usesInlineJsonEditor(field: CompilerField) {
  return field.render?.component === "JsonFieldEditor";
}
