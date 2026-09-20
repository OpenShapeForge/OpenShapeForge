// SPDX-License-Identifier: BUSL-1.1
/**
 * The token half of the entity OAuth flow: exchanging the authorization
 * code at the provider and refreshing an expired access token, both
 * encrypting what they store. The pending-authorization state (mint,
 * redeem) stays in entity-oauth.ts. Split out of it, verbatim.
 */

import { hostAllowed } from "../connectors/executor.js";
import { refreshOAuthTokenSet } from "../connectors/token-lifecycle.js";
import type { SecretKeyring } from "../connectors/secrets.js";
import { fetchWithAllowedRedirects } from "./declarative-execution.js";
import { encryptSecret, keyringFromEnv } from "../connectors/secrets.js";
import { OAuthTokenLifecycleError } from "../connectors/token-lifecycle.js";
import { HttpError } from "../rest/http-error.js";
import { type ModuleEgressDispatch } from "../modules/egress.js";
import {
  KEYRING_ENV,
  TOKEN_TIMEOUT_MS,
  type JsonRecord,
  type PendingAuthorization,
} from "./entity-oauth.js";
import { connectionTokenSecretScope } from "../connectors/secrets.js";
export type ExchangedTokens = {
  values: JsonRecord;
};

/**
 * Exchange the authorization code and shape the stored connection values:
 * tokens encrypted with the platform keyring, expiry stored plain. Fails
 * closed without a keyring — a plaintext token at rest is never acceptable.
 */
export async function exchangeCodeForTokens(
  pending: PendingAuthorization,
  code: string,
  fetchImpl: typeof fetch = fetch,
  keyring: SecretKeyring | undefined = keyringFromEnv(process.env[KEYRING_ENV]),
  egress?: ModuleEgressDispatch,
): Promise<ExchangedTokens> {
  if (!keyring) {
    throw new HttpError(
      500,
      "SECRET_KEYRING_MISSING",
      `Personal connections store encrypted tokens; set ${KEYRING_ENV}.`,
    );
  }
  const tokenUrl = new URL(pending.tokenUrl);
  if (
    (tokenUrl.protocol !== "https:" && tokenUrl.protocol !== "http:") ||
    !hostAllowed(tokenUrl.hostname, pending.egress)
  ) {
    throw new HttpError(
      403,
      "EGRESS_DENIED",
      "Token endpoint is outside the provider's egress allow-list.",
    );
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    client_secret: pending.clientSecret,
    code_verifier: pending.codeVerifier,
  });
  const response = await fetchWithAllowedRedirects(
    tokenUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    },
    pending.egress,
    fetchImpl,
    egress,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      502,
      "TOKEN_ENDPOINT_ERROR",
      `Token endpoint answered ${response.status}.`,
    );
  }
  let payload: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new HttpError(
      502,
      "TOKEN_ENDPOINT_ERROR",
      "Token endpoint response is not JSON.",
    );
  }
  if (typeof payload.access_token !== "string") {
    throw new HttpError(
      502,
      "TOKEN_ENDPOINT_ERROR",
      "Token endpoint returned no access_token.",
    );
  }

  const scope = connectionTokenSecretScope(pending.connectionTable);
  const values: JsonRecord = {
    // Which scopes the provider actually granted: the token response's
    // `scope` when present, else the requested set. The connect flow
    // compares this against a definition's CURRENT requirements, so a scope
    // change after consent triggers a fresh approval instead of silently
    // reusing a token that can no longer satisfy the tool.
    grantedScopes:
      typeof payload.scope === "string"
        ? payload.scope.split(" ").filter(Boolean)
        : [...pending.scopes],
    accessToken: encryptSecret(
      keyring,
      scope,
      "accessToken",
      payload.access_token,
    ),
    ...(typeof payload.refresh_token === "string"
      ? {
          refreshToken: encryptSecret(
            keyring,
            scope,
            "refreshToken",
            payload.refresh_token,
          ),
        }
      : {}),
    ...(typeof payload.expires_in === "number"
      ? {
          accessTokenExpiresAt: new Date(
            Date.now() + payload.expires_in * 1000,
          ).toISOString(),
        }
      : {}),
  };
  return { values };
}

/** Refresh an expired access token in place; returns the new values. */
export async function refreshTokens(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  egress: string[];
  connectionTable: string;
  fetchImpl?: typeof fetch;
  keyring?: SecretKeyring | undefined;
  moduleEgress?: ModuleEgressDispatch | undefined;
}): Promise<ExchangedTokens> {
  const keyring = input.keyring ?? keyringFromEnv(process.env[KEYRING_ENV]);
  if (!keyring) {
    throw new HttpError(500, "SECRET_KEYRING_MISSING", `Set ${KEYRING_ENV}.`);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const refreshed = await refreshOAuthTokenSet({
      tokenUrl: input.tokenUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken: input.refreshToken,
      boundFetch: (url, init) =>
        fetchWithAllowedRedirects(
          url instanceof Request ? url.url : url,
          { ...init, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) },
          input.egress,
          fetchImpl,
          input.moduleEgress,
        ),
    });
    const scope = connectionTokenSecretScope(input.connectionTable);
    return {
      values: {
        accessToken: encryptSecret(
          keyring,
          scope,
          "accessToken",
          refreshed.accessToken,
        ),
        refreshToken: encryptSecret(
          keyring,
          scope,
          "refreshToken",
          refreshed.refreshToken!,
        ),
        accessTokenExpiresAt: new Date(
          refreshed.expiresAt * 1000,
        ).toISOString(),
      },
    };
  } catch (error) {
    if (!(error instanceof OAuthTokenLifecycleError)) throw error;
    throw new HttpError(
      error.code === "REAUTHORIZATION_REQUIRED" ? 403 : 502,
      error.code === "REAUTHORIZATION_REQUIRED"
        ? "REAUTHORIZATION_REQUIRED"
        : "TOKEN_ENDPOINT_ERROR",
      error.message,
    );
  }
}
