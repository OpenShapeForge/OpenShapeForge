// SPDX-License-Identifier: BUSL-1.1
import type { ActingRelationSource } from '../db/acting-relation.js';
import { connectionScopeOf } from './catalog-rows.js';
import { requireActingRelationId } from './acting-relation-guard.js';

/**
 * Manual OAuth configuration registers the organisation's client, even when
 * the provider later issues tokens per person. Token ownership is assigned by
 * the OAuth callback, never inferred from who registers that shared client.
 * Other personal credentials still belong to the verified acting Relation.
 * Call only for a connection table that declares ownerUserId.
 */
export function configurationOwnerPatch(
  auth: Record<string, unknown> | null | undefined,
  session: ActingRelationSource,
): { ownerUserId?: string | null } {
  if (auth?.profile === 'oauth2AuthorizationCode') return { ownerUserId: null };
  if (connectionScopeOf(auth) === 'user') {
    return { ownerUserId: requireActingRelationId(session, 'A personal connection') };
  }
  return {};
}
