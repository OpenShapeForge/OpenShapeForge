// SPDX-License-Identifier: BUSL-1.1
/**
 * The session a VERIFIED bearer token proves: which tenant the token selects
 * (host mode, an organization-bound resource, an explicit service account),
 * the person's admission through the identity ↔ Relation link, and the roles
 * the session holds. Called by ./session-resolver.ts once the verifier has
 * accepted the token; everything that throws here is classified there.
 */
import { realmFromIssuer, type AuthIdentity } from "@openshapeforge/auth";
import type { getBearerVerifier } from "./bearer-verifier.js";
import {
  identityClaimsFromToken,
  resolveIdentityLink,
  type IdentityClaims,
  type IdentityLinkState,
} from "./identity-link.js";
import { loginSessionBindingFromClaims } from "./login-session-binding.js";
import { configuredOrganizationServiceAccount } from "./organization-service-identities.js";
import { personSessionRoles } from "./person-roles.js";
import { SessionAuthenticationUnavailableError } from "./session-unavailable.js";
import { resolveRelationGroupMembershipIds } from "./relation-group-memberships.js";
import { OrganizationBindingError, sameTenantId } from "./organization-binding.js";
import {
  resolveHostOrganizationTenant,
  resolveScopedServiceTenant,
  resolveTenantForBoundOrganization,
  resolveTenantFromOrganization,
} from "./tenant-resolution.js";
import type { TrustedSessionContext } from "./trusted-context.js";
import { EMPTY_SESSION, hostOrganizationContext, resolveScope, type ResolveSessionOptions } from "./session-resolver.js";

/**
 * Test-only: stand in for the membership read (`resolveIdentityLink`) so the
 * bearer paths can be exercised end to end without a database. A person is
 * still refused without one in production; this seam is the only way past
 * that. Cleared by `__resetSessionResolverForTests`.
 */
export type IdentityLinkForTests = (
  session: { tenantId: string; userId: string },
  claims: IdentityClaims,
) => Promise<IdentityLinkState | null>;
export function __setIdentityLinkForTests(resolver: IdentityLinkForTests | null): void {
  identityLinkOverride = resolver;
}
let identityLinkOverride: IdentityLinkForTests | null = null;

/** Test-only. */
export function __resetBearerSessionForTests(): void {
  identityLinkOverride = null;
}

/**
 * Effective roles for a SERVICE identity outside host organization context = realm roles ∪ every
 * `resource_access` client's roles. Keycloak expands realm and client
 * composites into per-client roles under `resource_access`, so entity roles
 * like `Relations.All.ReadWrite` only exist there — realm_access alone would
 * deny every generated-entity operation once role enforcement runs. Merging
 * all clients is safe because the entity guard matches exact strings from
 * the manifest, so unrelated built-ins (`account.manage-account`, …) are
 * inert. Exported for unit testing.
 *
 * Never applied to a PERSON: see {@link personSessionRoles}.
 */
export function mergeIdentityRoles(identity: {
  roles: readonly string[];
  clientRoles?: Record<string, string[]> | undefined;
}): string[] {
  return [
    ...new Set([
      ...identity.roles,
      ...Object.values(identity.clientRoles ?? {}).flat(),
    ]),
  ].sort();
}

/** Keycloak's own naming of a client-credentials principal, on verified claims. */
function isServiceAccountToken(claims: Record<string, unknown>): boolean {
  return typeof claims.azp === "string" && claims.azp.length > 0 &&
    claims.preferred_username === `service-account-${claims.azp}`;
}

/** Service identities (configured service accounts, API-key exchanges). */
export function sessionIdentityRoles(identity: AuthIdentity): string[] {
  if (!hostOrganizationContext()) return mergeIdentityRoles(identity);
  // Client roles belong to a resource server, not every sibling client in the
  // realm. Organization-local claims stay nested; ambiguous tokens are refused
  // before these roles can become an authenticated session. Realm roles remain
  // issuer-wide grants and must not contain flattened per-organization rights.
  const audience = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE;
  const clientRoles = audience ? identity.clientRoles?.[audience] : undefined;
  return [...new Set([...identity.roles, ...(clientRoles ?? [])])].sort();
}



type Verifier = NonNullable<ReturnType<typeof getBearerVerifier>>;

