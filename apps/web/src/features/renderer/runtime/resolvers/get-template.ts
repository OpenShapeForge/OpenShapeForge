// SPDX-License-Identifier: BUSL-1.1
"use server";

import { executeGraphqlRequest } from "@/lib/server/graphql-client";

/**
 * A template's name and declared `parameters` for the variable picker.
 *
 * Issued against the generated GraphQL surface rather than a generated
 * per-entity server action, because `Template` is an application entity a host
 * repo may or may not author. Without it the schema has no `template` field;
 * the caller already returns no suggestions for a null result.
 */
export async function getTemplate(
  id: string,
): Promise<Record<string, unknown> | null> {
  const data = await executeGraphqlRequest<{
    template?: Record<string, unknown> | null;
  }>({
    query: `query ($id: ID!) { template(id: $id) { id name parameters } }`,
    variables: { id },
  });
  return data?.template ?? null;
}
