// SPDX-License-Identifier: BUSL-1.1
"use client";

import { type ReactNode, useMemo } from "react";
import { Button } from "@openshapeforge/ui";
import { Input } from "@/components/ui/forms/input";
import { Field as FieldFrame } from "@/features/renderer/components/field";
import { ListSelect } from "@/features/renderer/edit/controls/complex/list-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/renderer/edit/controls/basic/select";
import type { Field, LocalizedText, VisibilityCondition } from "@/generated/compiler/field-contract";
import { listReferentieGroepOptions } from "@/lib/referentiedata";
import { VISIBILITY_OPERATOR_OPTIONS } from "./constants";
import { JsonFieldEditor, LocalizedTextEditor } from "./controls";
import { duplicateArrayItem, moveArrayItem, setLocalizedTextValue, translateText } from "./utils";

const REFERENTIE_GROEP_OPTIONS = listReferentieGroepOptions();

export function FieldSchemaStaticOptionsEditor({
  value,
  lang,
  onChange,
}: {
  value: unknown;
  lang: "nl" | "en";
  onChange: (value: unknown) => void;
}) {
  const items =
    Array.isArray(value) &&
    value.every((item) => item && typeof item === "object" && !Array.isArray(item))
      ? (value as Array<{ value?: string; label?: LocalizedText }>)
      : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">
          {lang === "nl" ? "Statische opties" : "Static options"}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange([
              ...items,
              { value: "", label: { nl: "", en: "" } },
            ])
          }
        >
          {lang === "nl" ? "Optie toevoegen" : "Add option"}
        </Button>
      </div>

      {items.length > 0 ? (
        <div className="space-y-4">
          {items.map((option, index) => (
            <div
              key={`static-option-${index}`}
              className="space-y-4 rounded-lg border border-border/60 p-4"
            >
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(moveArrayItem(items, index, -1))}
                  disabled={index === 0}
                >
                  {lang === "nl" ? "Omhoog" : "Move up"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(moveArrayItem(items, index, 1))}
                  disabled={index === items.length - 1}
                >
                  {lang === "nl" ? "Omlaag" : "Move down"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(duplicateArrayItem(items, index))}
                >
                  {lang === "nl" ? "Dupliceren" : "Duplicate"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
                >
                  {lang === "nl" ? "Verwijderen" : "Remove"}
                </Button>
              </div>

              <FieldFrame label={lang === "nl" ? "Waarde" : "Value"}>
                {(controlProps) => (
                  <Input
                    {...controlProps}
                    value={option.value ?? ""}
                    onChange={(event) => {
                      const nextItems = [...items];
                      nextItems[index] = {
                        ...option,
                        value: event.currentTarget.value,
                      };
                      onChange(nextItems);
                    }}
                  />
                )}
              </FieldFrame>

              <LocalizedTextEditor
                label={lang === "nl" ? "Optielabel" : "Option label"}
                value={option.label}
                lang={lang}
                onChange={(locale, nextText) => {
                  const nextItems = [...items];
                  nextItems[index] = {
                    ...option,
                    label: setLocalizedTextValue(option.label, locale, nextText) ?? {},
                  };
                  onChange(nextItems);
                }}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {lang === "nl"
            ? "Nog geen statische opties toegevoegd."
            : "No static options added yet."}
        </p>
      )}
    </div>
  );
}

export function FieldSchemaReferenceGroupPicker({
  value,
  label,
  description,
  helpText,
  error,
  required,
  lang,
  onChange,
}: {
  value: unknown;
  label?: ReactNode;
  description?: ReactNode;
  helpText?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  lang: "nl" | "en";
  onChange: (value: unknown) => void;
}) {
  const stringValue = typeof value === "string" ? value : "";
  const options = useMemo(() => {
    if (
      stringValue.trim().length === 0 ||
      REFERENTIE_GROEP_OPTIONS.some((option) => option.value === stringValue)
    ) {
      return REFERENTIE_GROEP_OPTIONS;
    }

    return [
      {
        value: stringValue,
        label: stringValue,
        description: lang === "nl" ? "Onbekende of legacy referentiegroep" : "Unknown or legacy reference group",
      },
      ...REFERENTIE_GROEP_OPTIONS,
    ];
  }, [lang, stringValue]);

  return (
    <FieldFrame
      label={label}
      description={description}
      helpText={helpText}
      error={error}
      required={required}
    >
      {(controlProps) => (
        <ListSelect
          {...controlProps}
          value={stringValue}
          options={options}
          searchable
          clearable
          placeholder={lang === "nl" ? "Kies referentiegroep..." : "Choose reference group..."}
          searchPlaceholder={lang === "nl" ? "Zoek referentiegroep..." : "Search reference group..."}
          emptyMessage={lang === "nl" ? "Geen referentiegroep gevonden." : "No reference group found."}
          onValueChange={(nextValue) => onChange(nextValue.trim().length > 0 ? nextValue : undefined)}
        />
      )}
    </FieldFrame>
  );
}

export function FieldSchemaVisibilityConditionsEditor({
  value,
  lang,
  onChange,
}: {
  value: unknown;
  lang: "nl" | "en";
  onChange: (value: unknown) => void;
}) {
  const conditions =
    Array.isArray(value) &&
    value.every((item) => item && typeof item === "object" && !Array.isArray(item))
      ? (value as Array<Partial<VisibilityCondition>>)
      : [];

  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-background/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">
          {lang === "nl" ? "Condities" : "Conditions"}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange([
              ...conditions,
              { field: "", operator: "eq" },
            ])
          }
        >
          {lang === "nl" ? "Conditie toevoegen" : "Add condition"}
        </Button>
      </div>

      {conditions.length > 0 ? (
        <div className="space-y-4">
          {conditions.map((condition, index) => (
            <div
              key={`visibility-condition-${index}`}
              className="space-y-4 rounded-lg border border-border/60 p-4"
            >
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(moveArrayItem(conditions, index, -1))}
                  disabled={index === 0}
                >
                  {lang === "nl" ? "Omhoog" : "Move up"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(moveArrayItem(conditions, index, 1))}
                  disabled={index === conditions.length - 1}
                >
                  {lang === "nl" ? "Omlaag" : "Move down"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChange(duplicateArrayItem(conditions, index))}
                >
                  {lang === "nl" ? "Dupliceren" : "Duplicate"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange(conditions.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  {lang === "nl" ? "Verwijderen" : "Remove"}
                </Button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <FieldFrame label={lang === "nl" ? "Veldpad" : "Field path"}>
                  {(controlProps) => (
                    <Input
                      {...controlProps}
                      value={condition.field ?? ""}
                      placeholder="request.type"
                      onChange={(event) => {
                        const nextConditions = [...conditions];
                        nextConditions[index] = {
                          ...condition,
                          field: event.currentTarget.value,
                        };
                        onChange(nextConditions);
                      }}
                    />
                  )}
                </FieldFrame>

                <FieldFrame label={lang === "nl" ? "Operator" : "Operator"}>
                  {() => (
                    <Select
                      value={condition.operator ?? "eq"}
                      onValueChange={(nextValue) => {
                        const nextConditions = [...conditions];
                        nextConditions[index] = {
                          ...condition,
                          operator: nextValue as typeof condition.operator,
                        };
                        onChange(nextConditions);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VISIBILITY_OPERATOR_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {translateText(option.label, lang) || option.value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FieldFrame>
              </div>

              <JsonFieldEditor
                label={lang === "nl" ? "Vergelijkingswaarde (JSON)" : "Comparison value (JSON)"}
                lang={lang}
                value={condition.value}
                onChange={(nextValue) => {
                  const nextConditions = [...conditions];
                  nextConditions[index] = {
                    ...condition,
                    value: nextValue,
                  };
                  onChange(nextConditions);
                }}
                rows={4}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {lang === "nl" ? "Nog geen condities toegevoegd." : "No conditions added yet."}
        </p>
      )}
    </div>
  );
}
