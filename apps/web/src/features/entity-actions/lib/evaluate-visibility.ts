// SPDX-License-Identifier: BUSL-1.1
import type { VisibilityConfig } from "@/compiler/field-contract";

/**
 * Evaluate a condition set against the current entity state.
 * Returns `true` when there are no conditions (visible by default), or when
 * ALL (or ANY for "or" logic) conditions are met.
 */
export function evaluateVisibility(
  config: VisibilityConfig | null | undefined,
  entityState: Record<string, unknown>,
): boolean {
  if (!config?.conditions?.length) return true;

  const results = config.conditions.map((condition) => {
    const fieldValue = entityState[condition.field];

    switch (condition.operator) {
      case "eq":
        return fieldValue === condition.value;
      case "neq":
        return fieldValue !== condition.value;
      case "isEmpty":
        return fieldValue == null || fieldValue === "";
      case "isNotEmpty":
        return fieldValue != null && fieldValue !== "";
      case "in":
        return Array.isArray(condition.value) && condition.value.includes(fieldValue);
      case "notIn":
        return Array.isArray(condition.value) && !condition.value.includes(fieldValue);
      case "gt":
        return (
          typeof fieldValue === "number" &&
          typeof condition.value === "number" &&
          fieldValue > condition.value
        );
      case "lt":
        return (
          typeof fieldValue === "number" &&
          typeof condition.value === "number" &&
          fieldValue < condition.value
        );
      case "gte":
        return (
          typeof fieldValue === "number" &&
          typeof condition.value === "number" &&
          fieldValue >= condition.value
        );
      case "lte":
        return (
          typeof fieldValue === "number" &&
          typeof condition.value === "number" &&
          fieldValue <= condition.value
        );
      default:
        return true;
    }
  });

  return config.logic === "or" ? results.some(Boolean) : results.every(Boolean);
}
