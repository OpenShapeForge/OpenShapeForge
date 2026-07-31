// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Button } from "@openshapeforge/ui";
import { Field as FieldFrame } from "@/features/renderer/components/field";
import { Input } from "@/components/ui/forms/input";
import { InputMultiline } from "@openshapeforge/ui";
import {
  duplicateArrayItem,
  getLocalizedTextValue,
  moveArrayItem,
} from "./utils";
import type {
  LocalizedTextEditorProps,
  StringListEditorProps,
} from "./types";

export { JsonFieldEditor } from "@/features/renderer/edit/controls/complex/json-field-editor";

export function LocalizedTextEditor({
  label,
  value,
  lang,
  onChange,
  description,
  multiline = false,
  rows = 3,
}: LocalizedTextEditorProps) {
  const Control = multiline ? InputMultiline : Input;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <FieldFrame label={`${label} (NL)`} description={description}>
        {(controlProps) => (
          <Control
            {...controlProps}
            {...(multiline ? { rows } : {})}
            value={getLocalizedTextValue(value, "nl")}
            onChange={(event) => onChange("nl", event.currentTarget.value)}
          />
        )}
      </FieldFrame>

      <FieldFrame label={`${label} (EN)`}>
        {(controlProps) => (
          <Control
            {...controlProps}
            {...(multiline ? { rows } : {})}
            value={getLocalizedTextValue(value, "en")}
            onChange={(event) => onChange("en", event.currentTarget.value)}
          />
        )}
      </FieldFrame>
    </div>
  );
}

export function StringListEditor({
  label,
  values,
  onChange,
  lang,
  itemLabel,
  emptyText,
  addLabel,
  placeholder,
}: StringListEditorProps) {
  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/10 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">{label}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...values, ""])}>
          {addLabel}
        </Button>
      </div>

      {values.length > 0 ? (
        <div className="space-y-3">
          {values.map((value, index) => (
            <div key={`${itemLabel}-${index}`} className="space-y-2 rounded-lg border border-border/60 p-3">
              <FieldFrame label={`${itemLabel} ${index + 1}`}>
                {(controlProps) => (
                  <Input
                    {...controlProps}
                    value={value}
                    placeholder={placeholder}
                    onChange={(event) => {
                      const nextValues = [...values];
                      nextValues[index] = event.currentTarget.value;
                      onChange(nextValues);
                    }}
                  />
                )}
              </FieldFrame>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(moveArrayItem(values, index, -1))}
                  disabled={index === 0}
                >
                  {lang === "nl" ? "Omhoog" : "Move up"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(moveArrayItem(values, index, 1))}
                  disabled={index === values.length - 1}
                >
                  {lang === "nl" ? "Omlaag" : "Move down"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(duplicateArrayItem(values, index))}
                >
                  {lang === "nl" ? "Dupliceren" : "Duplicate"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange(values.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  {lang === "nl" ? "Verwijderen" : "Remove"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      )}
    </div>
  );
}
