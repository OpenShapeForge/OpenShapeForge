// SPDX-License-Identifier: BUSL-1.1
import { COMPILER_FIELD_AUTHORING_PROFILES } from "@/generated/compiler/field-authoring-profiles";
import {
  FIELD_DEFINITION_COLLECTION_COMPAT_TYPE,
  FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE,
  type CompilerAuthorableFieldType,
} from "../compiler-field-types";
import type {
  FieldAuthoringProfile,
  FieldAuthoringProfileControls,
  FieldAuthoringProfileId,
} from "./types";

export function profileLabel(
  id: FieldAuthoringProfileId,
  fallback: FieldAuthoringProfile["label"],
): FieldAuthoringProfile["label"] {
  const label = COMPILER_FIELD_AUTHORING_PROFILES[id]?.label;
  return {
    nl: label?.nl ?? fallback.nl,
    en: label?.en ?? fallback.en,
  };
}

export function profileControls(
  id: FieldAuthoringProfileId,
  fallback: FieldAuthoringProfileControls,
): FieldAuthoringProfileControls {
  const controls = COMPILER_FIELD_AUTHORING_PROFILES[id]?.controls;
  return controls && typeof controls === "object"
    ? ({
        ...fallback,
        ...controls,
      } as FieldAuthoringProfileControls)
    : fallback;
}

export function profileExcludedFieldTypes(
  id: FieldAuthoringProfileId,
  fallback: CompilerAuthorableFieldType[],
): CompilerAuthorableFieldType[] {
  const excluded = COMPILER_FIELD_AUTHORING_PROFILES[id]?.excludedFieldTypes as
    | readonly string[]
    | undefined;
  if (!Array.isArray(excluded)) return fallback;

  const normalized = excluded
    .map((value) => normalizeAuthorableFieldType(value))
    .filter((value): value is CompilerAuthorableFieldType => Boolean(value));

  return [...new Set(normalized)];
}

function normalizeAuthorableFieldType(
  value: string,
): CompilerAuthorableFieldType | undefined {
  if (
    value === FIELD_DEFINITION_COLLECTION_COMPAT_TYPE ||
    value === FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE
  ) {
    return FIELD_DEFINITION_SEMANTIC_COLLECTION_TYPE;
  }

  return value === "string" ||
    value === "integer" ||
    value === "number" ||
    value === "boolean" ||
    value === "date" ||
    value === "datetime" ||
    value === "object" ||
    value === "collection"
    ? value
    : undefined;
}

export function profileTypePickerUsage(
  id: FieldAuthoringProfileId,
  fallback: FieldAuthoringProfile["typePickerUsage"],
): FieldAuthoringProfile["typePickerUsage"] {
  const usage = COMPILER_FIELD_AUTHORING_PROFILES[id]?.typePickerUsage as
    | string
    | undefined;
  return usage === "requestInput" ||
    usage === "workflowConfig" ||
    usage === "entityMapping" ||
    usage === "internalSchema"
    ? usage
    : fallback;
}
