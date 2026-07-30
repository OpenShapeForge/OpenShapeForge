// SPDX-License-Identifier: BUSL-1.1
import type { LocalizedText } from "@/generated/compiler/field-contract";
import { isRecord } from "@/lib/json-record";
import type {
  FieldSchemaEditorChromeLang,
  FieldSchemaEditorLang,
} from "./types";

export function translateText(
  text: string | LocalizedText | undefined,
  lang: FieldSchemaEditorLang,
) {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text[lang] ?? text.en ?? text.nl ?? Object.values(text)[0] ?? "";
}

export function trimToUndefined(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export { isRecord };

export function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.values(value).some((entry) => hasMeaningfulValue(entry));
  }

  return true;
}

export function getLocalizedTextValue(
  value: LocalizedText | undefined,
  lang: FieldSchemaEditorChromeLang,
) {
  return value?.[lang] ?? value?.en ?? value?.nl ?? "";
}

export function setLocalizedTextValue(
  value: LocalizedText | undefined,
  lang: FieldSchemaEditorLang,
  nextText: string,
): LocalizedText | undefined {
  const current = value ?? {};
  if (nextText.length === 0) {
    const next = { ...current };
    delete next[lang];
    return Object.keys(next).length > 0 ? next : undefined;
  }

  return {
    ...current,
    [lang]: nextText,
  };
}
