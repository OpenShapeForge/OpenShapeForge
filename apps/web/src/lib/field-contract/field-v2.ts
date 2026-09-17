// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_OSF_TYPES } from "@/generated/compiler/osf-types";

export type FieldValueType = NonNullable<Field["baseType"]>;

const BASE_TYPES: ReadonlySet<string> = new Set(["string", "integer", "number", "boolean", "date", "datetime", "object"]);

export function isBaseType(osfType: string | undefined): osfType is FieldValueType {
  return osfType !== undefined && BASE_TYPES.has(osfType);
}

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

/**
 * The base type behind a field's `osfType`: compiled fields carry it as
 * `baseType`; an authored field resolves a base type to itself and a
 * catalog key to the entry's `valueType`.
 */
export function fieldValueType(field: Pick<Field, "osfType" | "baseType">): FieldValueType {
  if (field.baseType) return field.baseType;
  if (isBaseType(field.osfType)) return field.osfType;
  const semantic = COMPILER_OSF_TYPES[field.osfType as keyof typeof COMPILER_OSF_TYPES] as { valueType?: string } | undefined;
  return (semantic?.valueType ?? "string") as FieldValueType;
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
  return isFieldObjectCollection(field) && field.osfType === "fieldDefinition";
}

export function isActionDefinitionCollection(field: Field): boolean {
  return isFieldObjectCollection(field) && field.osfType === "actionDefinition";
}

export function isActionDefinitionItem(field: Field): boolean {
  return fieldValueType(field) === "object" && field.osfType === "actionDefinitionItem";
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
