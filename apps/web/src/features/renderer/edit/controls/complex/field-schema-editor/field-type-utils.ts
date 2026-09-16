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
    return field.valueType === "object" && field.semanticType === "fieldDefinition"
      ? FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE
      : "collection";
  }
  return field.valueType;
}

export function getFieldSelectionTypeKey(selection: {
  valueType: string;
  cardinality: "single" | "collection";
  semanticType?: string;
}): CompilerAuthorableFieldType {
  if (selection.cardinality === "collection") {
    return selection.valueType === "object" && selection.semanticType === "fieldDefinition"
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
    semanticType?: string;
  },
  createEmptyField: () => Field,
): Field {
  const valueType = selection.valueType as Field["valueType"];

  if (selection.cardinality === "collection") {
    const cardinality = normalizeFieldCardinality("collection", getEffectiveRequired(field));
    const existingShape = Array.isArray((field as { shape?: Field[] }).shape)
      ? (field as { shape?: Field[] }).shape
      : field.children;
    if (valueType === "object" && selection.semanticType === "fieldDefinition") {
      return {
        ...field,
        valueType: "object",
        cardinality,
        semanticType: "fieldDefinition",
        shape: undefined,
        children: undefined,
        item: undefined,
      } as unknown as Field;
    }

    return {
      ...field,
      valueType,
      cardinality,
      ...(selection.semanticType ? { semanticType: selection.semanticType } : { semanticType: undefined }),
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
      valueType: "object",
      cardinality: normalizeFieldCardinality("single", getEffectiveRequired(field)),
      ...(selection.semanticType ? { semanticType: selection.semanticType } : { semanticType: undefined }),
      shape: existingShape ?? [],
      children: existingShape ?? [],
      item: undefined,
    } as unknown as Field;
  }

  return {
    ...field,
    valueType,
    cardinality: normalizeFieldCardinality("single", getEffectiveRequired(field)),
    ...(selection.semanticType ? { semanticType: selection.semanticType } : { semanticType: undefined }),
    shape: undefined,
    children: undefined,
    item: undefined,
  } as unknown as Field;
}
