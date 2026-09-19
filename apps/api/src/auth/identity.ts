// SPDX-License-Identifier: BUSL-1.1
import {
  BearerVerifierUnavailableError,
  createBearerVerifier,
  ORGANIZATION_TENANT_CACHE_TTL_MS,
  organizationTenantCacheKey,
  realmFromIssuer,
  selectOrganizationMembership,
  type AuthIdentity,
  type BearerVerifier,
} from "@openshapeforge/auth";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import { ORGANIZATION_ADDRESS_HEADER } from "../mcp/organization-resource.js";
import { keyringFromEnv, type SecretKeyring } from "../platform/secrets.js";
import { HttpError } from "../rest/http-error.js";
import { looksLikeApiKey } from "./api-key/format.js";
// ---- identity ↔ Relation link (auth/identity-link.ts) ----
import {
  NEEDS_ROLE_ASSIGNMENT_ROLES,
  NotInvitedError,
  identityClaimsFromToken,
  resolveIdentityLink,
} from "./identity-link.js";
// ---- end identity ↔ Relation link ----
import { resolveApiKeySession } from "./api-key/resolve.js";
import { loginSessionBindingFromClaims } from "./login-session-binding.js";
import { configuredOrganizationServiceAccount } from "./organization-service-identities.js";
import { SessionAuthenticationUnavailableError } from "./session-unavailable.js";
import { resolveRelationGroupMembershipIds } from "./relation-group-memberships.js";
import {
  bindOrganizationResource,
  OrganizationBindingError,
  sameTenantId,
  type OrganizationResourceBinding,
  type TenantForOrganization,
} from "./organization-binding.js";
import {
  readTrustedSessionContext,
  type SessionScope,
  type TrustedSessionContext,
} from "./trusted-context.js";

export type ResolveSessionOptions = {
  /**
   * Required for API keys and organization-to-tenant registry resolution.
   * Host organization mode refuses sessions without registry proof.
   */
  db?: OpenShapeForgeDatabase | undefined;
  /**
   * Preserve authentication-service unavailability as a distinct failure.
   * Ordinary callers keep the historical anonymous-session fallback.
   */
  failOnUnavailable?: boolean;
  /** Exact resource audience required in addition to the configured verifier audience.
   * Supplying this makes the endpoint bearer-only (no API key or trusted context).
   */
  requiredAudience?: string;
  /**
   * Set by the per-organization MCP resource (`/api/mcp/organizations/<alias>`).
   * The session is then only produced from a bearer JWT that is bound to that
   * resource — membership of the organization, the resource URL in `aud`, a
   * tenant linked to the organization — and is pinned to that tenant. Any
   * other credential is refused, and a bound token that fails a check raises
   * {@link OrganizationBindingError} instead of degrading to the empty session
   * (see auth/organization-binding.ts).
   */
  organization?: OrganizationResourceBinding;
};

/** Read per request: hosts and standalone processes may configure this after import. */
function hostOrganizationContext(): boolean {
  return process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT === "host";
}

export { SessionAuthenticationUnavailableError };

function bearerVerifierUnavailable(error: unknown): boolean {
  return error instanceof BearerVerifierUnavailableError;
}

const EMPTY_SESSION: TrustedSessionContext = {
  tenantId: null,
  userId: null,
  roles: [],
  groups: [],
  relationGroupIds: [],
  scope: "self",
  credential: "none",
};

let verifierInitialized = false;
let cachedVerifier: BearerVerifier | null = null;
let cachedResourceVerifier: BearerVerifier | null = null;
let cachedOrganizationVerifier: BearerVerifier | null = null;
let cachedTenantBypassRoles: ReadonlySet<string> | null = null;

