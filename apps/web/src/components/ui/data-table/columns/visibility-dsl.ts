// SPDX-License-Identifier: BUSL-1.1
/**
 * Visibility/disabled DSL for row actions.
 *
 * Extracted from the legacy `EntityList` so it can be unit-tested in isolation
 * and reused by `createActionsColumn` on the new `DataTable`.
 */

export type VisibilityOperator =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "isEmpty"
  | "isNotEmpty";

export interface VisibilityCondition {
  field: string;
  operator: VisibilityOperator;
  value?: unknown;
}

export interface VisibilityConfig {
  conditions: VisibilityCondition[];
  logic?: "and" | "or";
}

function getNestedValue(input: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, input);
}

function evaluateCondition(
  condition: VisibilityCondition,
  row: Record<string, unknown>,
): boolean {
  const value = getNestedValue(row, condition.field);

  switch (condition.operator) {
    case "eq":
      return value === condition.value;
    case "neq":
      return value !== condition.value;
    case "in":
      return (
        Array.isArray(condition.value) && condition.value.includes(value)
      );
    case "notIn":
      return (
        Array.isArray(condition.value) && !condition.value.includes(value)
      );
    case "gt":
      return Number(value) > Number(condition.value);
    case "lt":
      return Number(value) < Number(condition.value);
    case "gte":
      return Number(value) >= Number(condition.value);
    case "lte":
      return Number(value) <= Number(condition.value);
    case "isEmpty":
      return value == null || value === "";
    case "isNotEmpty":
      return value != null && value !== "";
    default:
      return true;
  }
}

/**
 * Evaluate a visibility/disabled configuration against a row.
 *
 * - When `config` is undefined or has no conditions → `true` (i.e. visible/not-disabled).
 * - When `logic === "or"` → any condition matching yields `true`.
 * - Otherwise (default AND) → every condition must match.
 */
export function matchesVisibility(
  config: VisibilityConfig | undefined,
  row: Record<string, unknown>,
): boolean {
  if (!config?.conditions?.length) {
    return true;
  }

  const results = config.conditions.map((condition) =>
    evaluateCondition(condition, row),
  );
  return config.logic === "or"
    ? results.some(Boolean)
    : results.every(Boolean);
}
