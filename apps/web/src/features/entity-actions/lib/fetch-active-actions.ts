// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { executeGraphqlRequest } from "@/lib/server/graphql-client";
import type { ActiveAction } from "../types";

const ACTIVE_ACTIONS_QUERY = `
  query ActiveActions($entityType: String!, $entityId: ID!) {
    activeActions(entityType: $entityType, entityId: $entityId) {
      key
      label
      description
      tone
      icon
      visibleWhen
      disabledWhen
      disabledMessage
      formFields
      awakeableId
      registeredAt
    }
  }
`;

interface ActiveActionsResponse {
  activeActions: ActiveAction[];
}

/**
 * Fetch the currently active entity-action buttons for a given entity
 * instance. Calls the ERP GraphQL `activeActions` query via the gateway.
 */
export async function fetchActiveActions(
  entityType: string,
  entityId: string,
): Promise<ActiveAction[]> {
  const data = await executeGraphqlRequest<ActiveActionsResponse>({
    query: ACTIVE_ACTIONS_QUERY,
    variables: { entityType, entityId },
  });

  return data?.activeActions ?? [];
}