function getBearerVerifier(allowResourceClient = false, organizationBound = false): BearerVerifier | null {
  if (verifierInitialized) return organizationBound ? cachedOrganizationVerifier : allowResourceClient ? cachedResourceVerifier : cachedVerifier;
  verifierInitialized = true;

  const jwksUri = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI;
  const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;
  const audience = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE;
  const authorizedPartiesValue =
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES;
  const authorizedParties = authorizedPartiesValue === undefined
    ? undefined
    : authorizedPartiesValue
        .split(",")
        .map((party) => party.trim())
        .filter(Boolean);

  if (!jwksUri || !issuer) {
    cachedVerifier = null;
    return null;
  }

  if (!audience) {
    // Bearer verification is configured (JWKS + issuer) but no audience is
    // pinned, so ANY same-issuer Keycloak token — including ones minted for
    // sibling clients — would be accepted. In dev this is a loud warning; in
    // production it is fatal (see config/production-guard.ts assertProductionEnv).
    console.warn(
      "[auth] OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE is unset: bearer tokens are " +
        "accepted from any same-issuer client. Set it to the expected `aud` " +
        "value (e.g. erp-provider). This is fatal in production.",
    );
  }

  cachedVerifier = createBearerVerifier({
    jwksUri,
    issuer,
    ...(audience ? { audience } : {}),
    ...(authorizedParties ? { authorizedParties } : {}),
  });
  // Dynamic OAuth clients cannot appear in a static azp allowlist. This
  // verifier is used ONLY when the caller also requires an exact resource aud;
  // signature, issuer and configured API audience checks still apply.
  cachedResourceVerifier = createBearerVerifier({
    jwksUri,
    issuer,
    ...(audience ? { audience } : {}),
  });
  // Explicit organization resources validate their own exact audience and
  // membership through bindOrganizationResource before producing a session.
  // A web client's azp/API audience is not the authority for these resources.
  cachedOrganizationVerifier = createBearerVerifier({ jwksUri, issuer });
  return organizationBound ? cachedOrganizationVerifier : allowResourceClient ? cachedResourceVerifier : cachedVerifier;
}

/**
 * Roles that grant tenant-wide read scope. The full set is generated by the
 * compiler from each entity's `rowScope.bypassRoles` declaration; until that
 * lands (P5/P7), an env override is supported for staged rollout:
 *
 *   APP_TENANT_BYPASS_ROLES=Platform.TenantAdmin,Case.TenantAdmin
 *
 * If the env var is unset, no role grants tenant scope and resolveScope()
 * falls through to "group"/"self".
 */
function getTenantBypassRoles(): ReadonlySet<string> {
  if (cachedTenantBypassRoles) return cachedTenantBypassRoles;
  const raw = process.env.APP_TENANT_BYPASS_ROLES ?? "";
  cachedTenantBypassRoles = new Set(
    raw
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean),
  );
  return cachedTenantBypassRoles;
}

/**
 * Re-exported from ./identity-link.js, which now owns it: the invitation
 * admission path in that module needs the same constant to say what
 * `org_employee` grants, and importing it back from here would make the
 * cycle between the two modules load-order sensitive. Kept exported from this
 * module so anything that imported it from here still resolves.
 */
export { NEEDS_ROLE_ASSIGNMENT_ROLES };

function resolveScope(roles: readonly string[], groups: readonly string[]): SessionScope {
  const bypass = getTenantBypassRoles();
  if (bypass.size > 0 && roles.some((role) => bypass.has(role))) return "tenant";
  if (groups.length > 0) return "group";
  return "self";
}

/** Test-only: reset cached state so env changes are picked up. */
export function __resetSessionResolverForTests(): void {
  verifierInitialized = false;
  cachedVerifier = null;
  cachedResourceVerifier = null;
  cachedOrganizationVerifier = null;
  cachedTenantBypassRoles = null;
  apiKeyKeyringInitialized = false;
  cachedApiKeyKeyring = null;
  organizationTenantCache.clear();
  tenantForOrganizationOverride = null;
  tenantSlugCache.clear();
  tenantSlugOverride = null;
}

/**
 * Test-only: stand in for the `platform.tenants.slug` read behind the short
 * address check. Cleared by the reset above.
 */
