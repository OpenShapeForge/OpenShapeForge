// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Field as FieldFrame } from "@/features/renderer/components/field";
import { NumberInput } from "@/features/renderer/edit/controls/basic/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/renderer/edit/controls/basic/select";
import { FieldTypeSelect } from "./FieldTypeSelect";
import type { Field } from "@/generated/compiler/field-contract";
import type { FieldAuthoringProfile } from "@/lib/field-authoring/profiles";
import { parseCardinalityNumber } from "./rule-resolution";
import {
  applyFieldTypeSelection,
  getEffectiveRequired,
  getFieldSelectionTypeKey,
  getFieldTypeKey,
  isFieldCardinalityCollection,
  normalizeFieldCardinality,
} from "./utils";

export function FieldSchemaTypePicker({
  field,
  profile,
  lang,
  disabled = false,
  onChange,
}: {
  field: Field;
  profile: FieldAuthoringProfile;
  lang: "nl" | "en";
  disabled?: boolean;
  onChange: (field: Field) => void;
}) {
  const fieldTypeKey = getFieldTypeKey(field);
  const currentTypeIsExcluded = profile.excludedFieldTypes.includes(fieldTypeKey);

  return (
    <FieldFrame label={lang === "nl" ? "Soort waarde" : "Value type"}>
      {() => (
        <FieldTypeSelect
          key={fieldTypeKey}
          value={field.valueType}
          cardinality={isFieldCardinalityCollection(field.cardinality) ? "collection" : "single"}
          semanticType={field.semanticType}
          usage={profile.typePickerUsage}
          lang={lang}
          disabled={disabled}
          onSelectionChange={(selection) => {
            const nextTypeKey = getFieldSelectionTypeKey(selection);

            if (
              profile.excludedFieldTypes.includes(nextTypeKey) &&
              !currentTypeIsExcluded
            ) {
              return;
            }

            onChange(
              applyFieldTypeSelection(field, selection, profile.createEmptyField),
            );
          }}
        />
      )}
    </FieldFrame>
  );
}



export function FieldSchemaCardinalityEditor({
  field,
  lang,
  disabled = false,
  onChange,
}: {
  field: Field;
  lang: "nl" | "en";
  disabled?: boolean;
  onChange: (field: Field) => void;
}) {
  const cardinality = normalizeFieldCardinality(field.cardinality, getEffectiveRequired(field));
  const min = cardinality.min;
  const max = cardinality.max;
  const maxMode = max === "unbounded" ? "unbounded" : max === 1 ? "single" : "bounded";
  const updateCardinality = (next: { min: number; max: number | "unbounded" }) =>
    onChange({ ...field, cardinality: next, required: next.min > 0 } as Field);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <FieldFrame
        label={lang === "nl" ? "Minimaal" : "Minimum"}
        description={lang === "nl" ? "0 is optioneel, 1 of meer is verplicht." : "0 is optional, 1 or more is required."}
      >
        {(controlProps) => (
          <NumberInput
            {...controlProps}
            min={0}
            step={1}
            value={min}
            disabled={disabled}
            onChange={(event) => {
              const nextMin = parseCardinalityNumber(event.currentTarget.value, min);
              updateCardinality({ min: nextMin, max: typeof max === "number" && max < nextMin ? nextMin : max });
            }}
          />
        )}
      </FieldFrame>

      <FieldFrame label={lang === "nl" ? "Maximum" : "Maximum"}>
        {() => (
          <Select
            value={maxMode}
            onValueChange={(nextMode) => {
              if (nextMode === "single") {
                updateCardinality({ min: Math.min(min, 1), max: 1 });
              } else if (nextMode === "unbounded") {
                updateCardinality({ min, max: "unbounded" });
              } else {
                updateCardinality({ min, max: Math.max(2, min) });
              }
            }}
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">{lang === "nl" ? "Een waarde" : "One value"}</SelectItem>
              <SelectItem value="bounded">{lang === "nl" ? "Begrensde lijst" : "Bounded list"}</SelectItem>
              <SelectItem value="unbounded">{lang === "nl" ? "Onbegrensde lijst" : "Unbounded list"}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FieldFrame>

      {maxMode === "bounded" ? (
        <FieldFrame label={lang === "nl" ? "Maximaal aantal" : "Maximum count"}>
          {(controlProps) => (
            <NumberInput
              {...controlProps}
              min={Math.max(1, min)}
              step={1}
              value={typeof max === "number" ? max : Math.max(2, min)}
              disabled={disabled}
              onChange={(event) => {
                const nextMax = Math.max(min, parseCardinalityNumber(event.currentTarget.value, typeof max === "number" ? max : Math.max(2, min)));
                updateCardinality({ min, max: nextMax });
              }}
            />
          )}
        </FieldFrame>
      ) : null}
    </div>
  );
}
