// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import type { VariableFilter } from "@/features/renderer/runtime/variable-compatibility";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import {
  fieldRuntimeKind,
  isFieldCollection,
  type FieldRuntimeKind,
} from "@/lib/field-contract/field-v2";

export type CollectionVariableRowMode = {
  kind: "fieldDefinition" | "objectCollection";
  manualValueKey: "field" | "value";
};

function isCollectionField(field: Field): boolean {
  return isFieldCollection(field);
}

function isFieldDefinitionCollectionSource(field: Field): boolean {
  return (
    isCollectionField(field) &&
    (field.semanticType === "fieldDefinition" ||
      field.item?.semanticType === "fieldDefinition")
  );
}

function isVariableBackedObjectCollection(field: Field): boolean {
  return isCollectionField(field) && Boolean(field.item) && field.variables === "whole";
}

export function getCollectionVariableRowMode(
  field: Field,
): CollectionVariableRowMode | null {
  if (isFieldDefinitionCollectionSource(field)) {
    return { kind: "fieldDefinition", manualValueKey: "field" };
  }

  if (isVariableBackedObjectCollection(field)) {
    return { kind: "objectCollection", manualValueKey: "value" };
  }

  return null;
}

function getObjectCollectionVariableFilter(field: Field): VariableFilter {
  const itemSemanticType =
    typeof field.item?.semanticType === "string" &&
    field.item.semanticType.trim()
      ? field.item.semanticType.trim()
      : undefined;

  return {
    valueType: "array",
    ...(itemSemanticType ? { itemSemanticType } : {}),
  };
}

export function isFieldDefinitionCollectionSuggestion(
  suggestion: VariableSuggestion,
) {
  return (
    suggestion.fieldType === "fieldArray" ||
    (suggestion.valueType === "array" &&
      suggestion.itemSemanticType === "fieldDefinition")
  );
}

export function canMaterializeVariableSuggestionAsFieldDefinition(
  suggestion: VariableSuggestion,
) {
  return !isFieldDefinitionCollectionSuggestion(suggestion);
}

function normalizeFieldKey(value: string) {
  const key = value
    .trim()
    .replace(/\[[^\]]*\]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return key.length > 0 ? key : "field";
}

function getFieldTypeForSuggestion(
  suggestion: VariableSuggestion,
): FieldRuntimeKind {
  if (
    suggestion.fieldType &&
    suggestion.fieldType !== "fieldArray" &&
    suggestion.fieldType !== "array"
  ) {
    return suggestion.fieldType;
  }

  switch (suggestion.valueType) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "array":
      return "array";
    case "string":
    default:
      return "string";
  }
}

export function materializeVariableSuggestionAsFieldDefinition(
  suggestion: VariableSuggestion,
): Field {
  const label = suggestion.displayLabel ?? suggestion.label;
  const fieldType = getFieldTypeForSuggestion(suggestion);
  const valueType =
    fieldType === "array" || fieldType === "fieldArray"
      ? "object"
      : fieldType === "uuid"
        ? "string"
        : fieldType;
  const options = suggestion.options?.length
    ? {
        type: "static" as const,
        items: suggestion.options.map((option) => ({
          value: option.value,
          label: { nl: option.label, en: option.label },
        })),
      }
    : suggestion.referentieGroep
      ? {
          type: "referentiedata" as const,
          referentieGroep: suggestion.referentieGroep,
        }
      : undefined;

  return {
    key: normalizeFieldKey(suggestion.fieldPath || suggestion.path),
    valueType,
    ...(fieldType === "array" || fieldType === "fieldArray"
      ? { cardinality: { min: 0, max: "unbounded" as const } }
      : {}),
    ...(fieldType === "fieldArray" ? { semanticType: "fieldDefinition" } : {}),
    ...(fieldType === "uuid" ? { validation: { format: "uuid" } } : {}),
    label: { nl: label, en: label },
    ...(suggestion.semanticType ? { semanticType: suggestion.semanticType } : {}),
    ...(options ? { options } : {}),
    ...(suggestion.referentieGroep
      ? {
          render: {
            component: "ReferenceSelect",
            props: { referentieGroep: suggestion.referentieGroep },
          },
        }
      : {}),
    defaultValue: suggestion.insertText,
  };
}

export function buildCollectionVariableRowPickerField(
  field: Field,
  mode: CollectionVariableRowMode,
  lang: string,
  context: "collection" | "row" = "row",
): Field {
  if (mode.kind === "fieldDefinition") {
    return {
      key: "source",
      valueType: "string",
      label: {
        nl: context === "collection" ? "Collectiebron" : "Veldbron",
        en: context === "collection" ? "Collection source" : "Field source",
      },
      placeholder: {
        nl: "Kies variabele...",
        en: "Choose variable...",
      },
      suggestions: {
        sourceKey: "workflowGraphVariables",
        filter:
          context === "collection"
            ? { fieldDefinitionSource: true }
            : undefined,
      } as Field["suggestions"],
      render: {
        component: "OptionVariablePicker",
        props: {
          clearable: true,
          valueMode: "insertText",
          variableSectionLabel:
            lang === "en"
              ? "Available variables"
              : "Beschikbare variabelen",
          emptyMessage:
            lang === "en"
              ? "No suitable variables found."
              : "Geen geschikte variabelen gevonden.",
        },
      },
    };
  }

  const filter = getObjectCollectionVariableFilter(field);

  return {
    key: "source",
    valueType: "string",
    label: { nl: "Collectiebron", en: "Collection source" },
    placeholder: {
      nl: "Kies variabele...",
      en: "Choose variable...",
    },
    suggestions: {
      ...field.suggestions,
    },
    render: {
      component: "OptionVariablePicker",
      props: {
        clearable: true,
        valueMode: "insertText",
        expectedValueType: "array",
        ...(filter.itemSemanticType
          ? { expectedItemSemanticType: filter.itemSemanticType }
          : {}),
        variableSectionLabel: lang === "en" ? "Variables" : "Variabelen",
        emptyMessage:
          lang === "en"
            ? "No compatible variables found."
            : "Geen passende variabelen gevonden.",
      },
    },
  };
}
