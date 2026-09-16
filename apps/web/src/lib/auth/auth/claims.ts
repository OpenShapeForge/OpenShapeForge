// SPDX-License-Identifier: BUSL-1.1
import {
  parseClientRoles,
  parseGroups,
  parseRoles,
  parseTenantContext,
  readJwtClaims,
} from "@openshapeforge/auth";
import type { StoredSession } from "../redis";
import { issuer } from "./keycloak";

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

type StoredUserProfile = Pick<
  StoredSession,
  "name" | "givenName" | "familyName" | "preferredUsername" | "email"
>;

const applicationRealmRoles = new Set([
  "directie",
  "vastgoedbeheerder",
  "wijkbeheerder",
  "verhuurconsulent",
]);

const authoredDevRoleGroupSegments: Record<string, string> = {
  directie: "directie",
  vastgoedbeheerder: "vastgoedbeheer",
  wijkbeheerder: "wijkbeheer",
  verhuurconsulent: "verhuur",
};

export function hasApplicationRealmRole(roles: readonly string[]): boolean {
  return roles.some((role) => applicationRealmRoles.has(role));
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

export function claimsIncludeRoleState(claims: JwtClaims | undefined): boolean {
  return Boolean(claims && ("realm_access" in claims || "resource_access" in claims));
}

function resolveAuthoredDevGroupFallback(
  tenantId: string | undefined,
  roles: readonly string[],
): string[] {
  if (!tenantId || !issuer.endsWith("/realms/openshapeforge")) return [];
  if (tenantId !== "acme" && tenantId !== "beta") return [];

  return roles
    .map((role) => authoredDevRoleGroupSegments[role])
    .filter((segment): segment is string => Boolean(segment))
    .map((segment) => `/openshapeforge-demo/tenant-${tenantId}/role-${segment}`);
}

export function resolveInitialGroups(
  accessTokenClaims: JwtClaims | undefined,
  idTokenClaims: JwtClaims | undefined,
  profile: JwtClaims | undefined,
  tenantId: string | undefined,
  roles: readonly string[],
): string[] {
  for (const claims of [accessTokenClaims, idTokenClaims, profile]) {
    const groups = parseGroups(claims);
    if (groups.length > 0) return groups;
  }
  return resolveAuthoredDevGroupFallback(tenantId, roles);
}

export function resolveRefreshedGroups(
  accessTokenClaims: JwtClaims | undefined,
  idTokenClaims: JwtClaims | undefined,
  existingGroups: string[] | undefined,
): string[] | undefined {
  if (accessTokenClaims && "groups" in accessTokenClaims) {
    return parseGroups(accessTokenClaims);
  }
  if (idTokenClaims && "groups" in idTokenClaims) {
    return parseGroups(idTokenClaims);
  }
  return existingGroups;
}

export function resolveInitialTenantId(
  profile: JwtClaims | undefined,
  accessTokenClaims: JwtClaims | undefined,
  idTokenClaims: JwtClaims | undefined,
): string | undefined {
  return (profile?.tid as string | undefined)
    ?? (accessTokenClaims?.tid as string | undefined)
    ?? (idTokenClaims?.tid as string | undefined);
}

export function resolveInitialActorType(
  tenantId: string | undefined,
  profile: JwtClaims | undefined,
  accessTokenClaims: JwtClaims | undefined,
  idTokenClaims: JwtClaims | undefined,
): string | undefined {
  return parseTenantContext(profile, tenantId)
    ?? (profile?.act as string | undefined)
    ?? parseTenantContext(accessTokenClaims, tenantId)
    ?? (accessTokenClaims?.act as string | undefined)
    ?? parseTenantContext(idTokenClaims, tenantId)
    ?? (idTokenClaims?.act as string | undefined);
}

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
