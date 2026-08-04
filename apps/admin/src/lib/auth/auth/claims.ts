// SPDX-License-Identifier: BUSL-1.1
import {
  parseClientRoles,
  parseRoles,
  readJwtClaims,
} from "@openshapeforge/auth";
import type { StoredSession } from "../redis";

export type JwtClaims = Record<string, unknown>;

/**
 * The one role that means "may use the control plane".
 *
 * Authored in `packages/compiler/config/authoring/authorization.control.yaml`
 * as the control realm's only realm role. It carries no composites: the
 * authority to actually change anything lives on the far side of a server-side
 * call, not in this token. Holding it is permission to open the console.
 */
export const PLATFORM_OPERATOR_ROLE = "platform-operator";

/**
 * Realm roles plus every client role, flattened into one list.
 *
 * Same rationale as apps/web: no client-id allowlist, because the enforcement
 * that matters happens server-side and filtering here could only ever hide a
 * role the callee will honour anyway.
 */
export function parseAuthorizationRoles(claims: JwtClaims | undefined): string[] {
  return [
    ...new Set([
      ...parseRoles(claims),
      ...Object.values(parseClientRoles(claims)).flat(),
    ]),
  ];
}

type StoredUserProfile = Pick<
  StoredSession,
  "name" | "givenName" | "familyName" | "preferredUsername" | "email"
>;

/**
 * The authorization decision, in one place.
 *
 * apps/web's equivalent (`hasApplicationRealmRole`) tests membership of a SET of
 * business roles. Here it is a single role, and the difference is deliberate:
 * the control plane has exactly one kind of user. When S5/S6 add finer
 * distinctions they extend this function, not each call site.
 */
export function hasPlatformOperatorRole(roles: readonly string[]): boolean {
  return roles.includes(PLATFORM_OPERATOR_ROLE);
}

export function resolveInitialRoles(
  accessTokenClaims: JwtClaims | undefined,
  idTokenClaims: JwtClaims | undefined,
  profile: JwtClaims | undefined,
): string[] {
  return [...new Set([
    ...parseAuthorizationRoles(accessTokenClaims),
    ...parseAuthorizationRoles(idTokenClaims),
    ...parseAuthorizationRoles(profile),
  ])];
}

/**
 * True when the token actually carries role state, as opposed to simply having
 * no roles. The distinction matters on refresh: "Keycloak returned a token with
 * no `realm_access`" is a malformed response, while "`realm_access.roles` is
 * empty" is a revoked operator. Only the first should be treated as a
 * transport-level failure.
 */
export function claimsIncludeRoleState(claims: JwtClaims | undefined): boolean {
  return Boolean(claims && ("realm_access" in claims || "resource_access" in claims));
}

/*
 * DELIBERATELY NOT PORTED from apps/web's claims.ts:
 *
 *   resolveInitialTenantId   — control-realm tokens carry no `tid`.
 *   resolveInitialActorType  — derived from the tenant context; there is none.
 *   resolveInitialGroups /
 *   resolveRefreshedGroups   — the control realm authors no groups, and the
 *                              authored-dev group FALLBACK in apps/web is keyed
 *                              on the tenant realm's issuer, so it could only
 *                              ever fabricate group paths that mean nothing
 *                              here.
 *
 * These are named rather than silently absent because "the port forgot them"
 * and "the port refused them" look identical in a diff otherwise.
 */

export function decodeJwtExp(token: string | undefined): number | undefined {
  const payload = readJwtClaims(token) as { exp?: unknown } | undefined;
  return typeof payload?.exp === "number" ? payload.exp : undefined;
}

export function mergeUserProfileIntoStoredSession(
  stored: StoredSession,
  profile: StoredUserProfile,
): StoredSession {
  return {
    ...stored,
    name: profile.name,
    givenName: profile.givenName,
    familyName: profile.familyName,
    preferredUsername: profile.preferredUsername,
    email: profile.email,
  };
}
