// SPDX-License-Identifier: BUSL-1.1
/**
 * The API key branch of session resolution.
 *
 * Order matters and is the whole security argument:
 *
 *   parse (checksum, no I/O)
 *     → resolve (indexed lookup + constant-time secret compare)
 *       → exchange (client_credentials for the integration's service account)
 *         → VERIFY (the existing bearer verifier, unchanged)
 *           → intersect (the key may narrow, never widen)
 *
 * The verify step is why a key is not a second source of truth for roles. What
 * comes back from Keycloak is an ordinary access token and it is checked like
 * an ordinary access token — same JWKS, same pinned audience, same claim
 * parsing. A key that named an integration whose service account has lost its
 * roles authorizes nothing, without anything here having to notice.
 *
 * Every failure returns undefined. The caller turns that into the same empty
 * session a failed bearer verification produces: no reason is disclosed, so a
 * holder cannot tell an unknown key from a revoked one from a disabled
 * integration.
 */
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { SecretKeyring } from "../../platform/secrets.js";
import type { SessionScope, TrustedSessionContext } from "../trusted-context.js";
import { exchangeForToken } from "./exchange.js";
import { parseApiKey } from "./format.js";
import { recordApiKeyUse, resolveApiKey } from "./store.js";

export type ApiKeyResolverDeps = {
  db: OpenShapeForgeDatabase;
  keyring: SecretKeyring;
  issuer: string;
  /** Verifies a Keycloak token exactly as the interactive bearer path does. */
  verifyToken: (token: string) => Promise<{
    tenantId: string | null;
    userId: string | null;
    roles: string[];
    scopes?: string[];
    groups: string[];
  }>;
  resolveScope: (roles: readonly string[], groups: readonly string[]) => SessionScope;
  fetch?: typeof fetch;
};

/**
 * Narrow an identity's roles by the key's declared subset.
 *
 * Intersection, never union — a subset naming a role the service account does
 * not hold contributes nothing. That is what makes a stored subset safe to
 * trust even if it was written before the integration's roles were reduced.
 */
export function intersectRoles(
  granted: readonly string[],
  subset: readonly string[] | null,
): string[] {
  if (subset === null) return [...granted];
  const grantedSet = new Set(granted);
  return subset.filter((role) => grantedSet.has(role));
}

export async function resolveApiKeySession(
  deps: ApiKeyResolverDeps,
  candidate: string,
): Promise<TrustedSessionContext | undefined> {
  const parsed = parseApiKey(candidate);
  if (!parsed) return undefined;

  const resolved = await resolveApiKey(deps.db, parsed.lookupId, parsed.secret);
  if (!resolved.ok) return undefined;
  const key = resolved.key;

  let token: string | undefined;
  try {
    token = await exchangeForToken(
      {
        issuer: deps.issuer,
        keyring: deps.keyring,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      },
      key.integrationId,
      key.keycloakClientId,
      key.clientSecret,
    );
  } catch (error) {
    // A decryption failure or an unreachable token endpoint. Neither is the
    // holder's fault and neither should be described to them.
    console.warn(
      "[auth] API key token exchange failed:",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
  if (!token) return undefined;

  let identity: Awaited<ReturnType<ApiKeyResolverDeps["verifyToken"]>>;
  try {
    identity = await deps.verifyToken(token);
  } catch (error) {
    console.warn(
      "[auth] API key exchanged a token that failed verification:",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }

  // The service account's own `tid` must agree with the tenant the credential
  // was issued under. A mismatch means the realm client was re-pointed at
  // another organization after provisioning — the credential is stale in a way
  // that would otherwise cross a tenant boundary.
  if (identity.tenantId !== key.tenantId) {
    console.warn(
      "[auth] API key tenant does not match its service account's tid; rejecting.",
    );
    return undefined;
  }
  if (!identity.userId) return undefined;

  const roles = intersectRoles(identity.roles, key.roleSubset);

  // Telemetry, never a gate: a failed write here must not fail an authenticated
  // request, and nothing on the hot path reads these columns back.
  void recordApiKeyUse(deps.db, key.keyId).catch((error: unknown) => {
    console.warn(
      "[auth] Recording API key use failed:",
      error instanceof Error ? error.message : String(error),
    );
  });

  return {
    tenantId: identity.tenantId,
    userId: identity.userId,
    roles,
    oauthScopes: identity.scopes ?? [],
    groups: identity.groups,
    scope: deps.resolveScope(roles, identity.groups),
    credential: "api-key",
  };
}
