// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_SEMANTIC_TYPES } from "@/generated/compiler/semantic-types";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import {
  fieldRuntimeKind,
  isFieldCollection,
  type FieldRuntimeKind,
} from "@/lib/field-contract/field-v2";

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
   * `valueType: "object"` plus collection cardinality and semanticType.
   */
  fieldType?: FieldRuntimeKind;
  semanticType?: string;
  itemSemanticType?: string;
  fieldDefinitionSource?: boolean;
  anyOf?: VariableFilter[];
};

const COMPATIBLE_SEMANTIC_TYPES: Record<string, readonly string[]> = {
  relationId: ["relatieId"],
  relatieId: ["relationId"],
};

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function semanticTypesCompatible(
  actual: string | undefined,
  expected: string,
): boolean {
  if (actual === expected) {
    return true;
  }
  if (!actual) {
    return false;
  }
  return COMPATIBLE_SEMANTIC_TYPES[expected]?.includes(actual) === true;
}

function normalizeFieldValueType(field: Field): VariableValueType {
  if (isFieldCollection(field)) return "array";
  switch (field.valueType) {
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
  const semanticType = normalizeOptionalString(field.semanticType);
  const semanticDefinition = semanticType
    ? COMPILER_SEMANTIC_TYPES[semanticType as keyof typeof COMPILER_SEMANTIC_TYPES]
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
  const semanticType =
    normalizeOptionalString(field.render?.props?.expectedSemanticType) ??
    normalizeOptionalString(field.semanticType);
  if (semanticType) {
    // `variableTemplate` classifies the *field* (a string containing `{{...}}` tokens), not
    // the semantic type of each referenced variable (iban, relationId, plain strings, …).
    // Filtering the suggestion pool by `semanticType === "variableTemplate"` would drop every
    // real upstream output — none of those carry this tag — so pills show "Variabele bron niet gevonden."
    if (semanticType === "variableTemplate") {
      return null;
    }
    if (
      semanticType === "fieldDefinition" &&
      field.render?.props?.allowFieldDefinitionArrays === true
    ) {
      return {
        anyOf: [
          { semanticType },
          { fieldType: "fieldArray" },
          { valueType: "array", itemSemanticType: semanticType },
        ],
      };
    }
    return { semanticType };
  }

  const itemSemanticType =
    normalizeOptionalString(field.render?.props?.expectedItemSemanticType) ??
    normalizeOptionalString(field.item?.semanticType);
  if (itemSemanticType) {
    return {
      valueType: "array",
      itemSemanticType,
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

  if (!isFieldCollection(field) && (field.valueType === "date" || field.valueType === "datetime")) {
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

  if (suggestion.semanticType) {
    return { semanticType: suggestion.semanticType };
  }

  if (suggestion.itemSemanticType) {
    return {
      valueType: "array",
      itemSemanticType: suggestion.itemSemanticType,
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

  if (filter.semanticType) {
    return semanticTypesCompatible(suggestion.semanticType, filter.semanticType);
  }

  if (filter.fieldDefinitionSource) {
    return (
      suggestion.fieldType === "fieldArray" ||
      (suggestion.valueType === "array" &&
        suggestion.itemSemanticType === "fieldDefinition")
    );
  }

  if (filter.itemSemanticType) {
    return (
      suggestion.valueType === "array" &&
      suggestion.itemSemanticType === filter.itemSemanticType
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
