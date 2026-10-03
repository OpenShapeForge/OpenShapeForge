// SPDX-License-Identifier: BUSL-1.1
import { realmFromIssuer } from '@openshapeforge/auth';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../generated/db/types.js';
import type { OpenShapeForgeDatabase } from '../db/connection.js';
import type { TrustedSessionContext } from '../auth/trusted-context.js';
import { resolveRelationGroupMembershipIds } from '../auth/relation-group-memberships.js';
import { resolveGroupRoles } from '../auth/group-roles.js';
import { personSessionRoles } from '../auth/person-roles.js';
import { resolveCustomRolePermissions } from './custom-roles.js';
import { HttpError } from '../rest/http-error.js';

/**
 * Recheck mutable person grants after the tenant mutation lock, within its
 * transaction. A role removed while the command was waiting must not be
 * resurrected by the already-resolved HTTP session. Verified issuer grants
 * are kept separate from mutable organization grants.
 */
export async function assertCurrentAccountAuthority(
  db: OpenShapeForgeDatabase,
  tx: Transaction<DB>,
  session: TrustedSessionContext & { tenantId: string; userId: string },
  requiredRole: string,
): Promise<void> {
  if (session.credential === 'bearer' && session.principalKind === 'service') return; // Verified service token.
  if (session.credential === 'api-key') return; // Verified, intersected service credential.
  if (session.credential !== 'bearer' && session.credential !== 'trusted-context') {
    throw new HttpError(403, 'FORBIDDEN', 'Organization account permission required.');
  }
  if (!session.issuer) {
    throw new HttpError(403, 'FORBIDDEN', 'Linked organization membership required.');
  }
  const actor = (await sql<{ roles: string[] }>`select ir.roles from platform.identity_relations ir
    join platform.identities i on i.id=ir.identity_id
    where ir.tenant_id=${session.tenantId}::uuid and i.issuer=${session.issuer}
      and i.subject=${session.userId} and ir.status='linked' and not ir.access_blocked
    for share of ir`.execute(tx)).rows[0];
  if (!actor) throw new HttpError(403, 'FORBIDDEN', 'Linked organization membership required.');
  const groupIds = await resolveRelationGroupMembershipIds(db, session,
    { issuer: session.issuer, subject: session.userId });
  const groupRoles = await resolveGroupRoles(db, session, groupIds);
  const assigned = [...actor.roles, ...groupRoles];
  // Trusted-context carries an already-flattened tenant role snapshot, not a
  // separately verifiable issuer grant. Recompute its mutable authority from
  // current membership; only bearer issuerRoles have distinct provenance.
  const expanded = personSessionRoles({ roles: session.credential === 'bearer'
    ? [...(session.issuerRoles ?? [])] : [] },
    { roles: assigned, needsRoleAssignment: false }, realmFromIssuer(session.issuer));
  const custom = await resolveCustomRolePermissions(db, session, assigned);
  if (![...expanded, ...custom].includes(requiredRole)) {
    throw new HttpError(403, 'FORBIDDEN', 'Organization account permission was withdrawn.');
  }
}
