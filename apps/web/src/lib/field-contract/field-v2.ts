// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_OSF_TYPES } from "@/generated/compiler/osf-types";
import { cardinalityOf, resolveFieldBaseType, type OperationFieldSchemaRegistry } from "@openshapeforge/operations";

export type FieldValueType = NonNullable<Field["baseType"]>;
export type FieldTypeResolution =
  | Readonly<{ ok: true; value: FieldValueType }>
  | Readonly<{ ok: false; message: string }>;

const BASE_TYPES: ReadonlySet<string> = new Set(["string", "integer", "number", "boolean", "date", "datetime", "object"]);
const ENTITY_REFERENCE_TYPES: ReadonlySet<string> = new Set(
  Object.values(COMPILER_OSF_TYPES).flatMap((definition) =>
    "entity" in definition && typeof definition.entity === "string"
      ? [definition.entity]
      : [],
  ),
);

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
  let resolved: FieldValueType;
  try {
    resolved = resolveFieldBaseType(
      { key: field.key ?? field.osfType, osfType: field.osfType },
      COMPILER_OSF_TYPES as OperationFieldSchemaRegistry["osfTypes"],
    );
  } catch (error) {
    // Generated relationship fields use the referenced entity name as their
    // osfType. They are a declared string-valued contract even though entity
    // names are not semantic type aliases in COMPILER_OSF_TYPES.
    if (
      field.baseType === "string" &&
      ENTITY_REFERENCE_TYPES.has(field.osfType)
    ) {
      resolved = "string";
    } else {
      throw error;
    }
  }
  if (field.baseType && field.baseType !== resolved) {
    throw new Error(
      `${field.key ?? field.osfType}: baseType ${field.baseType} does not match osfType ${field.osfType} (${resolved}).`,
    );
  }
  return field.baseType ?? resolved;
}

/** Resolve an untrusted runtime field without inventing a fallback type. */
export function tryFieldValueType(
  field: Pick<Field, "osfType" | "baseType"> & { key?: string },
): FieldTypeResolution {
  try {
    return { ok: true, value: fieldValueType(field) };
  } catch {
    return {
      ok: false,
      message: `Unsupported field contract for "${field.key ?? "(unnamed)"}" (${field.osfType || "missing osfType"}).`,
    };
  }
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
