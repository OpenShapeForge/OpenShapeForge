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
      edges?: Array<{ node?: Record<string, unknown> | null }>;
    };
  }>({
    query: `query ActiveLabelRules($filter: LabelRuleFilter, $sort: LabelRuleSort, $first: Int) {
      labelRules(filter: $filter, sort: $sort, first: $first) {
        edges { node { id label variant expression descriptionTemplate priority } }
      }
    }`,
    variables: {
      filter: { entityType, active: true },
      sort: { field: "priority", direction: "desc" },
      first: 50,
    },
  });

  return (data?.labelRules?.edges ?? [])
    .map((edge) => edge.node)
    .filter(Boolean);
});
