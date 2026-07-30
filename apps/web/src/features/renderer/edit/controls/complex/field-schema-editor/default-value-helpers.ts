// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { getFieldAuthoringProfile } from "@/lib/field-authoring/profiles";
import { isFieldCardinalityCollection, isRecord } from "./utils";

export function isFieldDefinitionSemantic(field: Field) {
  return field.valueType === "object" && field.semanticType === "fieldDefinition";
}

export function isFieldDefinitionCollection(field: Field) {
  return isFieldDefinitionSemantic(field) &&
    isFieldCardinalityCollection(field.cardinality);
}

export function isFieldDefinitionDefaultValue(value: unknown): value is Field {
  return isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.valueType === "string";
}

export function createEmptyDefaultFieldDefinition(): Field {
  return getFieldAuthoringProfile("fullFieldDefinition").createEmptyField();
}

function defaultValueCompatibilityKey(field: Field) {
  return [
    field.valueType,
    isFieldCardinalityCollection(field.cardinality) ? "collection" : "single",
    field.semanticType === "fieldDefinition" ? "fieldDefinition" : field.semanticType ?? "",
  ].join(":");
}

function getCompatibleDefaultValue(field: Field, value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (isFieldDefinitionCollection(field)) {
    return Array.isArray(value) && value.every(isFieldDefinitionDefaultValue)
      ? value
      : undefined;
  }

  if (isFieldDefinitionSemantic(field)) {
    return isFieldDefinitionDefaultValue(value) ? value : undefined;
  }

  if (isFieldCardinalityCollection(field.cardinality)) {
    return Array.isArray(value) ? value : undefined;
  }

  switch (field.valueType) {
    case "string":
      return typeof value === "string" ? value : undefined;
    case "integer":
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "date":
    case "datetime":
      return typeof value === "string" ? value : undefined;
    case "object":
      return isRecord(value) ? value : undefined;
    default:
      return undefined;
  }
}

export function reconcileDefaultValueForFieldChange(previousField: Field, nextField: Field): Field {
  if (
    defaultValueCompatibilityKey(previousField) === defaultValueCompatibilityKey(nextField) ||
    !("defaultValue" in nextField)
  ) {
    return nextField;
  }

  const compatibleDefaultValue = getCompatibleDefaultValue(
    nextField,
    nextField.defaultValue,
  );
  if (compatibleDefaultValue === undefined) {
    const { defaultValue: _defaultValue, ...fieldWithoutDefault } = nextField;
    return fieldWithoutDefault;
  }

  return {
    ...nextField,
    defaultValue: compatibleDefaultValue,
  };
}
