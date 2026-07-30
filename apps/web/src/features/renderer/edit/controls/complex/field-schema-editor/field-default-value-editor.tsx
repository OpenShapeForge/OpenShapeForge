// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Button } from "@openshapeforge/ui";
import { Input } from "@/components/ui/forms/input";
import { Field as FieldFrame } from "@/features/renderer/components/field";
import { NumberInput } from "@/features/renderer/edit/controls/basic/number-input";
import { Switch } from "@/features/renderer/edit/controls/basic/switch";
import { DatePicker } from "@/features/renderer/edit/controls/complex/date-picker";
import { DateTimePicker } from "@/features/renderer/edit/controls/complex/date-time-picker";
import type { Field } from "@/generated/compiler/field-contract";
import type { RecursiveFieldSchemaEditorComponent } from "./types";
import { JsonFieldEditor } from "./controls";
import { createEmptyDefaultFieldDefinition, isFieldDefinitionCollection, isFieldDefinitionDefaultValue, isFieldDefinitionSemantic } from "./default-value-helpers";
import { isFieldCardinalityCollection } from "./utils";

function ClearDefaultValueButton({
  lang,
  disabled,
  onClear,
}: {
  lang: "nl" | "en";
  disabled: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex justify-end">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={onClear}
      >
        {lang === "nl" ? "Standaard wissen" : "Clear default"}
      </Button>
    </div>
  );
}

