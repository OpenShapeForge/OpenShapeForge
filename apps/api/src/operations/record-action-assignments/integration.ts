// SPDX-License-Identifier: BUSL-1.1
/**
 * The subject of a LISTING, resolved by the SERVER rather than accepted.
 *
 * An `integrations` entry of a record ACL names
 * `platform.api_key_integrations.id` — a tenant-bound surrogate key that
 * survives key rotation (docs/api.md). The read half takes that id from the
 * caller, so it resolves it here first: the row must exist in the SESSION's
 * tenant, or the question is refused rather than answered with an empty page.
 * Without this, the surface would be a way to ask after an id it has no
 * business naming and learn from the silence.
 *
 * Existence is the whole test, and a DISABLED integration passes it on
 * purpose: its leftover grants have to be findable before they can be
 * removed. The stricter "must be active" demand that a GRANT needs is not
 * here — it belongs to the one canonical writer of the axis, which takes it
 * inside the record's ACL-row lock
 * (operations/record-action-operations.ts), where a concurrent disable cannot
 * slip between the check and the write.
 *
 * The read is an ordinary one. `platform.api_key_integrations` is
 * tenant-scoped and its generated policy is what fences it; the explicit
 * predicate is the same defence in depth every other platform read applies.
 * Nothing but the existence of the row is reported, so the surface cannot be
 * used to learn an integration's name, client or status.
 */
import { operationFailure } from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionInput } from "../../db/session.js";

export async function requireTenantIntegration(
  trx: Transaction<DB>,
  session: DbSessionInput,
  integrationId: string,
): Promise<void> {
  const result = await sql<{ id: string }>`
    select id from platform.api_key_integrations
     where id = ${integrationId}::uuid
       and tenant_id = ${session.tenantId}::uuid
     limit 1
  `.execute(trx);
  if (!result.rows[0]) {
    throw operationFailure({
      code: "NOT_FOUND",
      message: "No such integration in this organization.",
      retryable: false,
    });
  }
}
