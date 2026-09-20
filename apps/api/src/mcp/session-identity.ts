// SPDX-License-Identifier: BUSL-1.1
/**
 * The display facts a bearer token carries beyond what `TrustedSessionContext`
 * keeps (name, email, language, client, expiry, organization memberships),
 * and how they stay attached to a session.
 *
 * `rememberSessionIdentity` / `sessionIdentityOf` hold them beside the
 * verified session; `sessionLocale` runs the language fallback order in
 * `mcp/locale.ts` over the claim. The session context is shared with GraphQL
 * and REST and is kept minimal on purpose; rather than widening it, the MCP
 * entry point hands the already-verified request headers to this module,
 * which reads the token payload for display fields only. Verification
 * happened in `resolveSessionContext`; this module never trusts a claim for
 * authorization.
 *
 * Split out of `session-info.ts`, which projects these facts into the
 * `whoami` answer; `session-opening.ts` reads them for the sentence a session
 * starts with.
 */
import { selectOrganizationMembership } from "../auth/tenant-resolution.js";
import type { OrganizationResourceBinding } from "../auth/organization-binding.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { LOCALE_CLAIM, resolveLocale, type ResolvedLocale } from "./locale.js";

/**
 * The display facts of one session's credential. Present only what the
 * credential said about the person; the tenant and roles stay on the session
 * context, which is the authority for them.
 */
export type SessionIdentity = {
  credential: TrustedSessionContext["credential"];
  /** `name`, else `preferred_username`; null when the credential carries neither. */
  name: string | null;
  email: string | null;
  /** The OAuth client the token was issued to (`azp`); null when unknown. */
  authorizedParty: string | null;
  /**
   * The `locale` claim, exactly as the realm issued it (`nl`, `nl-NL`, …), or
   * null when the credential carries none. A display fact like `name` and
   * `email` beside it: `mcp/locale.ts` turns it into the language this session
   * is answered in, and nothing decides a permission by it.
   */
  locale: string | null;
  /** Token expiry in epoch milliseconds; null when the credential does not expire. */
  expiresAtMs: number | null;
  /**
   * Keycloak Organization memberships the token carries, by alias, with the
   * one the session's tenant was resolved from marked active. Empty for a
   * `tid`-style token or a non-bearer credential — the tenant row then stands
   * in as the only group.
   */
  organizations: Array<{ alias: string; active: boolean }>;
  /**
   * Alias of the organization whose per-organization endpoint
   * (`/<alias>`) the session was opened on; null on the
   * shared `/api/mcp` path. When set it is the active membership, whatever
   * scope the token also carries: the binding pinned the tenant.
   */
  boundOrganization: string | null;
};

const BEARER_AUTHORIZATION = /^Bearer\s+(.+)$/i;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Display facts from a verified bearer token's payload.
 *
 * Exported for tests. The caller is responsible for having verified the token
 * first — `resolveSessionContext` did, for the same `Authorization` header —
 * which is why this reads the payload without re-checking the signature: the
 * fields are used for display, never for a decision.
 */
export function identityFromBearerClaims(
  claims: Record<string, unknown>,
  binding: Pick<OrganizationResourceBinding, "alias"> | null = null,
): SessionIdentity {
  const rawOrganizations = claims.organization;
  const memberships: Record<
    string,
    { id: string | null; groups: string[]; roles: string[]; clientRoles: Record<string, string[]> }
  > = {};
  if (rawOrganizations !== null && typeof rawOrganizations === "object") {
    for (const [alias, membership] of Object.entries(
      rawOrganizations as Record<string, unknown>,
    )) {
      const id =
        membership !== null && typeof membership === "object"
          ? (membership as { id?: unknown }).id
          : undefined;
      memberships[alias] = {
        id: typeof id === "string" && id.length > 0 ? id : null,
        groups: [],
        roles: [],
        clientRoles: {},
      };
    }
  }
  const scopes = (stringClaim(claims, "scope") ?? "").split(/\s+/).filter(Boolean);
  const active = binding
    ? { alias: binding.alias }
    : selectOrganizationMembership({ organizations: memberships, scopes });
  const exp = claims.exp;
  return {
    credential: "bearer",
    name: stringClaim(claims, "name") ?? stringClaim(claims, "preferred_username"),
    email: stringClaim(claims, "email"),
    authorizedParty: stringClaim(claims, "azp"),
    locale: stringClaim(claims, LOCALE_CLAIM),
    expiresAtMs: typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null,
    organizations: Object.keys(memberships).map((alias) => ({
      alias,
      active: active?.alias === alias,
    })),
    boundOrganization: binding?.alias ?? null,
  };
}

