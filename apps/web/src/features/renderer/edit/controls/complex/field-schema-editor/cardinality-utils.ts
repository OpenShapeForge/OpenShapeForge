// SPDX-License-Identifier: BUSL-1.1
import { isRecord } from "./value-utils";

export function isFieldCardinalityCollection(value: unknown): boolean {
  if (value === "collection") {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.max === "unbounded") {
    return true;
  }
  return typeof value.max === "number" && value.max > 1;
}

export function normalizeFieldCardinality(
  value: unknown,
  required = false,
): { min: number; max: number | "unbounded" } {
  if (isRecord(value)) {
    const min = typeof value.min === "number" && Number.isInteger(value.min) && value.min >= 0
      ? value.min
      : required
        ? 1
        : 0;
    const max = value.max === "unbounded"
      ? "unbounded"
      : typeof value.max === "number" && Number.isInteger(value.max) && value.max >= 0
        ? value.max
        : 1;
    return { min, max };
  }

  if (value === "collection") {
    return { min: required ? 1 : 0, max: "unbounded" };
  }

  return { min: required ? 1 : 0, max: 1 };
}
