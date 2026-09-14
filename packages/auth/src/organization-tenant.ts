// SPDX-License-Identifier: BUSL-1.1
/**
 * Turning "which Keycloak Organization does this token act for" into the input
 * of one registry read — the pure half of the organization → tenant path.
 *
 * Two very different bundles need this answer: the runtime's own session
 * resolver (`apps/api/src/auth/identity.ts`) and Hubble's plugin runtime, which
 * is bundled separately and cannot import that resolver (measured: importing it
 * pulls 411 extra modules, Kysely and the bearer verifier among them, into a
 * bundle of 744). What they share is not the read — one speaks Kysely, the
 * other postgres.js — but the selection, the realm and the cache key. Those are
 * pure functions over claims, which is what this package is for, so they live
 * here once and both sides import them.
 *
 * The registry read itself (`app.tenant_for_keycloak_organization`) and the
 * cache instance stay with each caller: they are I/O and process state, which
 * this package deliberately does not hold.
 */
import type { OrganizationAccess } from "./types.js";

/**
 * How long one (realm, organization) → tenant answer stays good. The link
 * changes only through the control plane, and a browser app asks on every page
 * load.
 */
export const ORGANIZATION_TENANT_CACHE_TTL_MS = 60_000;

/** `https://kc.example/realms/<realm>` → `<realm>`. Undefined for any other shape. */
export function realmFromIssuer(issuer: unknown): string | undefined {
  if (typeof issuer !== "string") return undefined;
  const match = /\/realms\/([^/?#]+)\/?$/.exec(issuer.trim());
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * The single Organization membership a token may act for, or null.
 *
 * Exactly one membership carrying an id is the normal case. A user in several
 * Organizations must have selected one — Keycloak does that when the client
 * requests the `organization:<alias>` scope, and echoes the choice in `scope`
 * — otherwise there is no honest way to pick, and guessing would let a
 * multi-tenant user land in whichever tenant sorted first.
 */
export function selectOrganizationMembership(identity: {
  organizations?: Record<string, Pick<OrganizationAccess, "id">> | undefined;
  scopes?: readonly string[] | undefined;
}): { alias: string; id: string } | null {
  const memberships: Array<{ alias: string; id: string }> = [];
  for (const [alias, membership] of Object.entries(identity.organizations ?? {})) {
    if (typeof membership.id === "string" && membership.id.length > 0) {
      memberships.push({ alias, id: membership.id });
    }
  }
  if (memberships.length === 0) return null;
  if (memberships.length === 1) return memberships[0]!;

  const selected = (identity.scopes ?? [])
    .filter((scope) => scope.startsWith("organization:") && scope !== "organization:*")
    .map((scope) => scope.slice("organization:".length));
  const chosen = memberships.filter((membership) => selected.includes(membership.alias));
  return chosen.length === 1 ? chosen[0]! : null;
}

/**
 * The cache key for one (realm, organization id) pair.
 *
 * Both halves are text this process does not control. `realm` is a decoded
 * path segment of `iss` (realmFromIssuer percent-decodes it), so no character
 * can be ruled out of it, and the organization id is a token claim. A plain
 * separator is therefore not provably absent from either half — which is why
 * this key used to be joined on a literal NUL. That made the one file about
 * identity and authorization binary: `file` called it data and `grep` answered
 * "binary file matches" instead of showing the line.
 *
 * Length-prefixing the first half keeps the key unambiguous while staying
 * text. The digits before the first ":" say how long the realm is, so the key
 * parses back to exactly one pair: ("a:b", "c") yields "3:a:b:c" and
 * ("a", "b:c") yields "1:a:b:c" — the two pairs that collide under any plain
 * separator stay apart here.
 */
export function organizationTenantCacheKey(realm: string, organizationId: string): string {
  return `${realm.length}:${realm}:${organizationId}`;
}