export function __setTenantSlugForTests(lookup: ((tenantId: string) => string | null) | null): void {
  tenantSlugOverride = lookup;
}
let tenantSlugOverride: ((tenantId: string) => string | null) | null = null;

/**
 * Test-only: stand in for the registry read
 * (`app.tenant_for_keycloak_organization`) so the organization paths can be
 * exercised end to end without a database. Cleared by the reset above.
 */
export function __setTenantForOrganizationForTests(
  lookup: TenantForOrganization | null,
): void {
  tenantForOrganizationOverride = lookup;
}
let tenantForOrganizationOverride: TenantForOrganization | null = null;

// ---------------------------------------------------------------------------
// Tenant from Keycloak Organization membership
//
// A token names its tenant in one of two ways:
//
//   - `tid`: a user attribute the dev realm maps straight into the token. It is
//     the legacy shape and stays authoritative only outside host mode.
//   - `organization.<alias>.id`: Keycloak's own Organization Membership mapper
//     (client scope `organization`, "add organization id" on). This is how a
//     deployment that models tenants as Keycloak Organizations — the shape the
//     control plane provisions — says which tenant the user is in. The
//     Organization id is NOT the tenant id (the two are generated by different
//     systems and are never interchangeable); the link is the registry row
//     `platform.tenants.keycloak_organization_id`, stamped by provisioning.
//
// So an organization-only token needs one registry read, and it needs it
// before the session has a tenant to scope that read by. That is exactly what
// `app.tenant_for_keycloak_organization(realm, organization_id)` exists for
// (db/migrations/app-helpers.ts): a point lookup with a function-scoped RLS
// bypass, answering one id for one (realm, organization) pair the caller has
// already proved membership of through a signed token.
//
// Fail-closed throughout: no database, no membership with an id, a membership
// no registry row links to, or an ambiguous set of memberships all leave the
// tenant null, which every surface already rejects as unauthenticated. The
// realm is taken from `iss` and matched against `tenants.keycloak_realm`, so a
// row provisioned for one realm can never be reached by a token from another.

// The TTL, the realm parser, the membership selection and the cache key live in
// `@openshapeforge/auth` (organization-tenant.ts) because Hubble's separately
// bundled plugin runtime needs exactly the same answers and cannot import this
// file. The cache instance below is process state and stays here.
const organizationTenantCache = new Map<string, { tenantId: string; expiresAtMs: number }>();

// Re-exported so this module keeps being the one address the rest of apps/api
// (and its tests) use for the organization path; the implementations are in
// `@openshapeforge/auth`.
export { organizationTenantCacheKey, realmFromIssuer, selectOrganizationMembership };

/**
 * The registry read behind both organization paths: which tenant is linked to
 * (realm, organization id). Cached briefly; null when no row links them.
 */
async function lookupTenantForOrganization(
  db: OpenShapeForgeDatabase | undefined,
  realm: string,
  organizationId: string,
): Promise<string | null> {
  if (tenantForOrganizationOverride) {
    return tenantForOrganizationOverride(realm, organizationId);
  }
  if (!db) return null;
  const cacheKey = organizationTenantCacheKey(realm, organizationId);
  const cached = organizationTenantCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) return cached.tenantId;

  const result = await sql<{ tenant_id: string | null }>`
    select app.tenant_for_keycloak_organization(${realm}, ${organizationId}) as tenant_id
  `.execute(db);
  const tenantId = result.rows[0]?.tenant_id ?? null;
  if (tenantId) {
    organizationTenantCache.set(cacheKey, {
      tenantId,
      expiresAtMs: Date.now() + ORGANIZATION_TENANT_CACHE_TTL_MS,
    });
  }
  return tenantId;
}