export async function resolveVerifiedBearerSession(
  verifier: Verifier,
  token: string,
  options: ResolveSessionOptions,
): Promise<TrustedSessionContext> {
    const { identity, claims } = await verifier(token);
    if (options.organization &&
        (typeof claims.azp !== "string" || !claims.azp.trim())) return EMPTY_SESSION;
    if (hostOrganizationContext() && options.requiredAudience !== undefined &&
        (typeof claims.azp !== "string" || !claims.azp.trim())) return EMPTY_SESSION;
    if (options.requiredAudience !== undefined &&
        !(typeof claims.aud === "string" ? [claims.aud] : claims.aud ?? [])
          .includes(options.requiredAudience)) return EMPTY_SESSION;
    const groups = identity.groups ?? [];
    const hostMode = hostOrganizationContext();
    const configuredService = hostMode
      ? configuredOrganizationServiceAccount(claims, identity.tenantId)
      : undefined;
    const hostTenantId = hostMode
      ? configuredService
        ? await resolveScopedServiceTenant(identity, claims, configuredService, options.db)
        : await resolveHostOrganizationTenant(identity, claims, options.db)
      : null;
    if (hostMode && (!hostTenantId || !identity.userId)) return EMPTY_SESSION;
    // On a per-organization resource the tenant is the one the path's
    // organization links to, and nothing else in the token may pick it.
    // Shared host endpoints use the verified selected organization. The shared
    // mount retains tid preference followed by organization resolution.
    const tenantId = options.organization
      ? await resolveTenantForBoundOrganization(
          identity,
          claims as Record<string, unknown>,
          options.organization,
          options.db,
        )
      : hostMode ? hostTenantId : identity.tenantId ??
        (await resolveTenantFromOrganization(
          identity,
          claims as Record<string, unknown>,
          options.db,
        ));
    if (hostMode && !sameTenantId(tenantId, hostTenantId)) return EMPTY_SESSION;
    // ---- identity ↔ Relation link (auth/identity-link.ts) ----
    // A person's first session in a tenant links (or records) the Relation
    // they act as; later sessions read it back. The same row carries the
    // person's roles in that tenant.
    const personClaims = identityClaimsFromToken(claims as Record<string, unknown>);
    // A client-credentials token is not a person: an explicitly configured
    // service identity, or any service account the verifier already
    // accepted (Keycloak names them `service-account-<clientId>` and the
    // authorized party is that client — both are VERIFIED claims here, not
    // unverified input). Persons take their roles from the membership row;
    // service identities keep their client roles.
    const serviceAccount = configuredOrganizationServiceAccount(claims as Record<string, unknown>, tenantId);
    const isPerson = !serviceAccount && !isServiceAccountToken(claims) && personClaims !== null;
    // A person whose membership cannot be resolved has no session: the row
    // is where admission and roles live, so without a database there is
    // nothing to decide with (503), and without a tenant or subject there
    // is nobody to decide for (no session). Never a token-only person.
    if (isPerson && !options.db && !identityLinkOverride) {
      throw new SessionAuthenticationUnavailableError(
        "This surface resolves sessions without a database; a person cannot be admitted here.",
      );
    }
    if (isPerson && (!tenantId || !identity.userId)) return EMPTY_SESSION;
    // The link is read on a session that holds no organization roles yet:
    // the row itself is the source of those, and RLS on it fences by tenant
    // and by the identity being one's own.
    const linkSession = { roles: [...identity.roles], groups, scope: resolveScope(identity.roles, groups) };
    const relation =
      isPerson && tenantId && identity.userId
        ? identityLinkOverride
          ? await identityLinkOverride({ tenantId, userId: identity.userId }, personClaims)
          : await resolveIdentityLink(
              options.db!,
              { tenantId, userId: identity.userId, ...linkSession },
              personClaims,
            )
        : null;
    if (isPerson && !relation) {
      throw new SessionAuthenticationUnavailableError(
        "The membership record could not be resolved; try again.",
      );
    }
    const effectiveRoles = isPerson && relation
      ? personSessionRoles(identity, relation, realmFromIssuer(claims.iss))
      : sessionIdentityRoles(identity);
    const effectiveScope = resolveScope(effectiveRoles, groups);
    const loginSessionBinding = loginSessionBindingFromClaims(
      claims as Record<string, unknown>,
    );
    const relationGroupIds =
      tenantId && identity.userId && options.db && !serviceAccount && personClaims
        ? await resolveRelationGroupMembershipIds(
            options.db,
            {
              tenantId,
              userId: identity.userId,
              roles: effectiveRoles,
              groups,
              scope: effectiveScope,
            },
            { issuer: personClaims.issuer, subject: personClaims.subject },
          )
        : [];
    // ---- end identity ↔ Relation link ----
    return {
      tenantId,
      userId: identity.userId,
      ...(typeof claims.iss === "string" ? { issuer: claims.iss } : {}),
      ...(loginSessionBinding ? { loginSessionBinding } : {}),
      userDisplayName: relation?.displayName ?? null,
      ...(typeof claims.locale === "string" && claims.locale.trim() ? { locale: claims.locale.trim() } : {}),
      roles: effectiveRoles,
      oauthScopes: identity.scopes ?? [],
      groups,
      relationGroupIds,
      scope: effectiveScope,
      credential: "bearer",
      relation,
    };
}
