// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";

/** Validate boolean structure before SQL or policy checks; expose every leaf to existing guards. */
export function filterLeaves(filter?: Record<string, unknown> | null): Record<string, unknown>[] {
  let count = 0;
  const leaves: Record<string, unknown>[] = [];
  function visit(value: unknown, depth: number) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4 || ++count > 200) {
      throw operationFailure({code:'BAD_USER_INPUT',message:'The filter is invalid or too complex.'});
    }
    const leaf: Record<string, unknown> = {};
    for (const [key, predicate] of Object.entries(value)) {
      if (key === 'and' || key === 'or') {
        if (!Array.isArray(predicate) || !predicate.length || predicate.length > 20) {
          throw operationFailure({code:'BAD_USER_INPUT',message:'Invalid filter group.'});
        }
        for (const child of predicate) visit(child, depth + 1);
      } else leaf[key] = predicate;
    }
    leaves.push(leaf);
  }
  if (filter != null) visit(filter, 0);
  return leaves;
}
export function filterFieldNames(filter?: Record<string, unknown> | null): string[] {
  return filterLeaves(filter).flatMap(Object.keys);
}
