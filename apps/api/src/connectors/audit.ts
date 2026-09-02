// SPDX-License-Identifier: BUSL-1.1
/**
 * Audit trail for connector configuration changes.
 *
 * Configuring a connector hands credentials for another system to the platform,
 * so who did it and what they touched is worth keeping. It rides on the
 * existing `platform.entity_events` journal rather than a private table: the
 * journal is already tenant-scoped, RLS'd, append-only and written inside the
 * mutating transaction.
 *
 * WHAT IS RECORDED: the actor, the connector, the instance, and the FIELD KEYS
 * that changed. Never a value, and never a secret — not even a redacted or
 * hashed one. A journal is exactly the kind of long-lived, widely-read store
 * where a value nobody meant to keep survives longest.
 */
import { appendEntityEventInTransaction } from "../platform/entity-events.js";
import type { Transaction } from "kysely";
import type { DB } from "../generated/db/types.js";
import type { ProviderFailureAuditFields } from "./provider-outcome.js";

export const CONNECTOR_AGGREGATE = "connector_installation";

export type ConnectorAuditEvent =
  | "connector.configured"
  | "connector.secret_set"
  | "connector.enabled"
  | "connector.disabled"
  | "connector.verified"
  // Written by the platform rather than by a person, so `userId` is null: a
  // token rotation happens mid-invocation on whoever's behalf the call was
  // made, and attributing it to that caller would read as an administrative
  // action they did not take.
  | "connector.token_refreshed"
  | "connector.reauthorization_required"
  // The provider answered an invocation with a failure. Records the
  // classification and the numeric status the platform observed — never the
  // provider's body, headers, or anything the package said.
  | "connector.provider_failed";

export type ConnectorAuditInput = {
  tenantId: string;
  userId: string | null;
  connectorSlug: string;
  instanceKey: string;
  event: ConnectorAuditEvent;
  /** Field keys touched — names only. */
  changedFields?: readonly string[];
  /** Secret field keys written — names only, never values. */
  secretFields?: readonly string[];
  contractChecksum?: string;
  providerFailure?: ProviderFailureAuditFields;
};

export async function recordConnectorAudit(
  trx: Transaction<DB>,
  input: ConnectorAuditInput,
): Promise<void> {
  await appendEntityEventInTransaction(trx, {
    tenantId: input.tenantId,
    aggregateType: CONNECTOR_AGGREGATE,
    aggregateId: `${input.connectorSlug}:${input.instanceKey}`,
    eventType: input.event,
    payload: {
      connectorSlug: input.connectorSlug,
      instanceKey: input.instanceKey,
      actorUserId: input.userId,
      // Sorted so the same change always journals the same bytes.
      changedFields: [...(input.changedFields ?? [])].sort(),
      secretFields: [...(input.secretFields ?? [])].sort(),
      ...(input.contractChecksum ? { contractChecksum: input.contractChecksum } : {}),
      ...(input.providerFailure ? { providerFailure: input.providerFailure } : {}),
    },
  });
}
