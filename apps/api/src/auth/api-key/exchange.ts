// SPDX-License-Identifier: BUSL-1.1
/**
 * Turning a resolved integration into a Keycloak access token.
 *
 * This is the step that keeps an API key from becoming a second source of
 * truth for roles. The key names an integration; the integration's service
 * account is the identity; Keycloak decides what that identity may do. The
 * token this module returns is then verified by the SAME bearer verifier an
 * interactive caller's token goes through, so audience pinning, composite
 * expansion and the `tid`/`groups` claims all behave identically.
 *
 * The cache is what makes that affordable. Without it every request would cost
 * a token endpoint round trip; with it, a busy integration pays once per token
 * lifetime (900s in the generated realm).
 */
import type { SecretKeyring } from "../../platform/secrets.js";
import { decryptSecret, type StoredSecret } from "../../platform/secrets.js";

export type ExchangeConfig = {
  /** Keycloak issuer, e.g. https://keycloak.example/realms/openshapeforge */
  issuer: string;
  keyring: SecretKeyring;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
};

type CacheEntry = {
  token: string;
  /** Epoch ms after which this entry must not be served. */
  expiresAtMs: number;
};

/**
 * Shaved off every cached token's lifetime so a token is never handed out with
 * so little left that it expires in flight at the verifier.
 */
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

/** Floor on a cache entry's life, so a pathological `expires_in` cannot thrash. */
const MIN_CACHE_MS = 5_000;

const cache = new Map<string, CacheEntry>();

/** In-flight exchanges, so N concurrent requests for one integration do one fetch. */
const inFlight = new Map<string, Promise<string | undefined>>();

/** Test-only: drop cached tokens so a test can observe a fresh exchange. */
export function __resetExchangeCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export class ApiKeyExchangeError extends Error {
  readonly code = "API_KEY_EXCHANGE_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyExchangeError";
  }
}

type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
};

/**
 * Obtain an access token for an integration's service account.
 *
 * Returns undefined when Keycloak refuses the grant — a disabled client, a
 * rotated secret, a client that no longer exists. That is a normal outcome of a
 * credential whose backing identity has been withdrawn, and the caller turns it
 * into the same 401 as any other rejection rather than a 500.
 */
export async function exchangeForToken(
  config: ExchangeConfig,
  integrationId: string,
  keycloakClientId: string,
  clientSecret: StoredSecret,
  nowMs: number = Date.now(),
): Promise<string | undefined> {
  const cached = cache.get(integrationId);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.token;
  }

  const pending = inFlight.get(integrationId);
  if (pending) return pending;

  const exchange = performExchange(config, integrationId, keycloakClientId, clientSecret, nowMs)
    .finally(() => {
      inFlight.delete(integrationId);
    });
  inFlight.set(integrationId, exchange);
  return exchange;
}

async function performExchange(
  config: ExchangeConfig,
  integrationId: string,
  keycloakClientId: string,
  clientSecret: StoredSecret,
  nowMs: number,
): Promise<string | undefined> {
  // The AAD binds the ciphertext to this integration and this field, so a row
  // copied from another integration fails here rather than yielding a token for
  // the wrong client.
  const secret = decryptSecret(config.keyring, integrationId, "clientSecret", clientSecret);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: keycloakClientId,
    client_secret: secret,
  });

  const doFetch = config.fetch ?? fetch;
  const response = await doFetch(`${config.issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    // The response body carries Keycloak's error detail, which for a bad
    // client secret names the client. Not logged: it would put a credential
    // hint in the log for anyone who can present a well-formed key.
    return undefined;
  }

  const payload = (await response.json()) as TokenResponse;
  const token = typeof payload.access_token === "string" ? payload.access_token : undefined;
  if (!token) return undefined;

  const expiresInSeconds =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 60;
  const lifetimeMs = Math.max(
    MIN_CACHE_MS,
    expiresInSeconds * 1000 - EXPIRY_SAFETY_MARGIN_MS,
  );

  cache.set(integrationId, { token, expiresAtMs: nowMs + lifetimeMs });
  return token;
}

/**
 * Drop an integration's cached token.
 *
 * Called when an integration is disabled or its roles change, so a narrowing
 * takes effect on the next request instead of at the end of the token's life.
 */
export function invalidateIntegrationToken(integrationId: string): void {
  cache.delete(integrationId);
}