async function resolveTenantFromOrganization(
  identity: AuthIdentity,
  claims: Record<string, unknown>,
  db: OpenShapeForgeDatabase | undefined,
): Promise<string | null> {
  const membership = selectOrganizationMembership(identity);
  if (!membership) {
    if (Object.keys(identity.organizations ?? {}).length > 0) {
      console.warn(
        "[auth] Bearer token carries Keycloak Organization memberships but none can be " +
          "selected (no `id` on the membership — enable \"add organization id\" on the " +
          "organization membership mapper — or several memberships without an " +
          "`organization:<alias>` scope). Tenant unresolved.",
      );
    }
    return null;
  }
  const realm = realmFromIssuer(claims.iss);
  if (!realm) {
    console.warn("[auth] Bearer token issuer is not a Keycloak realm URL; tenant unresolved.");
    return null;
  }
  if (!db && !tenantForOrganizationOverride) {
    console.warn(
      "[auth] Bearer token names its tenant by Keycloak Organization membership, but this " +
        "surface resolves sessions without a database. Tenant unresolved.",
    );
    return null;
  }

  const tenantId = await lookupTenantForOrganization(db, realm, membership.id);
  if (!tenantId) {
    console.warn(
      `[auth] No tenant is linked to Keycloak Organization "${membership.alias}" ` +
        `(${membership.id}) in realm "${realm}". Provision or reconcile it through the ` +
        "control plane. Tenant unresolved.",
    );
    return null;
  }
  return tenantId;
}

/** A human host session has exactly one selected, verified membership. Neither
 * tid, organization-specific scopes nor transport input may select another one.
 */
async function resolveHostOrganizationTenant(
  identity: AuthIdentity,
  claims: Record<string, unknown>,
  db: OpenShapeForgeDatabase | undefined,
): Promise<string | null> {
  const raw = claims.organization;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).length !== 1 || !identity.scopes?.includes("organization")) return null;
  const memberships = Object.entries(identity.organizations ?? {});
  if (memberships.length !== 1) return null;
  const membership = memberships[0]![1];
  if (!membership.id?.trim()) return null;
  const realm = realmFromIssuer(claims.iss);
  if (!realm) return null;
  const tenantId = await lookupTenantForOrganization(db, realm, membership.id);
  if (!tenantId || (claims.tid !== undefined && !sameTenantId(
      typeof claims.tid === "string" ? claims.tid : null, tenantId))) return null;
  return tenantId;
}

/** Explicit service credentials supply the tenant authority. Verify that their
 * signed tid agrees with that credential AND its realm/organization registry row.
 * This is a tenant-scoped read, never a raw-input or cross-tenant bypass.
 */
async function resolveScopedServiceTenant(
  identity: AuthIdentity,
  claims: Record<string, unknown>,
  credential: { tenantId: string; clientId: string },
  db: OpenShapeForgeDatabase | undefined,
): Promise<string | null> {
  const realm = realmFromIssuer(claims.iss);
  if (!db || !realm || !identity.userId ||
      !sameTenantId(identity.tenantId, credential.tenantId) ||
      claims.azp !== credential.clientId ||
      claims.preferred_username !== `service-account-${credential.clientId}`) return null;
  const row = await withDbSession(db, {
    tenantId: credential.tenantId, userId: identity.userId, roles: [], scope: "self",
  }, async (trx) => {
    const result = await sql<{ keycloak_organization_id: string | null; keycloak_realm: string | null }>`
      select keycloak_organization_id, keycloak_realm from platform.tenants
      where id = ${credential.tenantId}::uuid
    `.execute(trx);
    return result.rows[0];
  });
  if (!row?.keycloak_organization_id || row.keycloak_realm !== realm) return null;
  const tenantId = await lookupTenantForOrganization(db, realm, row.keycloak_organization_id);
  if (!sameTenantId(tenantId, credential.tenantId)) return null;
  // If a service token also carries membership, it may not contradict the credential.
  if (claims.organization !== undefined &&
      await resolveHostOrganizationTenant(identity, claims, db) !== tenantId) return null;
  return tenantId;
}

/**
 * The per-organization resource path. Membership, audience and registry are
 * checked in auth/organization-binding.ts; this is the glue to the verifier's
 * output and the database. Throws OrganizationBindingError on any refusal.
 */
