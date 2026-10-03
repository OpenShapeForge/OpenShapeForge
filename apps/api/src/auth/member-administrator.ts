// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from 'kysely';
import type { DB } from '../generated/db/types.js';
import { HttpError } from '../rest/http-error.js';
import { IDENTITY_LINK_ADMIN_ROLE } from './organization-roles.js';

/** Shared by role removal and blocking, under one tenant-wide transaction lock. */
export async function protectDirectAdministrator(
  trx: Transaction<DB>, tenantId: string, identityId: string, nextRoles: readonly string[],
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 7921))`.execute(trx);
  const result = await sql<{ identity_id: string; roles: string[] }>`select identity_id, roles
    from platform.identity_relations where tenant_id = ${tenantId}::uuid and status = 'linked' and not access_blocked
      and ('org_admin' = any(roles) or ${IDENTITY_LINK_ADMIN_ROLE} = any(roles))`.execute(trx);
  const currentIsAdmin = result.rows.some(row => row.identity_id === identityId);
  const nextIsAdmin = nextRoles.includes('org_admin') || nextRoles.includes(IDENTITY_LINK_ADMIN_ROLE);
  if (currentIsAdmin && !nextIsAdmin && !result.rows.some(row => row.identity_id !== identityId)) {
    throw new HttpError(409, 'LAST_ADMINISTRATOR', 'Keep at least one active directly assigned organization administrator.');
  }
}
