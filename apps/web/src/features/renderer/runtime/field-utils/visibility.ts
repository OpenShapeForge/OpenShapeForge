// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import {
  getValueAtPath,
  parseRendererPath,
  type RendererPathPart,
} from "../path-utils";
import { hasRendererFieldReadAccess } from "./permissions";

/**
 * Resolves visibility condition paths against a row/object scope first, then
 * the form root. Used for collection item children and nested object children whose
 * `visibility` references sibling keys (e.g. `workflowId` on a router intent row).
 */
export function resolveRendererVisibilityConditionValue(
  rootValues: Record<string, unknown>,
  visibilityScope: Record<string, unknown> | null | undefined,
  conditionField: string,
): unknown {
  const path = parseRendererPath(conditionField);
  if (
    visibilityScope &&
    typeof visibilityScope === "object" &&
    !Array.isArray(visibilityScope)
  ) {
    const scoped = getValueAtPath(visibilityScope, path);
    if (scoped !== undefined) {
      return scoped;
    }
  }
  return getValueAtPath(rootValues, path);
}

/**
 * Object/collection parent value to use as {@link resolveRendererVisibilityConditionValue}
 * `visibilityScope` for a field at `fieldPath`.
 */
export function resolveRendererVisibilityScope(
  rootValues: Record<string, unknown>,
  fieldPath: readonly RendererPathPart[],
  collectionRootPath?: readonly RendererPathPart[],
): Record<string, unknown> | undefined {
  if (collectionRootPath && collectionRootPath.length < fieldPath.length) {
    const rowPath = fieldPath.slice(0, collectionRootPath.length + 1);
    const rowRaw = getValueAtPath(rootValues, rowPath);
    if (rowRaw && typeof rowRaw === "object" && !Array.isArray(rowRaw)) {
      const rowRecord = rowRaw as Record<string, unknown>;
      const nestedManualKey = fieldPath[collectionRootPath.length + 1];
      const nestedManualValue =
        nestedManualKey === "field" || nestedManualKey === "value"
          ? rowRecord[nestedManualKey]
          : null;
      if (
        rowRecord.kind === "manual" &&
        nestedManualValue &&
        typeof nestedManualValue === "object" &&
        !Array.isArray(nestedManualValue)
      ) {
        return nestedManualValue as Record<string, unknown>;
      }
      return rowRaw as Record<string, unknown>;
    }
  }
  if (fieldPath.length > 0) {
    const parentPath = fieldPath.slice(0, -1);
    const parent = getValueAtPath(rootValues, parentPath);
    if (parent && typeof parent === "object" && !Array.isArray(parent)) {
      return parent as Record<string, unknown>;
    }
  }
  return undefined;
}

export function isRendererFieldVisible(
  field: Field,
  rootValues: Record<string, unknown>,
  grantedPermissions?: readonly string[],
  visibilityScope?: Record<string, unknown> | null,
): boolean {
  if (!hasRendererFieldReadAccess(field, grantedPermissions)) {
    return false;
  }

  if (!field.visibility || field.visibility.conditions.length === 0) {
    return true;
  }

  const results = field.visibility.conditions.map((condition) => {
    const left = resolveRendererVisibilityConditionValue(
      rootValues,
      visibilityScope,
      condition.field,
    );
    switch (condition.operator) {
      case "eq":
        return left === condition.value;
      case "neq":
        return left !== condition.value;
      case "in":
        return Array.isArray(condition.value)
          ? condition.value.includes(left)
          : false;
      case "notIn":
        return Array.isArray(condition.value)
          ? !condition.value.includes(left)
          : true;
      case "gt":
        return typeof left === "number" && typeof condition.value === "number"
          ? left > condition.value
          : false;
      case "lt":
        return typeof left === "number" && typeof condition.value === "number"
          ? left < condition.value
          : false;
      case "gte":
        return typeof left === "number" && typeof condition.value === "number"
          ? left >= condition.value
          : false;
      case "lte":
        return typeof left === "number" && typeof condition.value === "number"
          ? left <= condition.value
          : false;
      case "isEmpty":
        return (
          left == null ||
          left === "" ||
          (Array.isArray(left) && left.length === 0)
        );
      case "isNotEmpty":
        return !(
          left == null ||
          left === "" ||
          (Array.isArray(left) && left.length === 0)
        );
      default:
        return true;
    }
  });

  return field.visibility.logic === "or"
    ? results.some(Boolean)
    : results.every(Boolean);
}