async function resolveTenantForBoundOrganization(
  identity: AuthIdentity,
  claims: Record<string, unknown>,
  binding: OrganizationResourceBinding,
  db: OpenShapeForgeDatabase | undefined,
): Promise<string> {
  const realm = realmFromIssuer(claims.iss);
  const lookup: TenantForOrganization = async (realmName, organizationId) => {
    if (!db && !tenantForOrganizationOverride) {
      throw new OrganizationBindingError(
        binding,
        "the organization resource resolves sessions without a database",
      );
    }
    return lookupTenantForOrganization(db, realmName, organizationId);
  };
  const bound = await bindOrganizationResource(identity, claims, binding, realm, lookup);
  return bound.tenantId;
}

/** Matches an `Authorization: Bearer <token>` header (case-insensitive). */
const BEARER_AUTHORIZATION = /^Bearer\s+(.+)$/i;

let apiKeyKeyringInitialized = false;
let cachedApiKeyKeyring: SecretKeyring | null = null;

/**
 * The keyring protecting API key integrations' Keycloak client secrets.
 *
 * Deliberately its OWN key material rather than the connector keyring: the two
 * subsystems encrypt different things for different reasons, and a compromise
 * of one should not decrypt the other. No fallback — an unset value means API
 * key authentication is simply not configured, and every key presented is
 * rejected.
 */
function getApiKeyKeyring(): SecretKeyring | null {
  if (apiKeyKeyringInitialized) return cachedApiKeyKeyring;
  apiKeyKeyringInitialized = true;
  try {
    cachedApiKeyKeyring = keyringFromEnv(process.env.OPENSHAPEFORGE_API_KEY_SECRET_KEYS) ?? null;
  } catch (error) {
    // A malformed keyring must not half-configure the subsystem.
    console.warn(
      "[auth] OPENSHAPEFORGE_API_KEY_SECRET_KEYS is malformed; API key authentication is disabled:",
      error instanceof Error ? error.message : String(error),
    );
    cachedApiKeyKeyring = null;
  }
  return cachedApiKeyKeyring;
}

/**
 * Verify a Keycloak token through the ordinary bearer path and flatten it to
 * the fields the API key resolver needs. Shared with the interactive path on
 * purpose: there is exactly one place where a token becomes an identity.
 */
async function verifyBearerIdentity(
  token: string,
  credential: { tenantId: string; keycloakClientId: string },
  db: OpenShapeForgeDatabase,
) {
  const verifier = getBearerVerifier();
  if (!verifier) {
    throw new Error("Bearer verifier is not configured.");
  }
  const { identity, claims } = await verifier(token);
  const tenantId = hostOrganizationContext()
    ? await resolveScopedServiceTenant(identity, claims, {
        tenantId: credential.tenantId, clientId: credential.keycloakClientId,
      }, db)
    : identity.tenantId;
  return {
    tenantId,
    userId: identity.userId,
    roles: sessionIdentityRoles(identity),
    groups: identity.groups ?? [],
    scopes: identity.scopes ?? [],
  };
}

/**
 * Legacy effective roles for a SERVICE identity = realm roles ∪ every
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

/**
 * A person's roles are per organization. The identity provider says WHICH
 * organizations the account is a member of; the membership row in
 * `platform.identity_relations` says what the person may do in the one the
 * token selected (auth/identity-link.ts). A client role on the Keycloak user
 * is user-wide — an administrator of organization A granting it would have
 * made the person that in organization B too — so a person's session never
 * reads `resource_access` at all. Realm roles remain issuer-wide grants by
 * design (platform operator decisions such as `Platform.*`), and the
 * just-in-time minimum applies while the membership row still says
 * `needs_role_assignment` and carries nothing.
 */
