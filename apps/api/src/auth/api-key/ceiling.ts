// SPDX-License-Identifier: BUSL-1.1
/**
 * The privilege ceiling: nobody may grant what they do not hold.
 *
 * Integration operations require the management role. Creating an integration
 * and its first key also accepts the integration creation role. Creation and
 * later role changes share the same held-role check.
 *
 * And one rule that is not about roles at all: only a session this deployment
 * can show to be a PERSON may reach this surface — whichever carrier brought
 * it. A credential that can mint credentials is a ladder — the holder grants
 * itself the union of what any reachable key may hold, one rung at a time —
 * and that ladder is not specific to API keys: any non-human principal
 * holding the management role climbs it the same way. So the carrier is
 * checked, fail-closed, before any role is.
 */

/**
 * Role required to manage API keys. Authored in the realm like any other role,
 * and — being a `Platform.*` role — it is not one an entity grant can confer,
 * so an external party cannot acquire it through ordinary business access.
 */
export const API_KEY_MANAGE_ROLE = "Platform.ApiKeys.Manage";
export const INTEGRATION_KEY_CREATE_ROLE = "Platform.ApiKeys.IntegrationCreate";

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
   * The SERVER's verdict about the principal behind the session: "person" for
   * a verified human, "service" for a machine principal, and ABSENT when the
   * deployment established neither. Never client input — on the bearer path
   * it is derived from the verified claims (`auth/bearer-session.ts`), and on
   * the trusted-context path it is inside the bundle's HMAC (packages/auth,
   * payload v3), so a caller can assert it on neither.
   */
  principalKind?: "person" | "service";
};

/**
 * Which carriers may manage credentials at all, decided before any role.
 *
 * Two carriers, one condition: the deployment must have CLASSIFIED the
 * principal as a person. That single condition closes four doors at once — a
 * Keycloak service account holding `Platform.ApiKeys.Manage`
 * (`principalKind: "service"`), a verified token that is neither person nor
 * service account (`principalKind` absent, refused because absence proves
 * nothing), an in-mesh hop that forwards an identity it never authenticated
 * (also absent), and any future carrier added to `SessionCredential` without
 * a decision here.
 *
 * `bearer` carries the verdict the bearer path derived from verified claims.
 *
 * `trusted-context` is the deployment's OWN in-mesh hop: HMAC-signed with
 * `OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET` inside a ±5-minute window, and
 * since payload v3 the signer's verdict travels INSIDE that signature. A
 * producer still signing the older payload v2 therefore reaches this surface
 * NEVER: its bundle is accepted for ordinary work (packages/auth,
 * ACCEPTED_PAYLOAD_VERSIONS) but carries no class, and absence is refused
 * here. Redeploying that producer is what admits it, not relaxing this. It is
 * what apps/web sends when it holds no forwardable access token, and apps/web
 * signs "person" only for a session it established through an interactive
 * login (it holds that login's id token). Every other producer of a bundle —
 * a health probe, a fixture, a service-to-service hop — signs no class and is
 * refused here, so holding the mesh secret is no longer enough to reach this
 * surface. A web tier compromised outright can still sign what it likes; that
 * is the trust this secret already expresses, and it is now the ONLY way a
 * bundle reaches a person verdict rather than a property of the carrier.
 *
 * Everything else is refused outright: `api-key` (the ladder), `control-bearer`
 * (a platform operator is not a tenant session), `grant` (a capability token
 * covers the Operations it names, and this is not one of them) and `none`.
 */
function mayCarryKeyManagement(session: CeilingSession): boolean {
  switch (session.credential) {
    case "bearer":
    case "trusted-context":
      return session.principalKind === "person";
    default:
      return false;
  }
}

/**
 * The carrier rule above, for another surface that delegates authority to a
 * machine identity and therefore has the same ladder: registering an inbound
 * provider endpoint (`modules/inbound-endpoints.ts`) says "these bytes make the
 * organization's service identity run that Operation". Exported rather than
 * re-derived, so the next surface with this hazard inherits the decision
 * instead of writing a third version of it that drifts.
 *
 * Returns a boolean because the caller composes it with its own capability
 * check and owns the message; it is never the whole gate on its own.
 */
export function isVerifiedPersonSession(session: CeilingSession): boolean {
  return mayCarryKeyManagement(session);
}

/**
 * Gate an integration management operation that grants or changes roles.
 *
 * `requestedRoles` is the set being granted to a key or integration. Pass the
 * FULL resulting set on an update, not the delta: a check over the delta alone
 * would let a caller keep roles it has since lost.
 */