/** The identity of a session whose credential carries no display facts. */
export function identityFromSession(session: TrustedSessionContext): SessionIdentity {
  return {
    credential: session.credential,
    name: null,
    email: null,
    authorizedParty: null,
    locale: null,
    expiresAtMs: null,
    organizations: [],
    boundOrganization: null,
  };
}

/**
 * The identity behind a resolved session, read from the request that produced
 * it. Only a bearer credential has a payload to read; an API key is opaque by
 * design, and a trusted-context session is the development identity.
 */
export function readSessionIdentity(
  session: TrustedSessionContext,
  headers: Headers,
  binding: Pick<OrganizationResourceBinding, "alias"> | null = null,
): SessionIdentity {
  if (session.credential !== "bearer") return identityFromSession(session);
  const authorization = headers.get("authorization") ?? "";
  const token = BEARER_AUTHORIZATION.exec(authorization)?.[1];
  const claims = token ? decodeJwtPayload(token) : null;
  return claims ? identityFromBearerClaims(claims, binding) : identityFromSession(session);
}

// The session context object is created once per request and, for a stateful
// MCP session, captured by the server built at `initialize`. Keying by that
// object ties the identity to exactly the session it was read for, with no
// registry to sweep: the entry goes when the session context does.
const identities = new WeakMap<TrustedSessionContext, SessionIdentity>();

/**
 * Attach the credential's display facts to a resolved session. `binding` is
 * the per-organization resource the request was addressed to, when it was
 * (the same value `resolveSessionContext` bound the session with).
 */
export function rememberSessionIdentity(
  session: TrustedSessionContext,
  headers: Headers,
  binding: Pick<OrganizationResourceBinding, "alias"> | null = null,
): void {
  identities.set(session, readSessionIdentity(session, headers, binding));
}

/** The facts attached by `rememberSessionIdentity`, or the credential-only floor. */
export function sessionIdentityOf(session: TrustedSessionContext): SessionIdentity {
  return identities.get(session) ?? identityFromSession(session);
}

/**
 * Move the display facts read for one request onto the session object a
 * stateful MCP server captured at `initialize`.
 *
 * A stateful session outlives many access tokens: the client refreshes
 * silently, so every later request carries a newer `exp`, but the server built
 * at `initialize` keeps answering `whoami` from the context object of that
 * first request. `rememberSessionIdentity` did run per request — under the new
 * request's own context, which nothing reads — so the reported expiry stayed
 * the first token's and went stale within minutes. Calling this on every reuse
 * keeps the answer as fresh as the credential the caller just presented.
 *
 * Only the credential's facts move. What the CLIENT said about itself at
 * `initialize` (`session-client.ts`) was said once, for the session, and stays
 * on the captured context.
 */
export function carrySessionIdentity(
  captured: TrustedSessionContext,
  current: TrustedSessionContext,
): void {
  if (captured === current) return;
  const identity = identities.get(current);
  if (identity) identities.set(captured, identity);
}

/**
 * The language this session reads: the person's own, else the realm's default,
 * else the host's — the order is written out in `mcp/locale.ts`. Every caller
 * that shows a person an authored text, or tells an assistant which language to
 * answer in, resolves it through here rather than reaching for the claim.
 */
export function sessionLocale(session: TrustedSessionContext): ResolvedLocale {
  return resolveLocale({ user: sessionIdentityOf(session).locale ?? session.locale });
}