export function personSessionRoles(
  identity: Pick<AuthIdentity, "roles">,
  membership: { roles: readonly string[]; needsRoleAssignment: boolean } | null,
): string[] {
  if (membership?.needsRoleAssignment && membership.roles.length === 0) {
    return [...NEEDS_ROLE_ASSIGNMENT_ROLES];
  }
  return [...new Set([...identity.roles, ...(membership?.roles ?? [])])].sort();
}

/** Service identities (configured service accounts, API-key exchanges). */
function sessionIdentityRoles(identity: AuthIdentity): string[] {
  if (!hostOrganizationContext()) return mergeIdentityRoles(identity);
  // Client roles belong to a resource server, not every sibling client in the
  // realm. Organization-local claims stay nested; ambiguous tokens are refused
  // before these roles can become an authenticated session. Realm roles remain
  // issuer-wide grants and must not contain flattened per-organization rights.
  const audience = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE;
  const clientRoles = audience ? identity.clientRoles?.[audience] : undefined;
  return [...new Set([...identity.roles, ...(clientRoles ?? [])])].sort();
}

/**
 * A credential that is not for the organization the request was addressed
 * to: `/<alias>/api/...` or `/<alias>/graphql` with a token or key of another
 * tenant. The same refusal the per-organization MCP resource gives
 * (OrganizationBindingError), for the two surfaces that reach the session
 * resolver by rewritten URL — see ORGANIZATION_ADDRESS_HEADER.
 */
export class OrganizationAddressError extends HttpError {
  constructor(alias: string) {
    super(
      403,
      "ORGANIZATION_RESOURCE_FORBIDDEN",
      `This credential is not for the organization at /${alias}.`,
    );
    this.name = "OrganizationAddressError";
  }
}

const tenantSlugCache = new Map<string, { slug: string; expiresAtMs: number }>();

/** The tenant's own slug, read as the tenant (its registry row is visible to it). */
async function tenantSlug(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext & { tenantId: string; userId: string },
): Promise<string | null> {
  if (tenantSlugOverride) return tenantSlugOverride(session.tenantId);
  const cached = tenantSlugCache.get(session.tenantId);
  if (cached && cached.expiresAtMs > Date.now()) return cached.slug;
  const slug = await withDbSession(
    db,
    {
      tenantId: session.tenantId,
      userId: session.userId,
      roles: session.roles,
      groups: session.groups,
      scope: session.scope,
    },
    async (trx) => {
      const result = await sql<{ slug: string }>`
        select slug from platform.tenants where id = ${session.tenantId}::uuid
      `.execute(trx);
      return result.rows[0]?.slug ?? null;
    },
  );
  if (slug) {
    // Slugs are immutable after creation (platform-schema.yaml), so a cached
    // answer never goes stale in the direction that matters.
    tenantSlugCache.set(session.tenantId, { slug, expiresAtMs: Date.now() + ORGANIZATION_TENANT_CACHE_TTL_MS });
  }
  return slug;
}

/**
 * Refuse a session whose tenant is not the organization the short address
 * named. The per-organization MCP resource pins the tenant through its
 * binding and needs no second check; every other credential — bearer, API
 * key, trusted context — is compared by the tenant's registry slug, which is
 * the Keycloak Organization alias and the URL segment.
 */
async function assertSessionAddressesOrganization(
  headers: Headers,
  session: TrustedSessionContext,
  options: ResolveSessionOptions,
): Promise<TrustedSessionContext> {
  const alias = headers.get(ORGANIZATION_ADDRESS_HEADER)?.trim().toLowerCase();
  if (!alias || options.organization || !session.tenantId || !session.userId) return session;
  if (!options.db) {
    console.warn(
      `[auth] A credential was presented at /${alias} on a surface that resolves sessions ` +
        "without a database; the organization cannot be verified. Rejecting.",
    );
    return EMPTY_SESSION;
  }
  const slug = await tenantSlug(options.db, session as TrustedSessionContext & { tenantId: string; userId: string });
  if (slug?.toLowerCase() !== alias) {
    console.warn(
      `[auth] Credential for tenant ${session.tenantId} (${slug ?? "no slug"}) refused at /${alias}.`,
    );
    throw new OrganizationAddressError(alias);
  }
  return session;
}

