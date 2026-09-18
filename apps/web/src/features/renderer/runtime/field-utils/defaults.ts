// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import type { RendererFieldConfig } from "@/features/renderer/form-definition";
import { isFieldCollection, isFieldObject, fieldValueType } from "@/lib/field-contract/field-v2";
import { parseRendererPath, type RendererPathPart } from "../path-utils";

export function buildDefaultRendererValue(field: Field): unknown {
  if (field.defaultValue !== undefined) {
    return JSON.parse(JSON.stringify(field.defaultValue));
  }

  if (isFieldObject(field)) {
    return Object.fromEntries(
      (field.children ?? []).map((child) => [
        child.key,
        buildDefaultRendererValue(child),
      ]),
    );
  }

  if (isFieldCollection(field)) {
    return [];
  }

  if (fieldValueType(field) === "boolean" && !isFieldCollection(field)) {
    return false;
  }

  if (
    !isFieldCollection(field) &&
    (fieldValueType(field) === "integer" || fieldValueType(field) === "number")
  ) {
    return "";
  }

  return "";
}

export function getRendererFieldPath(
  field: Field,
  parentPath: readonly RendererPathPart[] = [],
  fieldConfig?: RendererFieldConfig,
): RendererPathPart[] {
  if (
    typeof fieldConfig?.dataPath === "string" &&
    fieldConfig.dataPath.trim().length > 0
  ) {
    return parseRendererPath(fieldConfig.dataPath);
  }

  return [...parentPath, field.key];
}
