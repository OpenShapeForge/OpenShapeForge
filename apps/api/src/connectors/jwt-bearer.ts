// SPDX-License-Identifier: BUSL-1.1
/**
 * Google service-account OAuth JWT-bearer token acquisition (RFC 7523).
 *
 * A service account authenticates by signing a JWT assertion with its own
 * private key and exchanging it at Google's token endpoint for a short-lived
 * access token. No user consent, no refresh token, no browser redirect. The
 * service account accesses only calendars explicitly shared with its
 * client_email — domain-wide impersonation is deliberately unsupported.
 *
 * The token endpoint is pinned to Google's canonical URL. A credential file's
 * `token_uri` is validated against this pin; a mismatch is refused rather than
 * followed, because trusting a user-supplied endpoint would let a crafted
 * credential file redirect the signed assertion to an attacker.
 *
 * Token caching requires a trusted tenant/source partition and also binds the
 * key material and scopes. Expiry includes leeway so a token
 * that is valid when cached cannot expire in transit.
 */
import { importPKCS8, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { readBoundedResponse } from "../modules/outbound-response.js";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWT_LIFETIME_SECONDS = 3600;
const CACHE_LEEWAY_SECONDS = 60;
const MAX_SCOPES = 16;
const MAX_SCOPE_LENGTH = 256;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export class JwtBearerError extends Error {
  readonly code: "JWT_BEARER_CONFIGURATION" | "JWT_BEARER_TOKEN_FAILED";

  constructor(code: JwtBearerError["code"], message: string) {
    super(message);
    this.name = "JwtBearerError";
    this.code = code;
  }
}

export type ServiceAccountCredential = {
  clientEmail: string;
  privateKey: string;
  scopes: readonly string[];
};

export type JwtBearerTokenInput = {
  credential: ServiceAccountCredential;
  /** Host-minted tenant and source partition; without one do not cache. */
  cachePartition?: string;
  boundFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: number;
  signal?: AbortSignal;
};

export type JwtBearerTokenResult = {
  accessToken: string;
  expiresAt: number;
};

/**
 * Validate that a credential file's token_uri matches the pinned endpoint.
 * A mismatch is a configuration error, not a silent redirect.
 */
export function assertGoogleTokenUri(tokenUri: unknown): void {
  if (typeof tokenUri === "string" && tokenUri !== GOOGLE_TOKEN_ENDPOINT) {
    throw new JwtBearerError(
      "JWT_BEARER_CONFIGURATION",
      "Only the canonical Google OAuth2 token endpoint is supported.",
    );
  }
}

function validateScopes(scopes: readonly string[]): void {
  if (scopes.length === 0) {
    throw new JwtBearerError(
      "JWT_BEARER_CONFIGURATION",
      "At least one OAuth scope is required for a service account.",
    );
  }
  if (scopes.length > MAX_SCOPES) {
    throw new JwtBearerError(
      "JWT_BEARER_CONFIGURATION",
      `Too many scopes (${scopes.length}); the maximum is ${MAX_SCOPES}.`,
    );
  }
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.length === 0 || scope.length > MAX_SCOPE_LENGTH) {
      throw new JwtBearerError(
        "JWT_BEARER_CONFIGURATION",
        "Each scope must be a non-empty string of reasonable length.",
      );
    }
    if (/\s/.test(scope)) {
      throw new JwtBearerError(
        "JWT_BEARER_CONFIGURATION",
        "Individual scopes must not contain whitespace; pass them as separate array entries.",
      );
    }
  }
}

function validateClientEmail(email: string): void {
  if (
    typeof email !== "string" ||
    email.length === 0 ||
    email.length > 256 ||
    !email.includes("@")
  ) {
    throw new JwtBearerError(
      "JWT_BEARER_CONFIGURATION",
      "Service account client_email is missing or invalid.",
    );
  }
}

function validatePrivateKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new JwtBearerError(
      "JWT_BEARER_CONFIGURATION",
      "Service account private key is missing.",
    );
  }
  if (
    !key.includes("-----BEGIN") ||
    !key.includes("PRIVATE KEY")
  ) {
    throw new JwtBearerError(
      "JWT_BEARER_CONFIGURATION",
      "Service account private key does not look like a PEM-encoded private key.",
    );
  }
}

/**
 * Build the signed JWT assertion for the Google token endpoint.
 *
 * Claims follow Google's service-account spec:
 * - `iss`: the service account's email
 * - `scope`: space-separated OAuth scopes
 * - `aud`: the token endpoint
 * - `iat`/`exp`: issued-at and expiry in epoch seconds
 *
 * No `sub` claim: domain-wide impersonation is not supported. The service
 * account accesses only resources explicitly shared with its identity.
 */
