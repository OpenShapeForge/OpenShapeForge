// SPDX-License-Identifier: BUSL-1.1
/**
 * The one credential this process presents to the TENANT realm, and the
 * plumbing every call across that boundary shares.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The control plane reaches the tenant realm over TWO Keycloak surfaces:
 *
 *   - the identity-configuration SPI (`keycloak-spi-client.ts`), for the
 *     organization hierarchy Keycloak has no concept of; and
 *   - Keycloak's own admin API (`keycloak-organization-admin.ts`), for
 *     `OrganizationModel.enabled`, which Keycloak ships and the SPI therefore
 *     has no business duplicating.
 *
 * Both authenticate as the SAME `openshapeforge-auth-api` service account
 * against the SAME realm. If each minted its own token they would also each
 * cache one, and — worse than the redundant grant — a 401 that invalidated one
 * cache would leave the other holding a credential Keycloak has already
 * refused. One provider, one cache, one invalidation point.
 *
 * WHY THE ERROR TYPES ARE INJECTED
 * --------------------------------
 * A token failure has to surface as the CALLER'S error type, because the two
 * surfaces answer with distinct code families (`KEYCLOAK_SPI_*` vs
 * `KEYCLOAK_ADMIN_*`) and a route maps the code to a status. Rather than have
 * every caller catch and re-wrap, the provider is handed the two constructors
 * it can possibly need. Nothing about "which surface am I" leaks in here.
 */

export type KeycloakServiceAccountConfig = {
  /** Keycloak origin, no trailing slash. */
  baseUrl: string;
  /** The realm holding tenant Organizations and the SPI. */
  tenantRealm: string;
  clientId: string;
  clientSecret: string;
};

/**
 * Refresh this far before the token actually expires. A client-credentials
 * token is short-lived (the realm sets 900s), and a request that starts with 2
 * seconds of validity left can still arrive expired.
 */
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

/** Bound the wait on Keycloak so a hung realm cannot pin a control-plane request. */
export const REQUEST_TIMEOUT_MS = 10_000;

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 200) };
  }
}

/**
 * The SPI answers `{"error": "..."}` for its own refusals and Keycloak answers
 * `{"error": "...", "error_description": "..."}` or `{"errorMessage": "..."}`
 * for the ones it raises before the resource is reached. Surfaced verbatim
 * because every one of them is a deployment- or input-level fact an operator
 * needs; none of them carry tenant data.
 */
export function describeError(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["error_description", "errorMessage", "error", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return fallback;
}

export type ServiceAccountTokenOptions = {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
  /** The caller's error for "Keycloak refused this credential". */
  unauthorized: (message: string, status?: number) => Error;
  /** The caller's error for "Keycloak could not be reached or made no sense". */
  unavailable: (message: string, status?: number) => Error;
};

export type ServiceAccountTokenProvider = {
  /** A valid access token, minted or cached. */
  get(): Promise<string>;
  /**
   * Drop the cached token. Called when Keycloak answers 401/403 to a request
   * that carried it, so a rotated credential is picked up without a restart.
   */
  invalidate(): void;
};

export function createServiceAccountTokenProvider(
  config: KeycloakServiceAccountConfig,
  options: ServiceAccountTokenOptions,
): ServiceAccountTokenProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const tokenUrl = `${config.baseUrl}/realms/${encodeURIComponent(config.tenantRealm)}/protocol/openid-connect/token`;

  // Single-flight token cache. Two concurrent provisioning calls must not mint
  // two tokens, and — more importantly — must not race such that one of them
  // uses a token the other has already replaced.
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function requestToken(): Promise<string> {
    // Loud rather than a silent no-op: an unset secret is the failure mode where
    // the database half of provisioning succeeds and the Keycloak half never
    // happens, which is precisely the drift this whole design is built to avoid.
    if (!config.clientSecret || config.clientSecret.trim().length === 0) {
      throw options.unauthorized(
        `No client secret is configured for "${config.clientId}". Set ` +
          "KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API to the tenant realm's " +
          "service-account secret; provisioning cannot reach Keycloak without it.",
      );
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    let response: Response;
    try {
      response = await doFetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw options.unavailable(
        `Could not reach Keycloak at ${tokenUrl} to obtain a service-account token: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const payload = await readJson(response);
    if (!response.ok) {
      throw options.unauthorized(
        `Client credentials for "${config.clientId}" were rejected by realm ` +
          `"${config.tenantRealm}": ${describeError(payload, response.statusText)}`,
        response.status,
      );
    }

    const record = (payload ?? {}) as Record<string, unknown>;
    const accessToken = record.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw options.unavailable(
        "Keycloak's token response carried no access_token.",
        response.status,
      );
    }
    // Absent expires_in would otherwise cache forever; treat it as already
    // expiring so the next call re-mints rather than reusing a token of unknown
    // lifetime.
    const expiresIn = typeof record.expires_in === "number" ? record.expires_in : 0;
    cached = {
      token: accessToken,
      expiresAtMs: now() + Math.max(0, expiresIn * 1000 - TOKEN_EXPIRY_MARGIN_MS),
    };
    return accessToken;
  }

  return {
    async get(): Promise<string> {
      if (cached && cached.expiresAtMs > now()) return cached.token;
      if (!inFlight) {
        inFlight = requestToken().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
