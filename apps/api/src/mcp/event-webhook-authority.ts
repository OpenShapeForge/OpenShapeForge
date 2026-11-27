// SPDX-License-Identifier: BUSL-1.1
import { realmFromIssuer } from "@openshapeforge/auth";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import { personOrganizationAuthority } from "../auth/bearer-session.js";
import { resolveAuthorizationProfileAccess } from "../auth/authorization-profile-session.js";
import { readLinkRowByIdentity, toState } from "../auth/identity-link-store.js";
import { assertMemberAccessActive } from "../auth/member-access-state.js";
import { personalKeyOwnerLookup } from "../auth/session-resolver.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";

export type EventWebhookPrincipal = Readonly<{
  tenantId: string;
  userId: string;
  issuer: string;
  clientId: string;
}>;

/** Subscribe under a verified human OAuth session. Never persist its bearer or effective roles. */
export function eventWebhookPrincipal(session: TrustedSessionContext): EventWebhookPrincipal | undefined {
  if (session.credential !== "bearer" || session.principalKind !== "person" || !session.relation?.relationId ||
      session.relation.status !== "linked" || !session.tenantId || !session.userId || !session.issuer || !session.oauthClientId) return;
  return { tenantId: session.tenantId, userId: session.userId, issuer: session.issuer, clientId: session.oauthClientId };
}

/** Re-evaluate the subscriber's organization authority every time delivery is attempted. */
export async function resolveEventWebhookAuthority(db: OpenShapeForgeDatabase, principal: EventWebhookPrincipal):
  Promise<TrustedSessionContext | undefined> {
  const ownerLookup = personalKeyOwnerLookup();
  const realm = realmFromIssuer(principal.issuer);
  if (!ownerLookup || !realm || realm !== process.env.OPENSHAPEFORGE_KEYCLOAK_REALM?.trim()
      || principal.issuer !== process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER?.trim()) return;
  const account = await ownerLookup(principal.userId);
  if (!account?.enabled) return;
  const identity = { issuer: principal.issuer, subject: principal.userId };
  const membership: TrustedSessionContext = {
    tenantId: principal.tenantId, userId: principal.userId, issuer: principal.issuer,
    oauthClientId: principal.clientId, credential: "bearer", principalKind: "person",
    roles: [], groups: account.groups, relationGroupIds: [], scope: "self",
  };
  await assertMemberAccessActive(db, membership);
  const relation = await withDbSession(db, membership, async trx => {
    const row = await readLinkRowByIdentity(trx, identity, principal.tenantId);
    return row ? toState(row, identity) : null;
  });
  if (relation?.status !== "linked" || !relation.relationId) return;
  const authority = await personOrganizationAuthority(db, {
    tenantId: principal.tenantId, userId: principal.userId, groups: account.groups, issuerRoles: [], identity,
  }, relation, realm);
  return resolveAuthorizationProfileAccess({ ...membership, ...authority, relation }, db);
}
