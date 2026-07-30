// SPDX-License-Identifier: BUSL-1.1
import { getActiveLabelRules } from "@/features/labels/actions/get-active-label-rules";
import { GraphqlProxyError } from "@/lib/server/graphql-client";
import type { LabelRule } from "@/features/labels/lib/label-evaluator";
import { recordToLabelRule } from "@/features/labels/lib/label-rule-record";
import {
  resolveFilteredAggregates,
  rewriteConditionPaths,
} from "@/features/labels/lib/resolve-filtered-aggregates";
import { EntityLabels } from "./EntityLabels";

export async function EntityLabelsServer({
  entityType,
  entityData,
}: {
  entityType: string;
  entityData: Record<string, unknown>;
}) {
  let rawRules: Array<Record<string, unknown> | null | undefined> = [];

  try {
    rawRules = await getActiveLabelRules(entityType);
  } catch (error) {
    if (
      error instanceof GraphqlProxyError &&
      error.status === 400 &&
      error.message.includes("Unknown type")
    ) {
      return null;
    }
    throw error;
  }

  const rules: LabelRule[] = rawRules
    .filter((rule): rule is NonNullable<typeof rule> => rule != null)
    .map(recordToLabelRule);

  if (rules.length === 0) {
    return null;
  }

  // Resolve any filtered aggregates referenced in rule conditions
  const { enrichedData } = await resolveFilteredAggregates(
    rules,
    entityData,
    entityType,
  );

  // Rewrite condition paths so filtered aggregate operands point at the
  // synthetic keys in the enriched data
  const rewrittenRules = rules.map((rule) => ({
    ...rule,
    condition: rewriteConditionPaths(rule.condition),
  }));

  return <EntityLabels rules={rewrittenRules} entityData={enrichedData} />;
}
