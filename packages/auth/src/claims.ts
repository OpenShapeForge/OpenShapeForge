import { decodeJwt } from "jose";
import type { AuthIdentity, AuthProfile } from "./types.js";

type JwtClaims = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

/** Decode a JWT without verification. Returns undefined when the token is missing or malformed. */
export function readJwtClaims(token: string | undefined | null): JwtClaims | undefined {
  if (!token) return undefined;
  try {
    return decodeJwt(token) as JwtClaims;
  } catch {
    return undefined;
  }
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function getString(claims: JwtClaims | undefined, key: string): string | undefined {
  const value = claims?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getStringArray(claims: JwtClaims | undefined, key: string): string[] | undefined {
  const value = claims?.[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return items.length > 0 ? items : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

/** Roles from `realm_access.roles`. */
export function parseRoles(claims: JwtClaims | undefined): string[] {
  const realmAccess = asJsonObject(claims?.realm_access);
  const roles = realmAccess?.roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter((role): role is string => typeof role === "string");
}

/** Per-client roles from `resource_access.<client>.roles`. */
export function parseClientRoles(claims: JwtClaims | undefined): Record<string, string[]> {
  const resourceAccess = asJsonObject(claims?.resource_access);
  if (!resourceAccess) return {};

  const result: Record<string, string[]> = {};
  for (const [client, value] of Object.entries(resourceAccess)) {
    const roles = asJsonObject(value)?.roles;
    if (Array.isArray(roles)) {
      result[client] = roles.filter(
        (role): role is string => typeof role === "string",
      );
    }
  }
  return result;
}

/** OAuth scopes from `scope` (space-delimited string) or `scp` (array). */
export function parseScopes(claims: JwtClaims | undefined): string[] {
  const scope = claims?.scope;
  if (typeof scope === "string") {
    return scope.split(/\s+/).filter((value) => value.length > 0);
  }

  const scp = claims?.scp;
  if (Array.isArray(scp)) {
    return scp.filter((value): value is string => typeof value === "string");
  }

  return [];
}

/** Tenant id from the `tid` claim. */
export function parseTenantId(claims: JwtClaims | undefined): string | undefined {
  return getString(claims, "tid");
}

/**
 * Keycloak group paths from the `groups` claim. Returns paths like
 * "/openshapeforge-demo/tenant-acme/operations". Requires the Keycloak client to
 * have a group-membership protocol mapper enabled on the access-token
 * scope.
 *
 * Returns an empty array if the claim is absent or malformed — fail-closed
 * for the consumer; an empty groups list at the session layer means the
 * user can only see rows under their direct user-scope predicates.
 */
export function parseGroups(claims: JwtClaims | undefined): string[] {
  return getStringArray(claims, "groups") ?? [];
}

function readTenantContextFromOrganizationClaim(
  claims: JwtClaims | undefined,
  tenantId: string | undefined,
): string | undefined {
  const organizationClaim = asJsonObject(claims?.organization);
  if (!organizationClaim) return undefined;

  const membership = tenantId ? asJsonObject(organizationClaim[tenantId]) : undefined;
  const candidates = [
    membership,
    ...Object.values(organizationClaim).map(asJsonObject),
  ].filter((value): value is JsonObject => Boolean(value));

  for (const candidate of candidates) {
    const sector = candidate.sector;
    if (typeof sector === "string" && sector.trim()) return sector.trim();
    if (Array.isArray(sector)) {
      const first = sector.find(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
      if (first) return first.trim();
    }

    const contexts = candidate.contexts;
    if (Array.isArray(contexts)) {
      const first = contexts.find(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
      if (first) return first.trim();
    }

    const defaultContext = candidate.default_context;
    if (typeof defaultContext === "string" && defaultContext.trim()) {
      return defaultContext.trim();
    }
  }

  return undefined;
}

/**
 * Resolves the active tenant context (e.g. `core`, or a profile context) from the claim
 * salad Keycloak emits: direct `sector`/`context`/`default_context`/
 * `tenant_context`, then `contexts[]`, then the `organization` claim, falling
 * back to the per-tenant membership inside `organization[<tenantId>]`.
 */
export function parseTenantContext(
  claims: JwtClaims | undefined,
  tenantId: string | undefined,
): string | undefined {
  const direct = firstNonEmpty(
    getString(claims, "sector"),
    getString(claims, "context"),
    getString(claims, "default_context"),
    getString(claims, "tenant_context"),
  );
  if (direct) return direct;

  const contexts = getStringArray(claims, "contexts");
  if (contexts?.[0]) return contexts[0];

  return readTenantContextFromOrganizationClaim(claims, tenantId);
}

type UserProfileSources = {
  sub?: string | undefined;
  stored?: AuthProfile | undefined;
  profile?: JwtClaims | undefined;
  idTokenClaims?: JwtClaims | undefined;
  accessTokenClaims?: JwtClaims | undefined;
};

/**
 * Builds the canonical user profile by walking the fallback chain:
 * stored override → OIDC profile → id_token claims → access_token claims,
 * with `name` finally falling back to `${given} ${family}` / preferredUsername / sub.
 */
export function parseUserProfile(sources: UserProfileSources): AuthProfile {
  const givenName = firstNonEmpty(
    sources.stored?.givenName,
    getString(sources.profile, "given_name"),
    getString(sources.idTokenClaims, "given_name"),
    getString(sources.accessTokenClaims, "given_name"),
  );
  const familyName = firstNonEmpty(
    sources.stored?.familyName,
    getString(sources.profile, "family_name"),
    getString(sources.idTokenClaims, "family_name"),
    getString(sources.accessTokenClaims, "family_name"),
  );
  const preferredUsername = firstNonEmpty(
    sources.stored?.preferredUsername,
    getString(sources.profile, "preferred_username"),
    getString(sources.idTokenClaims, "preferred_username"),
    getString(sources.accessTokenClaims, "preferred_username"),
  );
  const email = firstNonEmpty(
    sources.stored?.email,
    getString(sources.profile, "email"),
    getString(sources.idTokenClaims, "email"),
    getString(sources.accessTokenClaims, "email"),
  );
  const combinedName = [givenName, familyName].filter(Boolean).join(" ").trim() || undefined;
  const name = firstNonEmpty(
    sources.stored?.name,
    getString(sources.profile, "name"),
    getString(sources.idTokenClaims, "name"),
    getString(sources.accessTokenClaims, "name"),
    combinedName,
    preferredUsername,
    sources.sub,
  );

  const profile: AuthProfile = {};
  if (name !== undefined) profile.name = name;
  if (email !== undefined) profile.email = email;
  if (givenName !== undefined) profile.givenName = givenName;
  if (familyName !== undefined) profile.familyName = familyName;
  if (preferredUsername !== undefined) profile.preferredUsername = preferredUsername;
  return profile;
}

/** One-shot helper: turn a verified JWT payload into a canonical AuthIdentity. */
export function parseAuthIdentity(claims: JwtClaims): AuthIdentity {
  const tenantId = parseTenantId(claims) ?? null;
  const userId = getString(claims, "sub") ?? null;
  const profile = parseUserProfile({ accessTokenClaims: claims, sub: userId ?? undefined });

  const groups = parseGroups(claims);
  const identity: AuthIdentity = {
    tenantId,
    userId,
    roles: parseRoles(claims),
    scopes: parseScopes(claims),
    clientRoles: parseClientRoles(claims),
  };
  if (groups.length > 0) identity.groups = groups;
  if (Object.keys(profile).length > 0) {
    identity.profile = profile;
  }
  return identity;
}
