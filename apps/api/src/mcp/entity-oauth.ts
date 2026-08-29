// SPDX-License-Identifier: BUSL-1.1
/**
 * Personal OAuth connections for derived tools — the authorization-code
 * flow, gated by the definition chain.
 *
 * The rule this module enforces (agreed product boundary): only a projected
 * (published, audience-visible) definition row may start a personal
 * connection. The provider, endpoints and scopes derive from the row's
 * execution chain; the person chooses nothing. The resulting connection row
 * is bound to tenant AND user, its tokens encrypted like every other
 * elicited secret.
 *
 * Flow:
 *   1. connect tool → validate chain → PKCE authorization URL + state,
 *      returned for the CALLER to open in a browser.
 *   2. Provider redirects to the unauthenticated callback with code+state.
 *      The callback trusts nothing in its query beyond looking up the
 *      single-use state row minted in step 1; everything else — token
 *      endpoint, client credentials, tenant, user — comes from that row.
 *   3. Tokens are exchanged (egress-checked) and stored encrypted on a
 *      personal connection row; execution resolves that row for its owner.
 *
 * Pending states live in process memory with a short TTL: they are
 * ephemeral by design, and like the MCP session map this makes the flow
 * single-replica — a multi-replica deployment needs affinity or a table.
 */
import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../rest/http-error.js";
import { hostAllowed } from "../connectors/executor.js";
import {
  encryptSecret,
  keyringFromEnv,
  type SecretKeyring,
} from "../connectors/secrets.js";

type JsonRecord = Record<string, unknown>;

// The person behind this link may first be routed through the provider's own
// login (password manager, second factor) before the consent screen; ten
// minutes proved too short for that in live testing, matching what the
// elicitation and configuration-handoff windows already learned.
const STATE_TTL_MS = 30 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 15_000;
const KEYRING_ENV = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";

export type PendingAuthorization = {
  state: string;
  codeVerifier: string;
  tenantId: string;
  userId: string;
  /** Physical table + row id of the provider the connection is for. */
  providerTable: string;
  providerRowId: string;
  /** Where the resulting connection row is written. */
  connectionTable: string;
  connectionProviderRef: string;
  connectionValuesField: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  egress: string[];
  scopes: string[];
  redirectUri: string;
  /** Human name for the completion page. */
  providerName: string;
  /** "user": tokens land on the caller's personal row; "tenant": on the tenant row. */
  connectionScope: "user" | "tenant";
  expiresAtMs: number;
};

const pendingByState = new Map<string, PendingAuthorization>();

function sweep(): void {
  const now = Date.now();
  for (const [state, pending] of pendingByState) {
    if (pending.expiresAtMs < now) pendingByState.delete(state);
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint the handoff: single-use state + PKCE pair, provider authorization URL.
 * The caller opens the URL; nothing here performs network I/O.
 */
export function mintAuthorization(
  input: Omit<PendingAuthorization, "state" | "codeVerifier" | "expiresAtMs"> & {
    authorizationUrl: string;
  },
): { authorizationUrl: string; state: string; expiresInSeconds: number } {
  sweep();
  const state = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(codeVerifier).digest());

  const url = new URL(input.authorizationUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "PROVIDER_MISCONFIGURED", "Authorization URL must be http(s).");
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (input.scopes.length > 0) url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  pendingByState.set(state, {
    ...input,
    state,
    codeVerifier,
    expiresAtMs: Date.now() + STATE_TTL_MS,
  });
  return {
    authorizationUrl: url.toString(),
    state,
    expiresInSeconds: STATE_TTL_MS / 1000,
  };
}

/**
 * Whether a connection's granted scopes cover the currently required set.
 * A row without recorded grants (created before grants were stored) is
 * assumed covering — forcing every legacy connection through a surprise
 * re-consent would be worse than trusting it until a call proves otherwise.
 */
export function scopesCovered(required: readonly string[], granted: unknown): boolean {
  if (!Array.isArray(granted)) return true;
  const have = new Set(granted.filter((scope): scope is string => typeof scope === "string"));
  return required.every((scope) => have.has(scope));
}

/** Single use: reading a state consumes it, valid or not. */
export function redeemState(state: unknown): PendingAuthorization | null {
  sweep();
  if (typeof state !== "string" || state.length === 0) return null;
  const pending = pendingByState.get(state);
  if (pending) pendingByState.delete(state);
  return pending ?? null;
}

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
    throw new HttpError(403, "EGRESS_DENIED", "Token endpoint is outside the provider's egress allow-list.");
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    client_secret: pending.clientSecret,
    code_verifier: pending.codeVerifier,
  });
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(502, "TOKEN_ENDPOINT_ERROR", `Token endpoint answered ${response.status}.`);
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
    throw new HttpError(502, "TOKEN_ENDPOINT_ERROR", "Token endpoint response is not JSON.");
  }
  if (typeof payload.access_token !== "string") {
    throw new HttpError(502, "TOKEN_ENDPOINT_ERROR", "Token endpoint returned no access_token.");
  }

  const scope = `${pending.connectionTable}:personal`;
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
    accessToken: encryptSecret(keyring, scope, "accessToken", payload.access_token),
    ...(typeof payload.refresh_token === "string"
      ? { refreshToken: encryptSecret(keyring, scope, "refreshToken", payload.refresh_token) }
      : {}),
    ...(typeof payload.expires_in === "number"
      ? { accessTokenExpiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString() }
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
}): Promise<ExchangedTokens> {
  const keyring = input.keyring ?? keyringFromEnv(process.env[KEYRING_ENV]);
  if (!keyring) {
    throw new HttpError(500, "SECRET_KEYRING_MISSING", `Set ${KEYRING_ENV}.`);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const tokenUrl = new URL(input.tokenUrl);
  if (
    (tokenUrl.protocol !== "https:" && tokenUrl.protocol !== "http:") ||
    !hostAllowed(tokenUrl.hostname, input.egress)
  ) {
    throw new HttpError(403, "EGRESS_DENIED", "Token endpoint is outside the provider's egress allow-list.");
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(502, "TOKEN_ENDPOINT_ERROR", `Token refresh answered ${response.status}.`);
  }
  let payload: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new HttpError(502, "TOKEN_ENDPOINT_ERROR", "Token refresh response is not JSON.");
  }
  if (typeof payload.access_token !== "string") {
    throw new HttpError(502, "TOKEN_ENDPOINT_ERROR", "Token refresh returned no access_token.");
  }
  const scope = `${input.connectionTable}:personal`;
  return {
    values: {
      accessToken: encryptSecret(keyring, scope, "accessToken", payload.access_token),
      refreshToken:
        typeof payload.refresh_token === "string"
          ? encryptSecret(keyring, scope, "refreshToken", payload.refresh_token)
          : encryptSecret(keyring, scope, "refreshToken", input.refreshToken),
      ...(typeof payload.expires_in === "number"
        ? { accessTokenExpiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString() }
        : {}),
    },
  };
}

/** Test-only view of the pending store. */
export const __pendingForTests = pendingByState;
