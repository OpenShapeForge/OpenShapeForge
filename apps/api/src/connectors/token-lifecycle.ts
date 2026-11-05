// SPDX-License-Identifier: BUSL-1.1
import { readBoundedResponse } from "../modules/outbound-response.js";
/**
 * OAuth token mechanics shared by every platform-owned token store.
 *
 * Storage adapters own physical rows, encryption and transactions; this
 * module owns the canonical lifecycle state machine: lock-time re-read,
 * leeway, classification, exchange, rotation, persistence and audit order.
 * Keeping that boundary neutral lets connector installations and authored
 * connection rows share one refresh meaning without coupling storage models.
 */
export type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  /** The provider's stated scope, when its response carried one. */
  grantedScopes?: string[];
};

/** A parsed token endpoint response; `resource` and `aud` are provider extras. */
export type OAuthTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  resource?: unknown;
  aud?: unknown;
};

export type OAuthBoundFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class OAuthTokenLifecycleError extends Error {
  readonly code: "REAUTHORIZATION_REQUIRED" | "OAUTH_FAILED";

  constructor(code: OAuthTokenLifecycleError["code"], message: string) {
    super(message);
    this.name = "OAuthTokenLifecycleError";
    this.code = code;
  }
}

/**
 * Storage boundary for an authorization-code token set. The adapter owns its
 * physical row, encryption and transaction implementation; this module owns
 * every lifecycle decision so stores cannot drift on lock/re-read, leeway,
 * rotation or recovery behaviour.
 */
export type OAuthTokenLifecycleStore<TStored> = {
  withLockedRow<T>(work: () => Promise<T>): Promise<T>;
  read(): Promise<TStored | undefined>;
  decode(stored: TStored): Promise<OAuthTokenSet> | OAuthTokenSet;
  persist(tokens: OAuthTokenSet): Promise<void>;
  auditRefreshed(): Promise<void>;
  auditReauthorization(): Promise<void>;
};

function reauthorization(message: string): OAuthTokenLifecycleError {
  return new OAuthTokenLifecycleError("REAUTHORIZATION_REQUIRED", message);
}

/**
 * The canonical authorization-code refresh state machine.
 *
 * `withLockedRow` must acquire the store's row lock before running `work`.
 * The current row and the real clock are then read *inside* that lock, so a
 * waiter observes the winner's rotation rather than spending a stale refresh
 * token. Reauthorization audit intentionally runs after the failed lock
 * transaction has rolled back and is best-effort, preserving the stable
 * caller-facing outcome when journalling is unavailable.
 */
