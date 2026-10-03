// SPDX-License-Identifier: BUSL-1.1
import type {
  Field,
  LocalizedText,
} from "@/generated/compiler/field-contract";
import {
  COMPILER_FIELD_TYPE_OPTIONS,
  FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE,
  type CompilerAuthorableFieldType,
} from "@/lib/field-authoring/compiler-field-types";
import {
  isFieldCardinalityCollection,
  normalizeFieldCardinality,
} from "./cardinality-utils";
import { fieldValueType } from "@/lib/field-contract/field-v2";
import { getEffectiveRequired } from "./validation-utils";

export function getFieldTypeOptions(
  excludedFieldTypes: readonly string[],
  currentType: CompilerAuthorableFieldType,
) {
  const excluded = new Set(excludedFieldTypes);
  const options = COMPILER_FIELD_TYPE_OPTIONS.filter((option) =>
    !excluded.has(option.value),
  );

  if (options.some((option) => option.value === currentType)) {
    return options;
  }

  return [
    ...options,
    {
      value: currentType,
      label: { nl: currentType, en: currentType } satisfies LocalizedText,
    },
  ];
}

export function getFieldTypeKey(field: Field): CompilerAuthorableFieldType {
  if (isFieldCardinalityCollection(field.cardinality)) {
    return field.osfType === "fieldDefinition"
      ? FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE
      : "collection";
  }
  return fieldValueType(field);
}

export function getFieldSelectionTypeKey(selection: {
  valueType: string;
  cardinality: "single" | "collection";
  osfType?: string;
}): CompilerAuthorableFieldType {
  if (selection.cardinality === "collection") {
    return selection.osfType === "fieldDefinition"
      ? FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE
      : "collection";
  }

  return selection.valueType as CompilerAuthorableFieldType;
}

export function applyFieldTypeSelection(
  field: Field,
  selection: {
    valueType: string;
    cardinality: "single" | "collection";
    osfType?: string;
  },
  createEmptyField: () => Field,
): Field {
  const valueType = selection.valueType as NonNullable<Field["baseType"]>;
  // One type axis: a catalog key refines the base; without one the base is the type.
  const osfType = selection.osfType ?? valueType;

  if (selection.cardinality === "collection") {
    const cardinality = normalizeFieldCardinality("collection", getEffectiveRequired(field));
    const existingShape = Array.isArray((field as { shape?: Field[] }).shape)
      ? (field as { shape?: Field[] }).shape
      : field.children;
    if (selection.osfType === "fieldDefinition") {
      return {
        ...field,
        cardinality,
        osfType: "fieldDefinition",
        shape: undefined,
        children: undefined,
        item: undefined,
      } as unknown as Field;
    }

    return {
      ...field,
      osfType,
      cardinality,
      ...(valueType === "object"
        ? { shape: existingShape ?? [], children: existingShape ?? [] }
        : { shape: undefined, children: undefined }),
      item: undefined,
    } as unknown as Field;
  }

  if (valueType === "object") {
    const existingShape = Array.isArray((field as { shape?: Field[] }).shape)
      ? (field as { shape?: Field[] }).shape
      : field.children;

    return {
      ...field,
      osfType,
      cardinality: normalizeFieldCardinality("single", getEffectiveRequired(field)),
      shape: existingShape ?? [],
      children: existingShape ?? [],
      item: undefined,
    } as unknown as Field;
  }

  return {
    ...field,
    osfType,
    cardinality: normalizeFieldCardinality("single", getEffectiveRequired(field)),
    shape: undefined,
    children: undefined,
    item: undefined,
  } as unknown as Field;
}