/**
 * Resolves the canonical session context for a request, and refuses it when
 * the request's short address names another organization than the
 * credential's (see {@link assertSessionAddressesOrganization}).
 */
export async function resolveSessionContext(
  headers: Headers,
  options: ResolveSessionOptions = {},
): Promise<TrustedSessionContext> {
  const session = await resolveCredentialSession(headers, options);
  return assertSessionAddressesOrganization(headers, session, options);
}

/**
 * Resolves the session a credential proves.
 *
 * - If `Authorization: Bearer …` carries an `osf_`-prefixed API key, it is
 *   resolved ONLY by the API key path (see api-key/resolve.ts). A key is
 *   ultimately verified as a Keycloak token by the same verifier below, so it
 *   introduces no second source of roles; what it adds is a credential that can
 *   be handed to an external party and revoked without touching the realm.
 *   Like the bearer path, it never falls through on failure.
 * - Otherwise, if `Authorization: Bearer …` is present, it is the caller's
 *   explicit signal to authenticate by bearer. That signal must not be
 *   downgrade-attackable, so it is resolved ONLY by the bearer verifier:
 *     - Verifier configured + token valid → use the resulting identity.
 *     - Verifier configured + verification fails → fail closed (EMPTY_SESSION).
 *     - Verifier NOT configured → fail closed (EMPTY_SESSION). We do NOT fall
 *       through to trusted-context, because doing so would silently swap the
 *       active trust boundary (a rollout/config error that leaves the bearer
 *       env unset would trust inbound HMAC-signed context headers instead of
 *       verifying the presented token — a materially larger attack surface
 *       than the operator intended, with no startup signal).
 * - Without a bearer header, trusted-context HMAC verification remains
 *   available only outside host mode and bearer-only resources.
 *
 * The returned `groups` are raw Keycloak group paths from the access token's
 * `groups` claim. Translation to internal org-unit UUIDs (for RLS) happens
 * at the call site before `withDbSession`, against the org-unit lookup
 * table introduced in P6.
 */
