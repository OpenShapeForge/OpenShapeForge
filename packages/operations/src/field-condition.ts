// SPDX-License-Identifier: BUSL-1.1
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const empty = (value: unknown) => value === null || value === undefined || value === "" ||
  (Array.isArray(value) && value.length === 0);

function compare(left: unknown, right: unknown): number | undefined {
  if (typeof left === "number" || typeof right === "number") {
    const a = Number(left), b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : undefined;
  }
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  return undefined;
}

/**
 * Whether a field applies to a record. `values` maps an authored field name
 * or `extensions.<key>` to the record's current value.
 */
export function evaluateFieldCondition(condition: unknown, values: (path: string) => unknown): boolean {
  if (condition === null || condition === undefined) return true;
  if (!record(condition)) return false;
  const children = (condition.all ?? condition.any ?? condition.conditions) as unknown[] | undefined;
  if (Array.isArray(children)) {
    const any = condition.any !== undefined || condition.mode === "any";
    return any ? children.some((child) => evaluateFieldCondition(child, values)) : children.every((child) => evaluateFieldCondition(child, values));
  }
  const left = values(String((condition.left as { path?: unknown } | undefined)?.path ?? ""));
  const right = (condition.right as { value?: unknown } | undefined)?.value;
  const list = Array.isArray(right) ? right : [right];
  switch (condition.operator) {
    case "equals": return Array.isArray(left) ? left.includes(right) : left === right;
    case "notEquals": return Array.isArray(left) ? !left.includes(right) : left !== right;
    case "in": return Array.isArray(left) ? left.some((item) => list.includes(item)) : list.includes(left);
    case "notIn": return Array.isArray(left) ? !left.some((item) => list.includes(item)) : !list.includes(left);
    case "isEmpty": return empty(left);
    case "isNotEmpty": return !empty(left);
    case "contains": return Array.isArray(left) ? left.includes(right) : typeof left === "string" && typeof right === "string" && left.includes(right);
    case "notContains": return Array.isArray(left) ? !left.includes(right) : !(typeof left === "string" && typeof right === "string" && left.includes(right));
    case "greaterThan": return (compare(left, right) ?? 0) > 0 && compare(left, right) !== undefined;
    case "greaterThanOrEquals": return compare(left, right) !== undefined && compare(left, right)! >= 0;
    case "lessThan": return compare(left, right) !== undefined && compare(left, right)! < 0;
    case "lessThanOrEquals": return compare(left, right) !== undefined && compare(left, right)! <= 0;
    default: return false;
  }
}
