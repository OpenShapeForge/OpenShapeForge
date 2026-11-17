// SPDX-License-Identifier: BUSL-1.1
/**
 * The personal-key branch of session resolution: a key a person minted for
 * themselves, acting AS that person.
 *
 *   parse (checksum, no I/O)
 *     → resolve (indexed lookup + constant-time secret compare, expiry,
 *                revocation, dormancy)                       personal-store.ts
 *       → the realm: does the owner's account still exist and may it sign in?
 *         → the membership: is the owner still a linked member of this tenant?
 *           → the person's authority there, computed exactly as for a login
 *             (bearer-session.ts, personOrganizationAuthority)
 *             → intersect with the key's narrowing (never widen)
 *
 * Every step reads the CURRENT state. Nothing the key row says about roles is
 * trusted beyond narrowing: withdraw a role from the person and their keys
 * lose it on the next request; disable their account or block their
 * membership and every key they hold stops working, with nothing to revoke.
 *
 * What a personal key does NOT carry are the owner's issuer-wide realm roles
 * (`Platform.*` granted on the realm user itself). Those are grants to the
 * person across every organization of the issuer; a key is minted in, and
 * bound to, one organization. The organization roles on the membership row —
 * which is where an organization administrator's rights come from — are all
 * there.
 *
 * Every failure is undefined, which the caller turns into the same empty
 * session as any other refused credential: a holder cannot tell an unknown
 * key from a revoked one from one whose owner left. The one exception is an
 * unreachable realm, which is the deployment being unable to decide (503),
 * not a refusal.
 */
import { assertKeyUsableHere, type KeyRequestContext } from "./restrictions.js";
import { realmFromIssuer } from "@openshapeforge/auth";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession } from "../../db/session.js";
import { personOrganizationAuthority } from "../bearer-session.js";
import { readLinkRowByIdentity, toState } from "../identity-link-store.js";
import type { IdentityLinkState } from "../identity-link.js";
import { resolveScope } from "../session-scope.js";
import { SessionAuthenticationUnavailableError } from "../session-unavailable.js";
import type { TrustedSessionContext } from "../trusted-context.js";
import { parsePersonalApiKey } from "./format.js";
import { intersectRoles } from "./resolve.js";
import { recordPersonalApiKeyUse, resolvePersonalApiKey } from "./personal-store.js";

/** The realm's current view of the owner, or null when the account is gone. */
export type OwnerAccount = { enabled: boolean; groups: string[] };

export type PersonalKeyResolverDeps = {
  db: OpenShapeForgeDatabase;
  /** The issuer this deployment verifies; a key minted under another is refused. */
  issuer: string;
  /** Throws when the realm cannot be asked; see {@link cachedOwnerAccount}. */
  ownerAccount: (userId: string) => Promise<OwnerAccount | null>;
};

export async function resolvePersonalKeySession(
  deps: PersonalKeyResolverDeps,
  candidate: string,
  request: KeyRequestContext = { clientAddress: null, origin: null },
): Promise<TrustedSessionContext | undefined> {
  const parsed = parsePersonalApiKey(candidate);
  if (!parsed) return undefined;

  const resolved = await resolvePersonalApiKey(deps.db, parsed.lookupId, parsed.secret);
  if (!resolved.ok) return undefined;
  const key = resolved.key;

  // Network allowlist, and never from a browser (restrictions.ts). Before the
  // realm read, so a refused address costs the identity provider nothing.
  assertKeyUsableHere({ allowedIps: key.allowedIps, allowedOrigins: [] }, request, "personal");

  // A key belongs to the identity (issuer, subject) that minted it. Under a
  // different issuer the same subject is somebody else.
  if (key.ownerIssuer !== deps.issuer) return undefined;

  let account: OwnerAccount | null;
  try {
    account = await deps.ownerAccount(key.ownerUserId);
  } catch (error) {
    console.warn(
      "[auth] Personal API key owner could not be read from the realm:",
      error instanceof Error ? error.message : String(error),
    );
    throw new SessionAuthenticationUnavailableError(
      "Personal API keys cannot be verified: the identity provider is unavailable.",
    );
  }
  if (!account || !account.enabled) return undefined;

  const identity = { issuer: key.ownerIssuer, subject: key.ownerUserId };
  // Read fresh on every request, under the owner's own session (the identity
  // policies admit reading one's own link). Not cached: this row is what
  // says whether the person still belongs here and what they may do.
  let relation: IdentityLinkState | null;
  try {
    relation = await withDbSession(deps.db, {
      tenantId: key.tenantId,
      userId: key.ownerUserId,
      roles: [],
      groups: account.groups,
      scope: "self",
    }, async (trx) => {
      const row = await readLinkRowByIdentity(trx, identity, key.tenantId);
      return row ? toState(row, identity) : null;
    });
  } catch (error) {
    console.warn(
      "[auth] Personal API key membership could not be read:",
      error instanceof Error ? error.message : String(error),
    );
    throw new SessionAuthenticationUnavailableError("The current organization membership could not be verified; try again.");
  }
  if (!relation || relation.status !== "linked" || !relation.relationId) return undefined;

  const authority = await personOrganizationAuthority(deps.db, {
    tenantId: key.tenantId,
    userId: key.ownerUserId,
    groups: account.groups,
    issuerRoles: [],
    identity,
  }, relation, realmFromIssuer(key.ownerIssuer));
  const roles = intersectRoles(authority.roles, key.roleSubset).sort();

  void recordPersonalApiKeyUse(deps.db, { keyId: key.keyId, tenantId: key.tenantId }).catch((error: unknown) => {
    console.warn(
      "[auth] Recording personal API key use failed:",
      error instanceof Error ? error.message : String(error),
    );
  });

  return {
    tenantId: key.tenantId,
    userId: key.ownerUserId,
    issuer: key.ownerIssuer,
    userDisplayName: relation.displayName,
    roles,
    // The person acts: audit, row ownership and named-person record actions
    // all see them. The CREDENTIAL says it was a key, and that is what every
    // control which needs a person to be present right now (key management,
    // delegation) refuses on.
    principalKind: "person",
    oauthScopes: [],
    groups: account.groups,
    relationGroupIds: authority.relationGroupIds,
    scope: resolveScope(roles, account.groups),
    credential: "personal-key",
    personalKeyId: key.keyId,
    relation,
  };
}

/**
 * The owner lookup, cached briefly per process so a busy key does not cost a
 * realm round trip per request. Thirty seconds bounds how long a disabled
 * account's keys keep working on a replica that just asked; a blocked
 * MEMBERSHIP is read uncached above and takes effect on the next request.
 */
const ACCOUNT_CACHE_MS = 30_000;
const accountCache = new Map<string, { value: OwnerAccount | null; expiresAtMs: number }>();

export function cachedOwnerAccount(
  read: (userId: string) => Promise<OwnerAccount | null>,
): (userId: string) => Promise<OwnerAccount | null> {
  return async (userId) => {
    const now = Date.now();
    const hit = accountCache.get(userId);
    if (hit && hit.expiresAtMs > now) return hit.value;
    const value = await read(userId);
    accountCache.set(userId, { value, expiresAtMs: now + ACCOUNT_CACHE_MS });
    if (accountCache.size > 10_000) accountCache.delete(accountCache.keys().next().value!);
    return value;
  };
}

/** Test-only. */
export function __resetPersonalKeyAccountCacheForTests(): void {
  accountCache.clear();
}
