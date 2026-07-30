// SPDX-License-Identifier: BUSL-1.1
import type {
  Field,
  LocalizedText,
} from "@/generated/compiler/field-contract";
import type {
  FieldSchemaEditorLang,
  LocalizedFieldProperty,
} from "./types";
import { setLocalizedTextValue, translateText } from "./value-utils";

export function getLocalizedFieldProperty(
  field: Field,
  property: LocalizedFieldProperty,
) {
  return field[property] as LocalizedText | undefined;
}

export function updateLocalizedFieldProperty(
  field: Field,
  property: LocalizedFieldProperty,
  lang: FieldSchemaEditorLang,
  nextText: string,
): Field {
  return {
    ...field,
    [property]: setLocalizedTextValue(
      getLocalizedFieldProperty(field, property),
      lang,
      nextText,
    ),
  };
}

export function summarizeFieldDefinitions(items: Field[], lang: FieldSchemaEditorLang) {
  if (items.length === 0) {
    return lang === "nl"
      ? "Nog geen velden toegevoegd."
      : "No fields have been added yet.";
  }

  const labels = items
    .map((item) =>
      translateText(item.label, lang) ||
      (lang === "nl" ? "Nieuw veld" : "New field"))
    .filter(Boolean);
  const visible = labels.slice(0, 3).join(", ");

  if (labels.length <= 3) {
    return visible;
  }

  const remaining = labels.length - 3;
  return lang === "nl"
    ? `${visible} en nog ${remaining}`
    : `${visible} and ${remaining} more`;
}
