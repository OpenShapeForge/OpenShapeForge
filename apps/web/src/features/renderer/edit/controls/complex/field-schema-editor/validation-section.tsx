// SPDX-License-Identifier: BUSL-1.1
"use client";

import type { Field } from "@/generated/compiler/field-contract";
import { Field as FieldFrame } from "@/features/renderer/components/field";
import { Input } from "@/components/ui/forms/input";
import { NumberInput } from "@/features/renderer/edit/controls/basic/number-input";
import { Switch } from "@/features/renderer/edit/controls/basic/switch";
import { LocalizedTextEditor } from "./controls";
import { CustomValidationSection } from "./custom-validation-section";
import {
  getEffectiveRequired,
  getValidationRuleMessage,
  getValidationRuleValue,
  updateValidationRuleMessage,
  updateValidationRuleValue,
} from "./utils";
import type { FieldSectionProps, ValidationRuleEditorProps } from "./types";

export function ValidationRuleEditor({
  label,
  description,
  lang,
  valueType,
  rule,
  defaultValue,
  valueLabel,
  placeholder,
  onChangeValue,
  onChangeMessage,
}: ValidationRuleEditorProps) {
  const value = getValidationRuleValue(rule);
  const message = getValidationRuleMessage(rule);
  const isEnabled = value !== undefined;

  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-muted/10 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{label}</p>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <Switch
          checked={isEnabled}
          onCheckedChange={(checked) =>
            onChangeValue(checked ? defaultValue : undefined)
          }
        />
      </div>

      {isEnabled ? (
        <>
          <FieldFrame label={valueLabel}>
            {(controlProps) =>
              valueType === "number" ? (
                <NumberInput
                  {...controlProps}
                  value={typeof value === "number" ? value : ""}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    onChangeValue(next.trim().length === 0 ? undefined : Number(next));
                  }}
                />
              ) : (
                <Input
                  {...controlProps}
                  value={typeof value === "string" ? value : ""}
                  placeholder={placeholder}
                  onChange={(event) => onChangeValue(event.currentTarget.value)}
                />
              )
            }
          </FieldFrame>

          <LocalizedTextEditor
            label={lang === "nl" ? "Foutmelding" : "Error message"}
            value={message}
            lang={lang}
            onChange={onChangeMessage}
            multiline
            rows={2}
          />
        </>
      ) : null}
    </div>
  );
}

export function ValidationSection({
  field,
  lang,
  onChange,
  framed = true,
}: FieldSectionProps & {
  framed?: boolean;
}) {
  const requiredMessage = getValidationRuleMessage(field.validation?.required);
  const content = (
    <div className="space-y-4">
      <div className="space-y-4 rounded-xl border border-border/70 bg-background/70 p-4">
        <p className="font-medium">
          {lang === "nl" ? "Verplicht veld" : "Required field"}
        </p>
        {getEffectiveRequired(field) ? (
          <LocalizedTextEditor
            label={lang === "nl" ? "Verplicht-foutmelding" : "Required error message"}
            value={requiredMessage}
            lang={lang}
            onChange={(locale, nextText) =>
              onChange(
                updateValidationRuleMessage(
                  field,
                  "required",
                  locale,
                  nextText,
                  true,
                ),
              )
            }
            multiline
            rows={2}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {lang === "nl"
              ? "Schakel eerst 'Verplicht' in om een aangepaste foutmelding te beheren."
              : "Enable 'Required' first to manage a custom error message."}
          </p>
        )}
      </div>

      <ValidationRuleEditor
        label={lang === "nl" ? "Minimale lengte" : "Minimum length"}
        description={
          lang === "nl"
            ? "Voor tekstvelden en vergelijkbare invoer."
            : "For text fields and similar input."
        }
        lang={lang}
        valueType="number"
        rule={field.validation?.minLength}
        defaultValue={1}
        valueLabel={lang === "nl" ? "Aantal tekens" : "Character count"}
        onChangeValue={(value) => onChange(updateValidationRuleValue(field, "minLength", value))}
        onChangeMessage={(locale, nextText) =>
          onChange(updateValidationRuleMessage(field, "minLength", locale, nextText))
        }
      />

      <ValidationRuleEditor
        label={lang === "nl" ? "Maximale lengte" : "Maximum length"}
        lang={lang}
        valueType="number"
        rule={field.validation?.maxLength}
        defaultValue={255}
        valueLabel={lang === "nl" ? "Aantal tekens" : "Character count"}
        onChangeValue={(value) => onChange(updateValidationRuleValue(field, "maxLength", value))}
        onChangeMessage={(locale, nextText) =>
          onChange(updateValidationRuleMessage(field, "maxLength", locale, nextText))
        }
      />

      <ValidationRuleEditor
        label={lang === "nl" ? "Minimumwaarde" : "Minimum value"}
        lang={lang}
        valueType="number"
        rule={field.validation?.min}
        defaultValue={0}
        valueLabel={lang === "nl" ? "Waarde" : "Value"}
        onChangeValue={(value) => onChange(updateValidationRuleValue(field, "min", value))}
        onChangeMessage={(locale, nextText) =>
          onChange(updateValidationRuleMessage(field, "min", locale, nextText))
        }
      />

      <ValidationRuleEditor
        label={lang === "nl" ? "Maximumwaarde" : "Maximum value"}
        lang={lang}
        valueType="number"
        rule={field.validation?.max}
        defaultValue={100}
        valueLabel={lang === "nl" ? "Waarde" : "Value"}
        onChangeValue={(value) => onChange(updateValidationRuleValue(field, "max", value))}
        onChangeMessage={(locale, nextText) =>
          onChange(updateValidationRuleMessage(field, "max", locale, nextText))
        }
      />

      <ValidationRuleEditor
        label={lang === "nl" ? "Patroon" : "Pattern"}
        description={
          lang === "nl"
            ? "Reguliere expressie die op de invoer wordt toegepast."
            : "Regular expression applied to the input."
        }
        lang={lang}
        valueType="string"
        rule={field.validation?.pattern}
        defaultValue=".*"
        valueLabel={lang === "nl" ? "Regex" : "Regex"}
        placeholder="^[A-Z0-9]+$"
        onChangeValue={(value) => onChange(updateValidationRuleValue(field, "pattern", value))}
        onChangeMessage={(locale, nextText) =>
          onChange(updateValidationRuleMessage(field, "pattern", locale, nextText))
        }
      />

      <CustomValidationSection field={field} lang={lang} onChange={onChange} />
    </div>
  );

  if (!framed) {
    return content;
  }

  return (
    <details className="rounded-xl border border-border/70 bg-muted/10 p-4">
      <summary className="cursor-pointer text-sm font-medium">
        {lang === "nl" ? "Validatie" : "Validation"}
      </summary>
      <div className="mt-4">
        {content}
      </div>
    </details>
  );
}
