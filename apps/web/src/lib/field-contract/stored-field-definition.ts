// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import {
  fieldValueType,
  isBaseType,
  type FieldValueType,
} from "@/lib/field-contract/field-v2";

const LEGACY_FIELD_DEFINITION_KEYS = ["valueType", "semanticType"] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Fail closed on the retired two-axis stored FieldDefinition shape. */
export function assertCanonicalStoredFieldDefinition(
  value: unknown,
  path = "Stored FieldDefinition",
): void {
  if (!isRecord(value)) return;
  for (const key of LEGACY_FIELD_DEFINITION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(
        `${path} uses removed legacy key "${key}"; reset the stored definition and use canonical "osfType".`,
      );
    }
  }
  for (const key of ["shape", "children"] as const) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      nested.forEach((child, index) =>
        assertCanonicalStoredFieldDefinition(child, `${path}.${key}[${index}]`));
    }
  }
  if (value.item !== undefined) {
    assertCanonicalStoredFieldDefinition(value.item, `${path}.item`);
  }
}

/**
 * Resolve canonical stored type metadata. A normal FieldDefinition needs only
 * `osfType`; a materialized variable-source row also carries its derived
 * `baseType`, which must agree with the active catalog.
 */
export function storedFieldDefinitionBaseType(
  value: Readonly<Record<string, unknown>>,
): FieldValueType {
  assertCanonicalStoredFieldDefinition(value);
  const osfType = typeof value.osfType === "string" && value.osfType.trim()
    ? value.osfType.trim()
    : undefined;
  const rawBaseType = value.baseType;
  if (
    rawBaseType !== undefined &&
    (typeof rawBaseType !== "string" || !isBaseType(rawBaseType))
  ) {
    throw new Error(
      `Stored FieldDefinition has unsupported canonical baseType "${String(rawBaseType)}".`,
    );
  }
  const baseType = rawBaseType as FieldValueType | undefined;
  if (!osfType) {
    throw new Error("Stored FieldDefinition has no canonical osfType.");
  }
  const resolved = fieldValueType({
    key: typeof value.key === "string" ? value.key : osfType,
    osfType,
  } as Pick<Field, "key" | "osfType" | "baseType">);
  if (baseType && baseType !== resolved) {
    throw new Error(
      `Stored FieldDefinition baseType "${baseType}" does not match osfType "${osfType}" (${resolved}).`,
    );
  }
  return baseType ?? resolved;
}
