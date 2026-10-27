// SPDX-License-Identifier: BUSL-1.1
/**
 * The privilege ceiling: nobody may grant what they do not hold.
 *
 * This is the security control of the provisioning surface, and it exists as
 * ONE function on purpose. The canonical failure of this feature across the
 * industry is not a missing check — it is a check present on `create` and
 * absent on `update`, which lets a low-privilege credential edit itself upward
 * (Immich GHSA-237r-x578-h5mv). Every mutation path calls this; there is no
 * second implementation to drift.
 *
 * Two rules, both enforced here:
 *
 *   1. The caller must hold the management role.
 *   2. Every role being granted must already be held by the caller.
 *
 * And one rule that is not about roles at all: only a session this deployment
 * can show to be a PERSON, or its own in-mesh hop carrying one, may reach this
 * surface. A credential that can mint credentials is a ladder — the holder
 * grants itself the union of what any reachable key may hold, one rung at a
 * time — and that ladder is not specific to API keys: any non-human principal
 * holding the management role climbs it the same way. So the carrier is
 * checked, fail-closed, before any role is.
 */

/**
 * Role required to manage API keys. Authored in the realm like any other role,
 * and — being a `Platform.*` role — it is not one an entity grant can confer,
 * so an external party cannot acquire it through ordinary business access.
 */
export const API_KEY_MANAGE_ROLE = "Platform.ApiKeys.Manage";

import type { SessionCredential } from "../trusted-context.js";

export class ApiKeyAuthorizationError extends Error {
  readonly code = "FORBIDDEN";
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyAuthorizationError";
  }
}

export type CeilingSession = {
  roles: readonly string[];
  credential: SessionCredential;
  /**
   * The bearer path's own verdict about the principal behind the token
   * (`auth/bearer-session.ts`): "person" for a verified human identity linked
   * to a Relation, "service" for a Keycloak service account, and ABSENT for a
   * token that is neither — an unknown principal. Never client input: it is
   * derived from the verified claims, so it cannot be asserted by a caller.
   */
  principalKind?: "person" | "service";
};

/**
 * Which carriers may manage credentials at all, decided before any role.
 *
 * `bearer` is admitted only on the bearer path's own "person" verdict. That
 * single condition closes three doors at once: a Keycloak service account
 * holding `Platform.ApiKeys.Manage` (`principalKind: "service"`), a verified
 * token that is neither person nor service account (`principalKind` absent —
 * an unknown principal, refused because absence proves nothing), and any
 * future carrier added to `SessionCredential` without a decision here.
 *
 * `trusted-context` is the deployment's OWN in-mesh hop: HMAC-signed with
 * `OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET` inside a ±5-minute window, so it
 * cannot be minted by a caller, and it is what apps/web uses when it holds no
 * forwardable access token. It remains admitted, and that is a deliberate
 * limit of this control rather than a hole it closes: the bundle carries no
 * principal kind, so a compromised web tier could assert a human it never
 * authenticated. Narrowing that needs the carrier to propagate the verdict
 * (packages/auth owns the payload); it is reported, not worked around here.
 *
 * Everything else is refused outright: `api-key` (the ladder), `control-bearer`
 * (a platform operator is not a tenant session), `grant` (a capability token
 * covers the Operations it names, and this is not one of them) and `none`.
 */
function mayCarryKeyManagement(session: CeilingSession): boolean {
  switch (session.credential) {
    case "bearer":
      return session.principalKind === "person";
    case "trusted-context":
      return true;
    default:
      return false;
  }
}

/**
 * Gate every API key mutation. Throws `ApiKeyAuthorizationError` — never
 * returns a boolean, so a caller cannot forget to branch on it.
 *
 * `requestedRoles` is the set being granted to a key or integration. Pass the
 * FULL resulting set on an update, not the delta: a check over the delta alone
 * would let a caller keep roles it has since lost.
 */
export function assertMayGrantRoles(
  session: CeilingSession,
  requestedRoles: readonly string[],
): void {
  // The carrier first, and with its own message: a service principal that
  // holds every role must not learn that roles were even consulted.
  if (!mayCarryKeyManagement(session)) {
    throw new ApiKeyAuthorizationError(
      session.credential === "api-key"
        ? "API keys cannot manage API keys. Use an interactive session."
        : "Only a verified person may manage API keys. Use an interactive session.",
    );
  }

  const held = new Set(session.roles);
  if (!held.has(API_KEY_MANAGE_ROLE)) {
    throw new ApiKeyAuthorizationError("Not authorized to manage API keys.");
  }

  // Sorted for a deterministic message; the caller already knows which roles it
  // asked for, so naming them back discloses nothing it did not supply. What is
  // never named is the caller's own role set.
  const ungranted = [...new Set(requestedRoles)].filter((role) => !held.has(role)).sort();
  if (ungranted.length > 0) {
    throw new ApiKeyAuthorizationError(
      `Cannot grant roles you do not hold: ${ungranted.join(", ")}.`,
    );
  }
}

/**
 * Gate a mutation that grants no roles (revoke, disable, rename) and every
 * management READ.
 *
 * Still applies the carrier rule, and still requires the management role —
 * revocation is a denial-of-service lever if anyone authenticated can reach
 * it, and the integration catalog names the external parties a tenant works
 * with.
 */
export function assertMayManageApiKeys(session: CeilingSession): void {
  assertMayGrantRoles(session, []);
}
