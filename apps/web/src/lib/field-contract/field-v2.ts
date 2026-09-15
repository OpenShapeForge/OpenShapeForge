// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_SEMANTIC_TYPES } from "@/generated/compiler/semantic-types";

export type FieldValueType = NonNullable<Field["valueType"]>;
export type FieldCardinality = NonNullable<Field["cardinality"]>;

export type FieldRuntimeKind =
  | FieldValueType
  | "uuid"
  | "array"
  | "fieldArray";

export type FieldShapeKind =
  | FieldValueType
  | "uuid"
  | "collection";

/** Raw authoring fields may inherit valueType from their semantic type. */
export function fieldValueType(field: Field): FieldValueType {
  const semantic = field.semanticType
    ? COMPILER_SEMANTIC_TYPES[field.semanticType as keyof typeof COMPILER_SEMANTIC_TYPES]
    : undefined;
  return (field.valueType ?? semantic?.valueType ?? "string") as FieldValueType;
}

export function fieldCardinality(field: Field): FieldCardinality {
  const cardinality = field.cardinality;
  if (cardinality === "collection") return "collection";
  if (cardinality && typeof cardinality === "object") {
    if (cardinality.max === "unbounded") return "collection";
    if (typeof cardinality.max === "number" && cardinality.max > 1) {
      return "collection";
    }
  }
  return "single";
}

export function isFieldCollection(field: Field): boolean {
  return fieldCardinality(field) === "collection";
}

export function isFieldObject(field: Field): boolean {
  return fieldValueType(field) === "object" && !isFieldCollection(field);
}

export function isFieldObjectCollection(field: Field): boolean {
  return fieldValueType(field) === "object" && isFieldCollection(field);
}

export function isFieldDefinitionCollection(field: Field): boolean {
  return isFieldObjectCollection(field) && field.semanticType === "fieldDefinition";
}

export function isActionDefinitionCollection(field: Field): boolean {
  return isFieldObjectCollection(field) && field.semanticType === "actionDefinition";
}

export function isActionDefinitionItem(field: Field): boolean {
  return fieldValueType(field) === "object" && field.semanticType === "actionDefinitionItem";
}

export function fieldRuntimeKind(field: Field): FieldRuntimeKind {
  if (isFieldDefinitionCollection(field)) return "fieldArray";
  if (isFieldCollection(field)) return "array";
  const valueType = fieldValueType(field);
  if (valueType === "string" && field.validation?.format === "uuid") return "uuid";
  return valueType;
}

export function fieldShapeKind(field: Field): FieldShapeKind {
  if (isFieldCollection(field)) return "collection";
  const valueType = fieldValueType(field);
  if (valueType === "string" && field.validation?.format === "uuid") return "uuid";
  return valueType;
}

export function fieldAcceptsValueType(
  field: Field,
  valueType: FieldValueType,
): boolean {
  return fieldValueType(field) === valueType && !isFieldCollection(field);
}
