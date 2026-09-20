// SPDX-License-Identifier: BUSL-1.1
import { parseGroups, parseTenantContext, parseTenantId } from "@openshapeforge/auth";
import type { JwtClaims, RefreshedClaims, SignInClaims } from "@openshapeforge/auth/session";

export type { JwtClaims };
export { parseAuthorizationRoles } from "@openshapeforge/auth/session";

/** What the tenant app stores beside the common session fields. */
export type TenantSessionFields = {
  tenantId?: string | undefined;
  actorType?: string | undefined;
  /**
   * Keycloak group paths the user belongs to, e.g. "/customer/region/editors".
   * Forwarded to the API in trusted-context headers so app/API gates can
   * authorize on group membership.
   */
  groups?: string[] | undefined;
};

export function resolveInitialGroups(
  accessTokenClaims: JwtClaims | undefined,
  idTokenClaims: JwtClaims | undefined,
  profile: JwtClaims | undefined,
): string[] {
  for (const claims of [accessTokenClaims, idTokenClaims, profile]) {
    const groups = parseGroups(claims);
    if (groups.length > 0) return groups;
  }
  return [];
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
  for (const claims of [profile, accessTokenClaims, idTokenClaims]) {
    const tenantId = claims?.tid;
    if (typeof tenantId === "string" && tenantId.trim().length > 0) {
      return tenantId;
    }
  }
  return undefined;
}

/**
 * Web entry is identity-driven, not persona-driven. Any authenticated identity
 * carrying a tenant context may enter; generated operation authorization then
 * decides which navigation and actions it can use.
 */
export function hasApplicationTenantContext(
  profile: JwtClaims | undefined,
  accessTokenClaims: JwtClaims | undefined,
  idTokenClaims: JwtClaims | undefined,
): boolean {
  return resolveInitialTenantId(profile, accessTokenClaims, idTokenClaims) !== undefined;
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

export function initialTenantFields({ profile, accessTokenClaims, idTokenClaims }: SignInClaims): TenantSessionFields {
  const tenantId = resolveInitialTenantId(profile, accessTokenClaims, idTokenClaims);
  return {
    tenantId,
    actorType: resolveInitialActorType(tenantId, profile, accessTokenClaims, idTokenClaims),
    groups: resolveInitialGroups(accessTokenClaims, idTokenClaims, profile),
  };
}

/**
 * A refreshed token must still belong to the session's tenant: a token with
 * no `tid`, or another tenant's, would quietly swap the session's authority.
 */
export function tenantRefreshInvariant(
  accessClaims: JwtClaims,
  stored: TenantSessionFields,
): string | undefined {
  const tenantId = parseTenantId(accessClaims);
  if (!tenantId) return "refreshed token carries no tenant";
  if (stored.tenantId && tenantId !== stored.tenantId) return "tenant changed mid-session";
  return undefined;
}

export function refreshedTenantFields(
  { accessTokenClaims, idTokenClaims }: RefreshedClaims,
  stored: TenantSessionFields,
): TenantSessionFields {
  const tenantId = (accessTokenClaims?.tid as string | undefined) ?? stored.tenantId;
  return {
    tenantId,
    actorType: parseTenantContext(accessTokenClaims, tenantId)
      ?? (accessTokenClaims?.act as string | undefined)
      ?? stored.actorType,
    groups: resolveRefreshedGroups(accessTokenClaims, idTokenClaims, stored.groups),
  };
}
