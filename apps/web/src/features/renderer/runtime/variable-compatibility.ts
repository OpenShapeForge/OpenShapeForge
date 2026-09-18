// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_OSF_TYPES } from "@/generated/compiler/osf-types";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import {
  fieldRuntimeKind,
  isFieldCollection,
  type FieldRuntimeKind, fieldValueType } from "@/lib/field-contract/field-v2";

type VariableValueType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array";

export type VariableFilter = {
  valueType?: VariableValueType;
  /**
   * Runtime compatibility type used by workflow variable suggestions. This is
   * not a canonical field shape; field-definition collections are authored as
   * `osfType: "object"` plus collection cardinality, or a fieldDefinition osfType.
   */
  fieldType?: FieldRuntimeKind;
  osfType?: string;
  itemOsfType?: string;
  fieldDefinitionSource?: boolean;
  anyOf?: VariableFilter[];
};

const COMPATIBLE_OSF_TYPES: Record<string, readonly string[]> = {
  relationId: ["relatieId"],
  relatieId: ["relationId"],
};

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function osfTypesCompatible(
  actual: string | undefined,
  expected: string,
): boolean {
  if (actual === expected) {
    return true;
  }
  if (!actual) {
    return false;
  }
  return COMPATIBLE_OSF_TYPES[expected]?.includes(actual) === true;
}

function normalizeFieldValueType(field: Field): VariableValueType {
  if (isFieldCollection(field)) return "array";
  switch (fieldValueType(field)) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "date":
    case "datetime":
    case "string":
    default:
      return "string";
  }
}

export function getFieldValueType(field: Field): VariableValueType {
  const osfType = normalizeOptionalString(field.osfType);
  const semanticDefinition = osfType
    ? COMPILER_OSF_TYPES[osfType as keyof typeof COMPILER_OSF_TYPES]
    : undefined;
  const semanticValueType = semanticDefinition?.valueType as string | undefined;

  if (
    semanticValueType === "string" ||
    semanticValueType === "number" ||
    semanticValueType === "boolean" ||
    semanticValueType === "object" ||
    semanticValueType === "array"
  ) {
    return semanticValueType;
  }

  return normalizeFieldValueType(field);
}

export function getVariableFilterForField(
  field: Field,
): VariableFilter | null {
  const osfType =
    normalizeOptionalString(field.render?.props?.expectedOsfType) ??
    normalizeOptionalString(field.osfType);
  if (osfType) {
    // `variableTemplate` classifies the *field* (a string containing `{{...}}` tokens), not
    // the semantic type of each referenced variable (iban, relationId, plain strings, …).
    // Filtering the suggestion pool by `osfType === "variableTemplate"` would drop every
    // real upstream output — none of those carry this tag — so pills show "Variabele bron niet gevonden."
    if (osfType === "variableTemplate") {
      return null;
    }
    if (
      osfType === "fieldDefinition" &&
      field.render?.props?.allowFieldDefinitionArrays === true
    ) {
      return {
        anyOf: [
          { osfType },
          { fieldType: "fieldArray" },
          { valueType: "array", itemOsfType: osfType },
        ],
      };
    }
    return { osfType };
  }

  const itemOsfType =
    normalizeOptionalString(field.render?.props?.expectedItemOsfType) ??
    normalizeOptionalString(field.item?.osfType);
  if (itemOsfType) {
    return {
      valueType: "array",
      itemOsfType,
    };
  }

  const explicitValueType = normalizeOptionalString(field.render?.props?.expectedValueType);
  switch (explicitValueType) {
    case "string":
    case "number":
    case "boolean":
    case "object":
    case "array":
      return { valueType: explicitValueType };
    default:
      break;
  }

  if (!isFieldCollection(field) && (fieldValueType(field) === "date" || fieldValueType(field) === "datetime")) {
    return { fieldType: fieldRuntimeKind(field) };
  }

  return null;
}

export function getVariableFilterForSuggestion(
  suggestion: VariableSuggestion | null | undefined,
): VariableFilter | null {
  if (!suggestion) {
    return null;
  }

  if (suggestion.osfType) {
    return { osfType: suggestion.osfType };
  }

  if (suggestion.itemOsfType) {
    return {
      valueType: "array",
      itemOsfType: suggestion.itemOsfType,
    };
  }

  if (suggestion.fieldType === "date" || suggestion.fieldType === "datetime") {
    return { fieldType: suggestion.fieldType };
  }

  return { valueType: suggestion.valueType };
}

export function isVariableSuggestionCompatible(
  suggestion: VariableSuggestion,
  filter: VariableFilter | null | undefined,
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.anyOf?.length) {
    return filter.anyOf.some((candidate) =>
      isVariableSuggestionCompatible(suggestion, candidate),
    );
  }

  if (filter.osfType) {
    return osfTypesCompatible(suggestion.osfType, filter.osfType);
  }

  if (filter.fieldDefinitionSource) {
    return (
      suggestion.fieldType === "fieldArray" ||
      (suggestion.valueType === "array" &&
        suggestion.itemOsfType === "fieldDefinition")
    );
  }

  if (filter.itemOsfType) {
    return (
      suggestion.valueType === "array" &&
      suggestion.itemOsfType === filter.itemOsfType
    );
  }

  if (filter.valueType) {
    return suggestion.valueType === filter.valueType;
  }

  if (filter.fieldType) {
    if (filter.fieldType === "datetime") {
      return suggestion.fieldType === "datetime" || suggestion.fieldType === "date";
    }

    return suggestion.fieldType === filter.fieldType;
  }

  return true;
}

export function filterVariableSuggestions(
  suggestions: VariableSuggestion[],
  filter: VariableFilter | null | undefined,
) {
  if (!filter) {
    return suggestions;
  }

  return suggestions.filter((suggestion) =>
    isVariableSuggestionCompatible(suggestion, filter),
  );
}