async function resolveCredentialSession(
  headers: Headers,
  options: ResolveSessionOptions = {},
): Promise<TrustedSessionContext> {
  const authorization = headers.get("authorization");

  if (authorization && BEARER_AUTHORIZATION.test(authorization)) {
    const presented = BEARER_AUTHORIZATION.exec(authorization)![1]!;

    // An API key is routed by its prefix BEFORE the JWKS path, and once routed
    // it never falls through: a credential shaped like ours is ours to accept
    // or reject. Falling through would let a caller who knows the prefix probe
    // the JWKS verifier with arbitrary strings, and — worse — a deployment that
    // forgot to configure the keyring would silently start treating API keys as
    // JWTs, which is the same downgrade the bearer path already refuses.
    if (looksLikeApiKey(presented)) {
      if (options.organization || options.requiredAudience !== undefined) {
        // An API key proves a tenant, not an Organization membership, and
        // carries no per-resource audience. Fail closed on the bound resource.
        console.warn(
          "[auth] An API key was presented to a bearer-only resource. Rejecting.",
        );
        return EMPTY_SESSION;
      }
      const keyring = getApiKeyKeyring();
      const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER;

      if (!options.db || !keyring || !issuer || !getBearerVerifier()) {
        console.warn(
          "[auth] An API key was presented but the key path is not fully configured " +
            "(needs a database, OPENSHAPEFORGE_API_KEY_SECRET_KEYS, and a complete " +
            "bearer verifier). Rejecting.",
        );
        if (options.failOnUnavailable) {
          throw new SessionAuthenticationUnavailableError();
        }
        return EMPTY_SESSION;
      }

      const session = await resolveApiKeySession(
        {
          db: options.db,
          keyring,
          issuer,
          verifyToken: (token, credential) => verifyBearerIdentity(token, credential, options.db!),
          resolveScope,
        },
        presented,
      );
      return session ?? EMPTY_SESSION;
    }

    const verifier = getBearerVerifier(
      hostOrganizationContext() && options.requiredAudience !== undefined,
      options.organization !== undefined,
    );
    if (!verifier) {
      // A bearer credential was presented but no verifier is configured. Fail
      // closed rather than downgrading to the trusted-context header path.
      console.warn(
        "[auth] Authorization: Bearer header present but no bearer verifier is " +
          "configured (OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI/ISSUER unset). " +
          "Rejecting the request instead of falling back to trusted-context.",
      );
      if (options.failOnUnavailable) {
        throw new SessionAuthenticationUnavailableError();
      }
      return EMPTY_SESSION;
    }

    const match = BEARER_AUTHORIZATION.exec(authorization);
    const token = match![1]!;
    try {
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
      // Shared host endpoints use the verified selected organization. Legacy
      // mode retains tid preference followed by organization resolution.
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
      if (hostMode && tenantId !== hostTenantId) return EMPTY_SESSION;
      // ---- identity ↔ Relation link (auth/identity-link.ts) ----
      // A person's first session in a tenant links (or records) the Relation
      // they act as; later sessions read it back. The same row carries the
      // person's roles in that tenant.
      const personClaims = identityClaimsFromToken(claims as Record<string, unknown>);
      // An explicitly configured client-credentials identity is not a person.
      // Never infer this from a username prefix alone or from unverified input.
      const serviceAccount = configuredOrganizationServiceAccount(claims as Record<string, unknown>, tenantId);
      const isPerson = !serviceAccount && personClaims !== null;
      // The link is read on a session that holds no organization roles yet:
      // the row itself is the source of those, and RLS on it fences by tenant
      // and by the identity being one's own.
      const linkSession = { roles: [...identity.roles], groups, scope: resolveScope(identity.roles, groups) };
      const relation =
        isPerson && tenantId && identity.userId && options.db
          ? await resolveIdentityLink(
              options.db,
              { tenantId, userId: identity.userId, ...linkSession },
              personClaims,
            )
          : null;
      const effectiveRoles = isPerson
        ? personSessionRoles(identity, relation)
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
    } catch (error) {
      if (error instanceof NotInvitedError) {
        // The token verified and names a real person; this organization has
        // simply never been told to expect them. Answering EMPTY_SESSION here
        // would authenticate them into a tenant nobody admitted them to, which
        // is the hole this closes, and a bare 401 would tell them nothing they
        // could act on. Let it through as the 403 it is — the message names
        // the way in.
        console.warn(`[auth] ${error.message}`);
        throw error;
      }
      if (error instanceof SessionAuthenticationUnavailableError) {
        // The token verified; the record that says whether this tenant
        // admitted the person and which roles they hold here could not be
        // read. Not an anonymous session and not a token-only one: 503.
        console.warn(`[auth] ${error.message}`);
        throw error;
      }
      if (error instanceof OrganizationBindingError) {
        // The token verified; it is just not a token for this resource. The
        // caller answers with the scopes to request rather than a bare 401,
        // and the log keeps the reason the caller must not learn.
        console.warn(
          `[auth] Bearer token refused on organization resource ${options.organization?.resource}: ${error.reason}.`,
        );
        throw error;
      }
      console.warn(
        "[auth] Bearer verification failed:",
        error instanceof Error ? error.message : String(error),
      );
      if (options.failOnUnavailable && bearerVerifierUnavailable(error)) {
        throw new SessionAuthenticationUnavailableError();
      }
      return EMPTY_SESSION;
    }
  }

  if (options.organization || options.requiredAudience !== undefined || hostOrganizationContext()) {
    // Trusted-context headers name a tenant directly; they cannot prove
    // selected membership or resource audience. Strict endpoints refuse them.
    return EMPTY_SESSION;
  }

  return readTrustedSessionContext(headers);
}
