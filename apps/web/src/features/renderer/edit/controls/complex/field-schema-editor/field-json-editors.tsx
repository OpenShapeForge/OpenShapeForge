// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { Field } from "@/generated/compiler/field-contract";
import { RAW_JSON_PROPERTIES } from "./constants";
import { JsonFieldEditor } from "./controls";
import { translateText } from "./utils";

export function FieldSchemaJsonValueEditor({
  label,
  description,
  value,
  lang,
  onChange,
  rows = 4,
}: {
  label: string;
  description?: string;
  value: unknown;
  lang: "nl" | "en";
  onChange: (value: unknown) => void;
  rows?: number;
}) {
  return (
    <JsonFieldEditor
      label={label}
      description={description}
      lang={lang}
      value={value}
      onChange={onChange}
      rows={rows}
    />
  );
}

export function FieldSchemaRawJsonEditor({
  field,
  lang,
  onChange,
}: {
  field: Field;
  lang: "nl" | "en";
  onChange: (field: Field) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {RAW_JSON_PROPERTIES.map((property) => (
        <JsonFieldEditor
          key={property.key}
          label={translateText(property.label, lang) || String(property.key)}
          lang={lang}
          value={field[property.key]}
          onChange={(value) =>
            onChange({
              ...field,
              [property.key]: value,
            })
          }
          rows={6}
        />
      ))}
    </div>
  );
}
