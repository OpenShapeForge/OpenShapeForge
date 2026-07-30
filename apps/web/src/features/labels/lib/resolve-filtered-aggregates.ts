// SPDX-License-Identifier: BUSL-1.1
/**
 * Resolves filtered aggregate values for label rule conditions.
 *
 * Walks the condition tree to find path operands with a `filter` property,
 * builds a single GraphQL query with aliased filtered aggregate fields,
 * executes it, and returns an enriched entity data object with the resolved
 * values placed at the operand paths.
 *
 * Example: a condition operand `{ kind: "path", path: "tasksAggregate.count", filter: { status: "open" } }`
 * produces a GraphQL alias like `_fa0: tasksAggregate(filter: { status: "open" }) { count }`
 * and merges the result back into entity data at `tasksAggregate.count` → the filtered value.
 */

import type {
  CompilerConditionInput,
  CompilerConditionOperandInput,
} from "@/generated/compiler/canonical-condition";
import {
  isConditionGroup,
  isConditionRule,
  getConditionGroupItems,
} from "@/features/renderer/runtime/conditions";
import { executeGraphqlRequest } from "@/lib/server/graphql-client";
import type { LabelRule } from "./label-evaluator";

// ── Types ──

type FilteredAggregateRequest = {
  /** The full operand path, e.g. "tasksAggregate.count" */
  path: string;
  /** The aggregate relationship field, e.g. "tasksAggregate" */
  aggregateField: string;
  /** The sub-field, e.g. "count" */
  subField: string;
  /** The filter to apply, e.g. { status: "open" } */
  filter: Record<string, unknown>;
};

// ── Condition tree walker ──

function collectFilteredAggregateOperands(
  condition: CompilerConditionInput | null | undefined,
  result: FilteredAggregateRequest[],
  seen: Set<string>,
): void {
  if (!condition) return;

  if (isConditionGroup(condition)) {
    for (const item of getConditionGroupItems(condition)) {
      collectFilteredAggregateOperands(item, result, seen);
    }
    return;
  }

  if (isConditionRule(condition)) {
    collectFromOperand(condition.left, result, seen);
    if (condition.right) {
      collectFromOperand(condition.right, result, seen);
    }
  }
}

