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
 * And one rule that is not about roles at all: an API key session may never
 * reach this surface. A credential that can mint credentials is a ladder — the
 * holder grants itself the union of what any reachable key may hold, one rung
 * at a time. Key management is for interactive, human-authenticated sessions.
 */

/**
 * Role required to manage API keys. Authored in the realm like any other role,
 * and — being a `Platform.*` role — it is not one an entity grant can confer,
 * so an external party cannot acquire it through ordinary business access.
 */
export const API_KEY_MANAGE_ROLE = "Platform.ApiKeys.Manage";

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
  credential: "none" | "bearer" | "api-key" | "trusted-context";
};

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
  if (session.credential === "api-key") {
    throw new ApiKeyAuthorizationError(
      "API keys cannot manage API keys. Use an interactive session.",
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
 * Gate a mutation that grants no roles (revoke, disable, rename).
 *
 * Still refuses an API key session, and still requires the management role —
 * revocation is a denial-of-service lever if anyone authenticated can reach it.
 */
export function assertMayManageApiKeys(session: CeilingSession): void {
  assertMayGrantRoles(session, []);
}
