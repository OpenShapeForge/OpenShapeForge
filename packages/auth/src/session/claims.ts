// SPDX-License-Identifier: BUSL-1.1
import { parseClientRoles, parseRoles, readJwtClaims } from "../claims.js";
import type { StoredSession } from "./store.js";

export type JwtClaims = Record<string, unknown>;

/**
 * Realm roles plus every client role, flattened into one list.
 *
 * No client-id allowlist: `apps/api` flattens all client roles when it builds
 * the identity it authorizes against, so filtering here could only ever hide a
 * role the API will honour anyway — making the nav claim less access than the
 * user has. Enforcement stays server-side; this list drives nav filtering.
 */
export function parseAuthorizationRoles(claims: JwtClaims | undefined): string[] {
  return [
    ...new Set([
      ...parseRoles(claims),
      ...Object.values(parseClientRoles(claims)).flat(),
    ]),
  ];
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
 * empty" is a revoked user. Only the first is a transport-level failure.
 */
export function claimsIncludeRoleState(claims: JwtClaims | undefined): boolean {
  return Boolean(claims && ("realm_access" in claims || "resource_access" in claims));
}

export function decodeJwtExp(token: string | undefined): number | undefined {
  const payload = readJwtClaims(token) as { exp?: unknown } | undefined;
  return typeof payload?.exp === "number" ? payload.exp : undefined;
}

export type StoredUserProfile = Pick<
  StoredSession,
  "name" | "givenName" | "familyName" | "preferredUsername" | "email"
>;

export function mergeUserProfileIntoStoredSession<Extra extends object>(
  stored: StoredSession<Extra>,
  profile: StoredUserProfile,
): StoredSession<Extra> {
  return {
    ...stored,
    name: profile.name,
    givenName: profile.givenName,
    familyName: profile.familyName,
    preferredUsername: profile.preferredUsername,
    email: profile.email,
  };
}
