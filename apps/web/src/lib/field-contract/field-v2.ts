// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_OSF_TYPES } from "@/generated/compiler/osf-types";
import { cardinalityOf, resolveFieldBaseType, type OperationFieldSchemaRegistry } from "@openshapeforge/operations";

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
 * `baseType`; an authored field resolves through the generated catalog with
 * the same resolver the projector uses, so an unknown osfType is an error
 * here as it is there, never a field quietly treated as text.
 */
export function fieldValueType(field: Pick<Field, "osfType" | "baseType"> & { key?: string }): FieldValueType {
  if (field.baseType) return field.baseType;
  return resolveFieldBaseType(
    { key: field.key ?? field.osfType, osfType: field.osfType },
    COMPILER_OSF_TYPES as OperationFieldSchemaRegistry["osfTypes"],
  );
}

/** The one reading of cardinality; invalid bounds are an authoring error, not a single value. */
export function fieldCardinality(field: Field): FieldCardinality {
  return cardinalityOf(field.cardinality, field.key).cardinality;
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