export function FieldSchemaDefaultValueEditor({
  field,
  lang,
  value,
  onChange,
  FieldSchemaEditorComponent,
}: {
  field: Field;
  lang: "nl" | "en";
  value: unknown;
  onChange: (value: unknown) => void;
  FieldSchemaEditorComponent: RecursiveFieldSchemaEditorComponent;
}) {
  const clearButton = (
    <ClearDefaultValueButton
      lang={lang}
      disabled={value === undefined}
      onClear={() => onChange(undefined)}
    />
  );

  if (isFieldDefinitionCollection(field)) {
    if (
      value !== undefined &&
      (!Array.isArray(value) || !value.every(isFieldDefinitionDefaultValue))
    ) {
      return (
        <div className="space-y-3">
          <JsonFieldEditor
            label={lang === "nl" ? "Standaardwaarde (JSON)" : "Default value (JSON)"}
            description={
              lang === "nl"
                ? "Deze bestaande standaardwaarde is geen geldige lijst met velddefinities. Bewerk de JSON of wis de standaardwaarde."
                : "This existing default value is not a valid list of field definitions. Edit the JSON or clear the default value."
            }
            lang={lang}
            value={value}
            onChange={onChange}
            rows={6}
          />
          {clearButton}
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <FieldSchemaEditorComponent
          items={Array.isArray(value) ? value : []}
          onChange={(nextItems) => {
            if (Array.isArray(nextItems)) {
              onChange(nextItems);
            }
          }}
          profile="fullFieldDefinition"
          mode="workspace"
          collectionLabel={lang === "nl" ? "Standaard velddefinities" : "Default field definitions"}
          collectionDescription={
            lang === "nl"
              ? "Deze velddefinities worden als standaardwaarde opgeslagen."
              : "These field definitions are stored as the default value."
          }
          lang={lang}
          variableSourceRows={false}
          suppressDefaultValueControl
          defaultExpandedItems="first"
        />
        {clearButton}
      </div>
    );
  }

  if (isFieldDefinitionSemantic(field)) {
    if (value !== undefined && !isFieldDefinitionDefaultValue(value)) {
      return (
        <div className="space-y-3">
          <JsonFieldEditor
            label={lang === "nl" ? "Standaardwaarde (JSON)" : "Default value (JSON)"}
            description={
              lang === "nl"
                ? "Deze bestaande standaardwaarde is geen geldige velddefinitie. Bewerk de JSON of wis de standaardwaarde."
                : "This existing default value is not a valid field definition. Edit the JSON or clear the default value."
            }
            lang={lang}
            value={value}
            onChange={onChange}
            rows={6}
          />
          {clearButton}
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <FieldSchemaEditorComponent
          items={[value ?? createEmptyDefaultFieldDefinition()]}
          onChange={(nextItems) => {
            if (Array.isArray(nextItems)) {
              onChange(nextItems[0]);
            }
          }}
          profile="fullFieldDefinition"
          mode="workspace"
          collectionLabel={lang === "nl" ? "Standaard velddefinitie" : "Default field definition"}
          collectionDescription={
            lang === "nl"
              ? "Deze velddefinitie wordt als standaardwaarde opgeslagen."
              : "This field definition is stored as the default value."
          }
          lang={lang}
          reorderable={false}
          variableSourceRows={false}
          singleItem
          suppressDefaultValueControl
          defaultExpandedItems="first"
        />
        {clearButton}
      </div>
    );
  }

  if (field.valueType === "object" || isFieldCardinalityCollection(field.cardinality)) {
    return (
      <JsonFieldEditor
        label={lang === "nl" ? "Standaardwaarde (JSON)" : "Default value (JSON)"}
        description={
          lang === "nl"
            ? "Voor objecten, arrays en complexe defaults."
            : "For objects, arrays, and complex defaults."
        }
        lang={lang}
        value={value}
        onChange={onChange}
        rows={6}
      />
    );
  }

  if (field.valueType === "number" || field.valueType === "integer") {
    return (
      <FieldFrame
        label={lang === "nl" ? "Standaardwaarde" : "Default value"}
        description={
          lang === "nl"
            ? "Vul een getal in dat als standaardwaarde wordt gebruikt."
            : "Enter the number used as the default value."
        }
      >
        {(controlProps) => (
          <div className="space-y-2">
            <NumberInput
              {...controlProps}
              step={field.valueType === "integer" ? 1 : "any"}
              value={typeof value === "number" ? String(value) : ""}
              onChange={(event) => {
                const nextText = event.currentTarget.value.trim();
                if (nextText.length === 0) {
                  onChange(undefined);
                  return;
                }
                const parsed = Number(nextText);
                if (!Number.isFinite(parsed)) {
                  onChange(undefined);
                  return;
                }
                onChange(
                  field.valueType === "integer" && !Number.isInteger(parsed)
                    ? undefined
                    : parsed,
                );
              }}
            />
            {clearButton}
          </div>
        )}
      </FieldFrame>
    );
  }

  if (field.valueType === "boolean") {
    const checked = value === true;
    return (
      <FieldFrame
        label={lang === "nl" ? "Standaardwaarde" : "Default value"}
        description={
          lang === "nl"
            ? "Kies de standaard ja/nee-waarde. Wis de waarde om geen standaard te bewaren."
            : "Choose the default yes/no value. Clear it to store no default."
        }
      >
        {(controlProps) => (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Switch
                id={controlProps.id}
                aria-describedby={controlProps["aria-describedby"]}
                aria-invalid={controlProps["aria-invalid"]}
                checked={checked}
                onCheckedChange={(nextChecked) => onChange(nextChecked)}
              />
              <span className="text-sm text-muted-foreground">
                {value === undefined
                  ? lang === "nl"
                    ? "Geen standaardwaarde"
                    : "No default value"
                  : checked
                    ? lang === "nl"
                      ? "Ja"
                      : "Yes"
                    : lang === "nl"
                      ? "Nee"
                      : "No"}
              </span>
            </div>
            {clearButton}
          </div>
        )}
      </FieldFrame>
    );
  }

  if (field.valueType === "date" || field.valueType === "datetime") {
    const Picker = field.valueType === "datetime" ? DateTimePicker : DatePicker;
    return (
      <FieldFrame
        label={lang === "nl" ? "Standaardwaarde" : "Default value"}
        description={
          lang === "nl"
            ? "Kies de datumwaarde die als standaard wordt gebruikt."
            : "Choose the date value used as the default."
        }
      >
        {(controlProps) => (
          <div className="space-y-2">
            <Picker
              {...controlProps}
              value={typeof value === "string" ? value : ""}
              onChange={(event) => {
                const nextValue = event.currentTarget.value;
                onChange(nextValue.length > 0 ? nextValue : undefined);
              }}
            />
            {clearButton}
          </div>
        )}
      </FieldFrame>
    );
  }

  return (
    <FieldFrame
      label={lang === "nl" ? "Standaardwaarde" : "Default value"}
      description={
        lang === "nl"
          ? "Vul tekst in die als standaardwaarde wordt gebruikt."
          : "Enter the text used as the default value."
      }
    >
      {(controlProps) => (
        <div className="space-y-2">
          <Input
            {...controlProps}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          {clearButton}
        </div>
      )}
    </FieldFrame>
  );
}
