// SPDX-License-Identifier: BUSL-1.1
import type {
  FieldSchemaEditorChromeLang,
  FieldSchemaEditorLang,
} from "./types";

export function toFieldSchemaChromeLang(
  lang: FieldSchemaEditorLang,
): FieldSchemaEditorChromeLang {
  return lang === "nl" ? "nl" : "en";
}

export function normalizeFieldSchemaLang(
  value: unknown,
): FieldSchemaEditorLang {
  return value === "en" || value === "fr" ? value : "nl";
}