function collectFromOperand(
  operand: CompilerConditionOperandInput,
  result: FilteredAggregateRequest[],
  seen: Set<string>,
): void {
  if (operand.kind !== "path" || !operand.filter || !operand.path) return;

  const filter = operand.filter;
  if (!filter || typeof filter !== "object" || Object.keys(filter).length === 0) return;

  // Parse path: "tasksAggregate.count" → aggregateField="tasksAggregate", subField="count"
  const dotIndex = operand.path.indexOf(".");
  if (dotIndex === -1) return;

  const aggregateField = operand.path.slice(0, dotIndex);
  const subField = operand.path.slice(dotIndex + 1);
  if (!aggregateField.endsWith("Aggregate")) return;

  // Deduplicate by path + filter combo
  const dedupeKey = `${operand.path}::${JSON.stringify(filter)}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);

  result.push({
    path: operand.path,
    aggregateField,
    subField,
    filter,
  });
}

// ── GraphQL query builder ──

function buildFilteredAggregateQuery(
  entityTypeName: string,
  requests: FilteredAggregateRequest[],
): string {
  // Convert entity name to GraphQL query field: "LegalEntity" → "legalEntity", "Relation" → "relation"
  const queryField = entityTypeName.charAt(0).toLowerCase() + entityTypeName.slice(1);

  const aliasedFields = requests.map((req, i) => {
    const alias = `_fa${i}`;
    const filterJson = JSON.stringify(req.filter);
    return `    ${alias}: ${req.aggregateField}(filter: ${filterJson}) { ${req.subField} }`;
  });

  return `query ($id: ID!) {
  ${queryField}(id: $id) {
${aliasedFields.join("\n")}
  }
}`;
}

// ── Main resolver ──

/**
 * Collect all filtered aggregate operands across all label rules,
 * execute a single GraphQL query, and return enriched entity data
 * with resolved filtered values.
 *
 * The enriched data stores filtered aggregate results under synthetic keys
 * that the label evaluator can resolve. The evaluator's `resolveOperand`
 * reads from `entityData` using the operand path, so we place the filtered
 * value at a key that matches the operand path + filter combo.
 */
export async function resolveFilteredAggregates(
  rules: LabelRule[],
  entityData: Record<string, unknown>,
  entityTypeName: string,
): Promise<{
  enrichedData: Record<string, unknown>;
  /** Map from original operand path+filter to the resolved value */
  resolvedValues: Map<string, unknown>;
}> {
  const requests: FilteredAggregateRequest[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    collectFilteredAggregateOperands(rule.condition, requests, seen);
  }

  if (requests.length === 0) {
    return { enrichedData: entityData, resolvedValues: new Map() };
  }

  const entityId = entityData.id as string | undefined;
  if (!entityId) {
    return { enrichedData: entityData, resolvedValues: new Map() };
  }

  // Build and execute the query
  const query = buildFilteredAggregateQuery(entityTypeName, requests);
  const queryField = entityTypeName.charAt(0).toLowerCase() + entityTypeName.slice(1);

  let resolvedEntity: Record<string, unknown> | null = null;
  try {
    const result = await executeGraphqlRequest<Record<string, unknown>>({
      query,
      variables: { id: entityId },
    });
    resolvedEntity = (result as Record<string, unknown>)?.[queryField] as Record<string, unknown> | null;
  } catch {
    // If the query fails (e.g., entity doesn't have these relationships), fall through gracefully
    return { enrichedData: entityData, resolvedValues: new Map() };
  }

  if (!resolvedEntity) {
    return { enrichedData: entityData, resolvedValues: new Map() };
  }

  // Merge resolved values back into entity data
  const enriched = { ...entityData };
  const resolvedValues = new Map<string, unknown>();

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]!;
    const alias = `_fa${i}`;
    const aliasResult = resolvedEntity[alias] as Record<string, unknown> | null;
    if (!aliasResult) continue;

    const value = aliasResult[req.subField];
    const dedupeKey = `${req.path}::${JSON.stringify(req.filter)}`;
    resolvedValues.set(dedupeKey, value);

    // Place the resolved value in the entity data at the aggregate path.
    // We override the unfiltered aggregate with the filtered value so the
    // evaluator's `getValueAtPath(data, "tasksAggregate.count")` resolves
    // to the filtered count when the operand has a filter.
    //
    // Since the same aggregate path could appear with different filters in
    // different rules, we use a filter-specific synthetic key.
    const filterKey = `${req.aggregateField}__${JSON.stringify(req.filter)}`;
    const existingAgg = (enriched[req.aggregateField] ?? {}) as Record<string, unknown>;
    enriched[filterKey] = { ...existingAgg, [req.subField]: value };
  }

  return { enrichedData: enriched, resolvedValues };
}

/**
 * Rewrite condition operand paths that have filters to point at the
 * synthetic filter-specific keys in the enriched entity data.
 *
 * E.g., `{ kind: "path", path: "tasksAggregate.count", filter: { status: "open" } }`
 * becomes `{ kind: "path", path: "tasksAggregate__{"status":"open"}.count" }`
 */
export function rewriteConditionPaths(
  condition: CompilerConditionInput | null | undefined,
): CompilerConditionInput | null {
  if (!condition) return null;

  if (isConditionGroup(condition)) {
    const items = getConditionGroupItems(condition);
    const rewritten = items.map((item) => rewriteConditionPaths(item)).filter(Boolean) as CompilerConditionInput[];

    // Rebuild the group with the same structure
    if ("conditions" in condition) {
      return { ...condition, conditions: rewritten };
    }
    if ("all" in condition) {
      return { ...condition, all: rewritten };
    }
    if ("any" in condition) {
      return { ...condition, any: rewritten };
    }
    return { ...condition, conditions: rewritten };
  }

  if (isConditionRule(condition)) {
    return {
      ...condition,
      left: rewriteOperandPath(condition.left),
      right: condition.right ? rewriteOperandPath(condition.right) : condition.right,
    };
  }

  return condition;
}

function rewriteOperandPath(
  operand: CompilerConditionOperandInput,
): CompilerConditionOperandInput {
  if (operand.kind !== "path" || !operand.filter || !operand.path) return operand;

  const filter = operand.filter;
  if (!filter || typeof filter !== "object" || Object.keys(filter).length === 0) return operand;

  const dotIndex = operand.path.indexOf(".");
  if (dotIndex === -1) return operand;

  const aggregateField = operand.path.slice(0, dotIndex);
  const subField = operand.path.slice(dotIndex + 1);
  if (!aggregateField.endsWith("Aggregate")) return operand;

  const filterKey = `${aggregateField}__${JSON.stringify(filter)}`;
  return { kind: "path", path: `${filterKey}.${subField}` };
}
