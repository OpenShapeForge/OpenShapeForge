// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { Field } from "@/generated/compiler/field-contract";
import { Button } from "@openshapeforge/ui";
import { Field as FieldFrame } from "@/features/renderer/components/field";
import { Input } from "@/components/ui/forms/input";
import { JsonFieldEditor } from "@/features/renderer/edit/controls/complex/json-field-editor";
import { LocalizedTextEditor } from "./controls";
import {
  duplicateArrayItem,
  isRecord,
  moveArrayItem,
  normalizeValidation,
  setLocalizedTextValue,
} from "./utils";
import type { FieldSchemaEditorChromeLang } from "./types";

type Props = {
  field: Field;
  lang: FieldSchemaEditorChromeLang;
  onChange: (field: Field) => void;
};

export function CustomValidationSection({ field, lang, onChange }: Props) {
  const customRules = field.validation?.custom ?? [];

  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-background/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium">
            {lang === "nl" ? "Custom validators" : "Custom validators"}
          </p>
          <p className="text-sm text-muted-foreground">
            {lang === "nl"
              ? "Naam moet overeenkomen met een validator in de runtime-registry."
              : "Name must match a validator in the runtime registry."}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange({
              ...field,
              validation: normalizeValidation({
                ...(field.validation ?? {}),
                custom: [...customRules, { name: "", params: {} }],
              }),
            })
          }
        >
          {lang === "nl" ? "Validator toevoegen" : "Add validator"}
        </Button>
      </div>

      {customRules.length > 0 ? (
        <div className="space-y-4">
          {customRules.map((customRule, index) => (
            <div
              key={`custom-validator-${index}`}
              className="space-y-4 rounded-lg border border-border/60 p-4"
            >
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange({
                      ...field,
                      validation: normalizeValidation({
                        ...(field.validation ?? {}),
                        custom: moveArrayItem(customRules, index, -1),
                      }),
                    })
                  }
                  disabled={index === 0}
                >
                  {lang === "nl" ? "Omhoog" : "Move up"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange({
                      ...field,
                      validation: normalizeValidation({
                        ...(field.validation ?? {}),
                        custom: moveArrayItem(customRules, index, 1),
                      }),
                    })
                  }
                  disabled={index === customRules.length - 1}
                >
                  {lang === "nl" ? "Omlaag" : "Move down"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange({
                      ...field,
                      validation: normalizeValidation({
                        ...(field.validation ?? {}),
                        custom: duplicateArrayItem(customRules, index),
                      }),
                    })
                  }
                >
                  {lang === "nl" ? "Dupliceren" : "Duplicate"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange({
                      ...field,
                      validation: normalizeValidation({
                        ...(field.validation ?? {}),
                        custom: customRules.filter((_, itemIndex) => itemIndex !== index),
                      }),
                    })
                  }
                >
                  {lang === "nl" ? "Verwijderen" : "Remove"}
                </Button>
              </div>

              <FieldFrame label={lang === "nl" ? "Validatornaam" : "Validator name"}>
                {(controlProps) => (
                  <Input
                    {...controlProps}
                    value={customRule.name}
                    placeholder="iban"
                    onChange={(event) => {
                      const nextCustom = [...customRules];
                      nextCustom[index] = {
                        ...customRule,
                        name: event.currentTarget.value,
                      };
                      onChange({
                        ...field,
                        validation: normalizeValidation({
                          ...(field.validation ?? {}),
                          custom: nextCustom,
                        }),
                      });
                    }}
                  />
                )}
              </FieldFrame>

              <LocalizedTextEditor
                label={lang === "nl" ? "Custom foutmelding" : "Custom error message"}
                value={customRule.message}
                lang={lang}
                onChange={(locale, nextText) => {
                  const nextCustom = [...customRules];
                  nextCustom[index] = {
                    ...customRule,
                    message: setLocalizedTextValue(
                      customRule.message,
                      locale,
                      nextText,
                    ),
                  };
                  onChange({
                    ...field,
                    validation: normalizeValidation({
                      ...(field.validation ?? {}),
                      custom: nextCustom,
                    }),
                  });
                }}
                multiline
                rows={2}
              />

              <JsonFieldEditor
                label={lang === "nl" ? "Parameters (JSON)" : "Params (JSON)"}
                lang={lang}
                value={customRule.params}
                onChange={(value) => {
                  const nextCustom = [...customRules];
                  nextCustom[index] = {
                    ...customRule,
                    params: isRecord(value) ? value : undefined,
                  };
                  onChange({
                    ...field,
                    validation: normalizeValidation({
                      ...(field.validation ?? {}),
                      custom: nextCustom,
                    }),
                  });
                }}
                rows={4}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {lang === "nl"
            ? "Nog geen custom validators toegevoegd."
            : "No custom validators added yet."}
        </p>
      )}
    </div>
  );
}