export async function buildServiceAccountAssertion(input: {
  clientEmail: string;
  privateKey: string;
  scopes: readonly string[];
  now: number;
}): Promise<string> {
  const iat = Math.floor(input.now / 1000);
  const exp = iat + JWT_LIFETIME_SECONDS;

  let key: CryptoKey;
  try {
    // Google JSON credentials store PEM line breaks as literal backslash-n.
    // A password input cannot retain pasted newlines, so accept that standard
    // single-line representation as well as the decoded PEM.
    key = await importPKCS8(input.privateKey.replace(/\\n/g, "\n"), "RS256");
  } catch (cause) {
    throw new JwtBearerError(
      "JWT_BEARER_CONFIGURATION",
      "Service account private key could not be imported as an RS256 key.",
    );
  }

  return new SignJWT({
    scope: input.scopes.join(" "),
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(input.clientEmail)
    .setAudience(GOOGLE_TOKEN_ENDPOINT)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
}

/**
 * Exchange a signed JWT assertion for an access token at the pinned
 * Google token endpoint.
 */
export async function exchangeJwtBearerAssertion(input: {
  assertion: string;
  boundFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now: number;
  signal?: AbortSignal;
}): Promise<JwtBearerTokenResult> {
  input.signal?.throwIfAborted();

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: input.assertion,
  });

  const response = await input.boundFetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  input.signal?.throwIfAborted();

  if (!response.ok) {
    throw new JwtBearerError(
      "JWT_BEARER_TOKEN_FAILED",
      `Google token endpoint returned status ${response.status}`,
    );
  }

  let payload: { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
  try {
    const text = await readBoundedResponse(response, MAX_TOKEN_RESPONSE_BYTES);
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new JwtBearerError(
      "JWT_BEARER_TOKEN_FAILED",
      "Google token endpoint returned an unreadable response.",
    );
  }

  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new JwtBearerError(
      "JWT_BEARER_TOKEN_FAILED",
      "Google token endpoint returned no access token.",
    );
  }

  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in) &&
    payload.expires_in > 0
      ? payload.expires_in
      : JWT_LIFETIME_SECONDS;

  return {
    accessToken: payload.access_token,
    expiresAt: Math.floor(input.now / 1000) + expiresIn,
  };
}

/**
 * The full JWT-bearer token acquisition: validate, sign, exchange.
 *
 * Callers use the returned token as a Bearer header. No refresh token is
 * involved; when the token expires the caller acquires a new one.
 */
export async function acquireJwtBearerToken(
  input: JwtBearerTokenInput,
): Promise<JwtBearerTokenResult> {
  const { credential } = input;
  const now = input.now ?? Date.now();

  validateClientEmail(credential.clientEmail);
  validatePrivateKey(credential.privateKey);
  validateScopes(credential.scopes);

  const assertion = await buildServiceAccountAssertion({
    clientEmail: credential.clientEmail,
    privateKey: credential.privateKey,
    scopes: credential.scopes,
    now,
  });

  return exchangeJwtBearerAssertion({
    assertion,
    boundFetch: input.boundFetch,
    now,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// In-process token cache
// ---------------------------------------------------------------------------

type CachedToken = { accessToken: string; expiresAtMs: number };

const tokenCache = new Map<string, CachedToken>();
const MAX_CACHE_ENTRIES = 256;

function cacheKey(credential: ServiceAccountCredential, partition: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([partition, credential.clientEmail, credential.privateKey, [...credential.scopes].sort()]),
    )
    .digest("hex");
}

/** Evict expired entries and return a valid cached token if one exists. */
function getCachedToken(key: string, now: number): string | undefined {
  for (const [k, entry] of tokenCache) {
    if (entry.expiresAtMs <= now) tokenCache.delete(k);
  }
  const entry = tokenCache.get(key);
  return entry && entry.expiresAtMs > now ? entry.accessToken : undefined;
}

function setCachedToken(key: string, result: JwtBearerTokenResult): void {
  if (tokenCache.size >= MAX_CACHE_ENTRIES) {
    tokenCache.delete(tokenCache.keys().next().value!);
  }
  tokenCache.set(key, {
    accessToken: result.accessToken,
    expiresAtMs: (result.expiresAt - CACHE_LEEWAY_SECONDS) * 1000,
  });
}

/**
 * Acquire a service-account access token, using the in-process cache when a
 * valid token exists. Never reuse a token without a trusted source partition.
 */
export async function cachedJwtBearerToken(
  input: JwtBearerTokenInput,
): Promise<string> {
  const now = input.now ?? Date.now();
  if (!input.cachePartition) return (await acquireJwtBearerToken({ ...input, now })).accessToken;
  const key = cacheKey(input.credential, input.cachePartition);
  const cached = getCachedToken(key, now);
  if (cached) return cached;

  const result = await acquireJwtBearerToken({ ...input, now });
  setCachedToken(key, result);
  return result.accessToken;
}

export const GOOGLE_TOKEN_URL = GOOGLE_TOKEN_ENDPOINT;

/** Test seam: clear the in-process token cache. */
export function __resetJwtBearerCacheForTests(): void {
  tokenCache.clear();
}
