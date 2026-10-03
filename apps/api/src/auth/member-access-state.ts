// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { OpenShapeForgeDatabase } from '../db/connection.js';
import { withDbSession } from '../db/session.js';
import { HttpError } from '../rest/http-error.js';
import type { TrustedSessionContext } from './trusted-context.js';
import { SessionAuthenticationUnavailableError } from './session-unavailable.js';

/** Deliberately uncached: blocking takes effect on the next request on every replica. */
export async function assertMemberAccessActive(db: OpenShapeForgeDatabase | undefined, session: TrustedSessionContext) {
  if (!db || !session.tenantId || !session.userId || !session.issuer) return;
  if (session.credential === 'control-bearer' || session.credential === 'grant' || session.credential === 'none') return;
  let blocked: boolean;
  try {
    blocked = await withDbSession(db, session, async tx => {
      const result = await sql<{ access_blocked: boolean }>`select ir.access_blocked
        from platform.identity_relations ir join platform.identities i on i.id=ir.identity_id
        where ir.tenant_id=${session.tenantId}::uuid and i.issuer=${session.issuer!}
          and i.subject=${session.userId}`.execute(tx);
      return result.rows[0]?.access_blocked === true;
    });
  } catch {
    throw new SessionAuthenticationUnavailableError('Member access could not be verified; try again.');
  }
  if (blocked) throw new HttpError(403, 'MEMBER_ACCESS_BLOCKED', 'Your access to this organization is blocked. Contact its administrator.');
}
