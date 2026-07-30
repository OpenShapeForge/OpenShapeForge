// SPDX-License-Identifier: BUSL-1.1
"use client";

import { Field as FieldFrame } from "@/features/renderer/components/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/renderer/edit/controls/basic/select";
import { ExpressionEditor } from "@/features/renderer/edit/controls/complex/expression-editor";
import type { Field, LocalizedText } from "@/generated/compiler/field-contract";
import type { FieldAuthoringProfile } from "@/lib/field-authoring/profiles";
import { JsonFieldEditor } from "./controls";
import { isFieldCardinalityCollection, translateText } from "./utils";

export function FieldSchemaValueEditor({
  field,
  profile,
  lang,
  value,
  onChange,
}: {
  field: Field;
  profile: FieldAuthoringProfile;
  lang: "nl" | "en";
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const staticOptions =
    field.valueType === "string" &&
    !isFieldCardinalityCollection(field.cardinality) &&
    field.options?.type === "static" &&
    Array.isArray(field.options.items)
      ? field.options.items
          .filter((item): item is { value: string; label: LocalizedText } =>
            Boolean(
              item &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                typeof item.value === "string" &&
                item.label &&
                typeof item.label === "object" &&
                !Array.isArray(item.label),
            ))
      : [];

  if (
    profile.id === "workflowOutputField" &&
    field.key === "status" &&
    staticOptions.length > 0
  ) {
    return (
      <FieldFrame
        label={lang === "nl" ? "Waarde" : "Value"}
        description={
          lang === "nl"
            ? "Kies de publieke workflowstatus die deze eindnode teruggeeft."
            : "Choose the public workflow status returned by this end node."
        }
      >
        {() => (
          <Select
            value={typeof value === "string" ? value : "success"}
            onValueChange={(nextValue) => onChange(nextValue)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {staticOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {translateText(option.label, lang) || option.value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FieldFrame>
    );
  }

  if (field.valueType === "object" || isFieldCardinalityCollection(field.cardinality)) {
    return (
      <JsonFieldEditor
        label={lang === "nl" ? "Waarde (JSON)" : "Value (JSON)"}
        description={
          lang === "nl"
            ? "Gebruik JSON. Strings binnen objecten of arrays mogen interpolaties uit de workflowvariabelen bevatten (bijv. {{nodes.trigger.output.id}})."
            : "Use JSON. Strings inside objects or arrays may contain workflow interpolations (e.g. {{nodes.trigger.output.id}})."
        }
        lang={lang}
        value={value}
        onChange={onChange}
        rows={6}
      />
    );
  }

  if (field.valueType === "number" || field.valueType === "integer" || field.valueType === "boolean") {
    return (
      <JsonFieldEditor
        label={lang === "nl" ? "Waarde" : "Value"}
        description={
          lang === "nl"
            ? "Gebruik een JSON-scalar zoals 123, true of een exacte interpolatie zoals \"{{nodes.calc.output.amount}}\"."
            : "Use a JSON scalar such as 123, true, or an exact interpolation such as \"{{nodes.calc.output.amount}}\"."
        }
        lang={lang}
        value={value}
        onChange={onChange}
        rows={4}
      />
    );
  }

  return (
    <FieldFrame
      label={lang === "nl" ? "Waarde" : "Value"}
      description={
        lang === "nl"
          ? "Gebruik tekst of een interpolatie uit de variabelezoeker (bijv. {{nodes.trigger.output.id}}). Gewone tekst blijft een literal."
          : "Use text or an interpolation from the variable picker (e.g. {{nodes.trigger.output.id}}). Plain text stays literal."
      }
    >
      {(controlProps) => (
        <ExpressionEditor
          {...controlProps}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
          rows={4}
          languageHint="workflow-expression"
          placeholder={lang === "nl" ? "{{nodes.trigger.output.id}}" : "{{nodes.trigger.output.id}}"}
        />
      )}
    </FieldFrame>
  );
}
