// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { ModuleOperationAvailabilityHandler } from '../modules/contract.js';

/** The existing Operation availability contract, used for source records too. */
function accountAvailability(blocked?: boolean): ModuleOperationAvailabilityHandler {
  return async (ids, { db, session }) => {
    if (!session.tenantId) throw new Error('A tenant is required for Account availability.');
    const rows = ids.length ? (await sql<{ identity_id: string; status: string; access_blocked: boolean }>`
      select identity_id, status, access_blocked from platform.identity_relations
      where tenant_id=${session.tenantId}::uuid and identity_id in (${sql.join(ids.map(id => sql`${id}::uuid`))})
      `.execute(db)).rows : [];
    const byId = new Map(rows.map(row => [row.identity_id, row]));
    return Object.fromEntries(ids.map(id => [id, !byId.has(id)
      ? { available: false as const, error: { code: 'NOT_FOUND', message: 'Account not found in this organization.', retryable: false } }
      : byId.get(id)!.status !== 'linked'
        ? { available: false as const, error: { code: 'INVALID_STATE', message: 'The account is not linked yet.', retryable: false } }
      : blocked !== undefined && byId.get(id)!.access_blocked === blocked
        ? { available: false as const, error: { code: 'INVALID_STATE', message: blocked
          ? 'Organization access is already blocked.' : 'Organization access is already active.', retryable: false } }
        : { available: true as const }]));
  };
}

export const blockAccountAvailability = accountAvailability(true);
export const restoreAccountAvailability = accountAvailability(false);
export const roleAccountAvailability = accountAvailability();