export function assertMayGrantRoles(
  session: CeilingSession,
  requestedRoles: readonly string[],
): void {
  assertMayManageApiKeys(session);
  assertHeldIntegrationRoles(session, requestedRoles);
}

/** Create a new integration and its first credential. */
export function assertMayCreateIntegration(
  session: CeilingSession,
  requestedRoles: readonly string[] = [],
): void {
  assertKeyManagementCarrier(session);
  if (!session.roles.includes(API_KEY_MANAGE_ROLE) && !session.roles.includes(INTEGRATION_KEY_CREATE_ROLE)) {
    throw new ApiKeyAuthorizationError("Not authorized to create API key integrations.");
  }
  assertHeldIntegrationRoles(session, requestedRoles);
}

function assertHeldIntegrationRoles(session: CeilingSession, requestedRoles: readonly string[]): void {
  const held = new Set(session.roles);
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
  assertKeyManagementCarrier(session);
  if (!session.roles.includes(API_KEY_MANAGE_ROLE)) {
    throw new ApiKeyAuthorizationError("Not authorized to manage API keys.");
  }
}

/** The carrier rule, with the message that names why it refused. */
function assertKeyManagementCarrier(session: CeilingSession): void {
  if (mayCarryKeyManagement(session)) return;
  throw new ApiKeyAuthorizationError(
    session.credential === "api-key" || session.credential === "personal-key"
      ? "API keys cannot manage API keys. Use an interactive session."
      : "Only a verified person may manage API keys. Use an interactive session.",
  );
}

// ---------------------------------------------------------------------------
// Personal keys
//
// Personal rights distinguish creation, managing your own keys, and
// organization-wide read and revoke permissions. An administrator who may see every key need not be one who may
// cut a colleague off, and neither right lets anyone mint a key for somebody
// else — there is no Operation for that at all.
//
// Every one of them sits behind the carrier rule above: a personal key is a
// credential, and a credential that can mint credentials is the ladder that
// rule exists to break.

/** Hold, list and revoke your own personal keys. */
export const PERSONAL_KEY_ROLE = "Platform.ApiKeys.Personal";
export const PERSONAL_KEY_CREATE_ROLE = "Platform.ApiKeys.PersonalCreate";
/** See every person's personal keys in the organization — metadata only. */
export const PERSONAL_KEY_READ_ROLE = "Platform.ApiKeys.PersonalRead";
/** Revoke any person's personal key in the organization. */
export const PERSONAL_KEY_REVOKE_ROLE = "Platform.ApiKeys.PersonalRevoke";

/** Gate reading or revoking one's own keys. */
export function assertMayHoldPersonalKeys(session: CeilingSession): void {
  assertKeyManagementCarrier(session);
  if (!session.roles.includes(PERSONAL_KEY_ROLE)) {
    throw new ApiKeyAuthorizationError("Not authorized to hold personal API keys.");
  }
}

/** A personal key may narrow its owner's live permissions to roles they already hold. */
export function assertMayCreatePersonalKey(session: CeilingSession, requestedRoles: readonly string[]): void {
  assertKeyManagementCarrier(session);
  const held = new Set(session.roles);
  if (!held.has(PERSONAL_KEY_ROLE) && !held.has(PERSONAL_KEY_CREATE_ROLE)) {
    throw new ApiKeyAuthorizationError("Not authorized to create personal API keys.");
  }
  const ungranted = [...new Set(requestedRoles)].filter((role) => !held.has(role)).sort();
  if (ungranted.length > 0) {
    throw new ApiKeyAuthorizationError(
      `Cannot narrow a key to roles you do not hold: ${ungranted.join(", ")}.`,
    );
  }
}

/** Gate the organization-wide overview of personal keys. */
export function assertMayReadPersonalKeys(session: CeilingSession): void {
  assertKeyManagementCarrier(session);
  if (!session.roles.includes(PERSONAL_KEY_READ_ROLE)) {
    throw new ApiKeyAuthorizationError("Not authorized to view other people's API keys.");
  }
}

/** Gate revoking another person's personal key. */
export function assertMayRevokePersonalKeys(session: CeilingSession): void {
  assertKeyManagementCarrier(session);
  if (!session.roles.includes(PERSONAL_KEY_REVOKE_ROLE)) {
    throw new ApiKeyAuthorizationError("Not authorized to revoke other people's API keys.");
  }
}
