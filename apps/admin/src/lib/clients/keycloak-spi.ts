// SPDX-License-Identifier: BUSL-1.1
import "server-only";

/**
 * The Keycloak SPI client — the ONLY module in this app that may talk to the
 * TENANT realm.
 *
 * ── Why this is a separate module from control-api.ts ───────────────────────
 *
 * Cross-realm is forced, not chosen. The SPI (`OpenShapeForgeResource`) is a
 * Keycloak `RealmResourceProvider`, and its `requireAdminBearer()` authenticates
 * the bearer against `session.getContext().getRealm()` — the TARGET realm. An
 * operator's control-realm token therefore can NEVER call the SPI on the tenant
 * realm, no matter how it is forwarded. The operator's identity and the SPI's
 * caller identity are two different things reaching two different realms, which
 * is precisely why they are two different client modules rather than one client
 * with two base URLs.
 *
 * The identity that CAN call it is the `openshapeforge-auth-api` service
 * account, authored in `packages/compiler/config/authoring/authorization.yaml`
 * with realm-management `manage-realm` — the role the SPI's authorization check
 * demands. This module client-credentials as that account. The operator's own
 * token is never forwarded.
 *
 * ── Nothing calls this yet, and that is not an oversight ────────────────────
 *
 * Per the plan (#286), S3 (#289) builds provisioning API-side: create tenant →
 * `platform.tenants` under `withSystemSession` → SPI call → store
 * `keycloak_organization_id`. So the provisioning SPI calls belong to `apps/api`,
 * and this app reaches them through control-api.ts.
 *
 * What this module is for is the boundary itself. #290 asks for the SPI client
 * isolated in one module so that IF the control plane ever needs to reach the
 * SPI directly — a read-only drift check for S7's reconciliation report is the
 * obvious candidate, since that compares Keycloak against the DB and has no
 * business round-tripping through the provisioning path — it lands here and
 * nowhere else. Extracting or re-pointing it stays mechanical.
 *
 * ── Fail-closed by default ──────────────────────────────────────────────────
 *
 * There is no credential fallback. The service-account secret has to be
 * configured explicitly, so a misconfigured deployment cannot silently reach a
 * tenant realm with a dev credential; it refuses instead. Unset is the expected
 * state today.
 */

/** Path segment Keycloak mounts the SPI under: `OpenShapeForgeResourceProviderFactory.ID`. */
const SPI_PROVIDER_ID = "openshapeforge";

const DEFAULT_TENANT_REALM_ISSUER = "http://localhost:8181/realms/openshapeforge";
const DEFAULT_SPI_CLIENT_ID = "openshapeforge-auth-api";

export interface SpiConfig {
  /** Tenant-realm issuer, e.g. http://localhost:8181/realms/openshapeforge */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve the SPI configuration, or explain exactly what is missing.
 *
 * Returns a discriminated result rather than throwing, so a caller such as a
 * future drift report can render "SPI access is not configured" instead of a
 * 500 — an unconfigured integration is a state to display, not a crash.
 */
export function resolveSpiConfig():
  | { ok: true; config: SpiConfig }
  | { ok: false; reason: string } {
  const clientSecret = process.env.OPENSHAPEFORGE_SPI_CLIENT_SECRET;
  if (!clientSecret?.trim()) {
    return {
      ok: false,
      reason:
        "OPENSHAPEFORGE_SPI_CLIENT_SECRET is not set; the control plane has no tenant-realm service-account credential.",
    };
  }

  const issuer =
    process.env.OPENSHAPEFORGE_TENANT_REALM_ISSUER ?? DEFAULT_TENANT_REALM_ISSUER;
  return {
    ok: true,
    config: {
      issuer: issuer.endsWith("/") ? issuer.slice(0, -1) : issuer,
      clientId: process.env.OPENSHAPEFORGE_SPI_CLIENT_ID ?? DEFAULT_SPI_CLIENT_ID,
      clientSecret: clientSecret.trim(),
    },
  };
}

/** `/realms/<tenant-realm>/openshapeforge/<path>` — where the SPI actually lives. */
export function buildSpiUrl(config: SpiConfig, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${config.issuer}/${SPI_PROVIDER_ID}${suffix}`;
}

interface CachedToken {
  /**
   * Which credential minted it. Keyed, not just stored: the cache must not
   * hand a token minted for one realm/client to a call configured for
   * another — that would be an authorization bug wearing a performance
   * optimisation's clothes.
   */
  key: string;
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

function credentialKey(config: SpiConfig): string {
  return `${config.issuer}|${config.clientId}`;
}

/** Refresh this many seconds before expiry so an in-flight call cannot straddle it. */
const TOKEN_REFRESH_BUFFER_S = 30;

/**
 * Client-credentials token for the tenant realm's service account.
 *
 * Cached in-process until shortly before expiry. This is a machine-to-machine
 * credential with no user behind it, so there is no session to key it by and
 * no refresh token to rotate — re-requesting is the whole refresh story.
 */
export async function getSpiServiceAccountToken(config: SpiConfig): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  const key = credentialKey(config);
  if (
    cachedToken &&
    cachedToken.key === key &&
    cachedToken.expiresAt - nowS > TOKEN_REFRESH_BUFFER_S
  ) {
    return cachedToken.accessToken;
  }

  const response = await fetch(`${config.issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    // The status, never the body: a token endpoint's error body can echo the
    // request, and the request carries the client secret.
    throw new Error(
      `[admin-spi] client_credentials failed for ${config.clientId}: HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("[admin-spi] client_credentials response carried no access_token");
  }

  const expiresIn =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : 60;
  cachedToken = { key, accessToken: payload.access_token, expiresAt: nowS + expiresIn };
  return cachedToken.accessToken;
}

/** Test/dev hook: drop the cached service-account token. */
export function resetSpiTokenCache(): void {
  cachedToken = null;
}

/**
 * Call the SPI as the tenant-realm service account.
 *
 * The single transport, for the same reason control-api.ts has one: so the
 * bearer is attached in exactly one place and no caller can forget it, or
 * worse, substitute the operator's own token — which the SPI would reject
 * anyway, but only after it had been sent across a realm boundary.
 */
export async function callSpi(path: string, init: RequestInit = {}): Promise<Response> {
  const resolved = resolveSpiConfig();
  if (!resolved.ok) {
    throw new Error(`[admin-spi] ${resolved.reason}`);
  }

  const token = await getSpiServiceAccountToken(resolved.config);
  return fetch(buildSpiUrl(resolved.config, path), {
    ...init,
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...init.headers,
      authorization: `Bearer ${token}`,
    },
  });
}
