// SPDX-License-Identifier: BUSL-1.1
"use server";

import { cache } from "react";
import { executeGraphqlRequest } from "@/lib/server/graphql-client";

/**
 * Active label rules for an entity type, highest priority first.
 *
 * Issued against the generated GraphQL surface directly rather than through a
 * generated per-entity server action, because `LabelRule` is an application
 * entity a host repo may or may not author. When it is absent the schema has no
 * `labelRules` field and the API answers with an "Unknown type" error, which
 * `EntityLabelsServer` already treats as "this deployment has no labels" and
 * renders nothing. Authoring a `LabelRule` entity with the fields selected
 * below turns the feature on with no code change.
 */
export const getActiveLabelRules = cache(async (entityType: string) => {
  const data = await executeGraphqlRequest<{
    labelRules?: {
      data?: { items?: Array<{ data?: Record<string, unknown> | null }> } | null;
      error?: { code?: string; message?: string } | null;
    };
  }>({
    query: `query ActiveLabelRules($filter: LabelRuleFilter, $sort: LabelRuleSort, $first: Int) {
      labelRules(filter: $filter, sort: $sort, first: $first) {
        data { items { data { id label variant expression descriptionTemplate priority } } }
        error { code message retryable }
      }
    }`,
    variables: {
      filter: { entityType, active: true },
      sort: { field: "priority", direction: "desc" },
      first: 50,
    },
  });

  const result = data?.labelRules;
  if (result?.error) {
    throw new Error(`${result.error.code ?? "OPERATION_FAILED"}: ${result.error.message ?? "Operation failed."}`);
  }
  return (result?.data?.items ?? [])
    .map((item) => item.data)
    .filter(Boolean);
});
