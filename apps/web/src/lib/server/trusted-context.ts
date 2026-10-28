// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import {
  applyTrustedContextHeaders as applyTrustedContextHeadersCore,
  type TrustedPrincipalKind,
} from "@openshapeforge/auth";

type TrustedContextSession = {
  tenantId?: string | null;
  sub?: string | null;
  roles?: readonly string[] | null;
  /**
   * Keycloak group paths from the access token. Forwarded so the API can
   * authorize on group membership at the route/GraphQL boundary.
   */
  groups?: readonly string[] | null;
  /**
   * The OIDC id token of the login this session was established by. Read for
   * one thing only — see {@link principalKindOf} — and never forwarded.
   */
  idToken?: string | null;
};

function internalContextSecret() {
  return process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;
}

/**
 * What this tier can HONESTLY say about the principal behind a bundle.
 *
 * The API refuses some surfaces to anything it cannot show to be a human (API
 * key management is the one today), and the bundle's principal class is how
 * that verdict crosses the hop. Asserting it is therefore a claim about how
 * this tier authenticated, not a label it may attach for convenience.
 *
 * "person" is asserted on exactly one property: the session carries the id
 * token of an OIDC authorization-code login. That artifact is minted for an
 * authenticated end user and never by a client-credentials grant, so a
 * machine principal cannot produce a session that satisfies it. Anything
 * else — a session without one, a server-side probe, any token-less internal
 * call — asserts NOTHING, and the API reads that as a principal it may not
 * treat as human.
 */
function principalKindOf(session: TrustedContextSession): TrustedPrincipalKind | undefined {
  return session.idToken && session.sub ? "person" : undefined;
}

export function applyTrustedContextHeaders(
  headers: Headers,
  session: TrustedContextSession,
) {
  const principalKind = principalKindOf(session);
  applyTrustedContextHeadersCore(
    headers,
    {
      tenantId: session.tenantId ?? null,
      userId: session.sub ?? null,
      roles: [...(session.roles ?? [])],
      groups: [...(session.groups ?? [])],
      ...(principalKind ? { principalKind } : {}),
    },
    { secret: internalContextSecret() },
  );
}