export async function ensureOAuthTokenSet<TStored>(input: {
  store: OAuthTokenLifecycleStore<TStored>;
  refreshLeewaySeconds?: number;
  tokenUrl: string;
  clientId: string;
  /** Absent for a public client, which identifies itself by client_id alone. */
  clientSecret?: string | undefined;
  /** RFC 8707 resource indicator; repeated so a refreshed token keeps its audience. */
  resource?: string | undefined;
  /** The server's metadata rules out this grant: go to consent, spend nothing. */
  refreshUnsupported?: boolean | undefined;
  verifyTokenResponse?: ((payload: OAuthTokenResponse) => void) | undefined;
  boundFetch: OAuthBoundFetch;
  now?: number;
  signal?: AbortSignal;
}): Promise<OAuthTokenSet> {
  input.signal?.throwIfAborted();
  try {
    return await input.store.withLockedRow(async () => {
      input.signal?.throwIfAborted();
      const stored = await input.store.read();
      input.signal?.throwIfAborted();
      if (stored === undefined) {
        throw reauthorization(
          "Stored OAuth tokens are missing; authorization is required again.",
        );
      }
      let tokens: OAuthTokenSet;
      try {
        tokens = await input.store.decode(stored);
      } catch (error) {
        if (error instanceof OAuthTokenLifecycleError) throw error;
        throw reauthorization(
          "Stored OAuth tokens are unreadable; authorization is required again.",
        );
      }

      // Preserve deterministic tests when `now` is supplied, but sample the
      // real clock only after the row lock for ordinary callers.
      const now = input.now ?? Date.now();
      if (
        !oauthTokenNeedsRefresh(
          tokens.expiresAt,
          input.refreshLeewaySeconds,
          now,
        )
      ) {
        return tokens;
      }
      if (!tokens.refreshToken) {
        throw reauthorization(
          "Stored OAuth tokens have no refresh token; authorization is required again.",
        );
      }
      if (input.refreshUnsupported) {
        throw reauthorization(
          "The authorization server offers no refresh grant; authorization is required again.",
        );
      }
      const refreshed = await refreshOAuthTokenSet({
        tokenUrl: input.tokenUrl,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        resource: input.resource,
        verifyTokenResponse: input.verifyTokenResponse,
        refreshToken: tokens.refreshToken,
        boundFetch: input.boundFetch,
        now,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      input.signal?.throwIfAborted();
      await input.store.persist(refreshed);
      input.signal?.throwIfAborted();
      await input.store.auditRefreshed();
      return refreshed;
    });
  } catch (error) {
    const normalized =
      error instanceof OAuthTokenLifecycleError
        ? error
        : error;
    if (
      normalized instanceof OAuthTokenLifecycleError &&
      normalized.code === "REAUTHORIZATION_REQUIRED"
    ) {
      try {
        await input.store.auditReauthorization();
      } catch {
        // A journal outage must not replace the durable recovery outcome.
      }
    }
    throw normalized;
  }
}

export function parseOAuthTokenSet(raw: string): OAuthTokenSet {
  let parsed: Partial<OAuthTokenSet>;
  try {
    parsed = JSON.parse(raw) as Partial<OAuthTokenSet>;
  } catch {
    throw new OAuthTokenLifecycleError(
      "REAUTHORIZATION_REQUIRED",
      "Stored OAuth tokens are unreadable; authorization is required again.",
    );
  }
  if (
    typeof parsed.accessToken !== "string" ||
    parsed.accessToken.length === 0 ||
    typeof parsed.expiresAt !== "number" ||
    !Number.isFinite(parsed.expiresAt)
  ) {
    throw new OAuthTokenLifecycleError(
      "REAUTHORIZATION_REQUIRED",
      "Stored OAuth tokens are incomplete; authorization is required again.",
    );
  }
  return {
    accessToken: parsed.accessToken,
    ...(typeof parsed.refreshToken === "string" &&
    parsed.refreshToken.length > 0
      ? { refreshToken: parsed.refreshToken }
      : {}),
    expiresAt: parsed.expiresAt,
  };
}

export function oauthTokenNeedsRefresh(
  expiresAt: number,
  refreshLeewaySeconds = 60,
  now = Date.now(),
): boolean {
  return expiresAt <= Math.floor(now / 1000) + refreshLeewaySeconds;
}

/** Providers may encode OAuth seconds as a JSON number or a decimal string. */
export function oauthExpiresIn(value: unknown): number | undefined {
  const seconds = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value) : value;
  return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0
    ? seconds : undefined;
}

/** OAuth's space-delimited `scope`; undefined when the provider stated none. */
export function oauthScopeList(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const scopes = value.split(" ").filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

/** Bound provider-controlled bytes before parsing token responses for any grant. */
export async function readOAuthTokenResponse(response: Response): Promise<OAuthTokenResponse> {
  try {
    const value: unknown = JSON.parse(await readBoundedResponse(response, 1024 * 1024));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as OAuthTokenResponse;
  } catch {
    throw new OAuthTokenLifecycleError(
      "OAUTH_FAILED",
      "The provider token endpoint returned an invalid response.",
    );
  }
}

/** Refresh one token set without reading a provider error body. */
export async function refreshOAuthTokenSet(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string | undefined;
  resource?: string | undefined;
  verifyTokenResponse?: ((payload: OAuthTokenResponse) => void) | undefined;
  refreshToken: string;
  boundFetch: OAuthBoundFetch;
  now?: number;
  signal?: AbortSignal;
}): Promise<OAuthTokenSet> {
  input.signal?.throwIfAborted();
  const response = await input.boundFetch(input.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      ...(input.clientSecret === undefined ? {} : { client_secret: input.clientSecret }),
      ...(input.resource === undefined ? {} : { resource: input.resource }),
    }).toString(),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  input.signal?.throwIfAborted();
  if (!response.ok) {
    throw new OAuthTokenLifecycleError(
      response.status === 400 || response.status === 401
        ? "REAUTHORIZATION_REQUIRED"
        : "OAUTH_FAILED",
      response.status === 400 || response.status === 401
        ? "The provider refused token refresh; authorization is required again."
        : "The provider token endpoint could not refresh the connection.",
    );
  }
  const payload = await readOAuthTokenResponse(response);
  if (
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0
  ) {
    throw new OAuthTokenLifecycleError(
      "OAUTH_FAILED",
      "The provider token endpoint returned no access token.",
    );
  }
  input.verifyTokenResponse?.(payload);
  const expiresIn = oauthExpiresIn(payload.expires_in) ?? 3600;
  const grantedScopes = oauthScopeList(payload.scope);
  return {
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === "string" &&
      payload.refresh_token.length > 0
        ? payload.refresh_token
        : input.refreshToken,
    expiresAt: Math.floor((input.now ?? Date.now()) / 1000) + expiresIn,
    ...(grantedScopes ? { grantedScopes } : {}),
  };
}
