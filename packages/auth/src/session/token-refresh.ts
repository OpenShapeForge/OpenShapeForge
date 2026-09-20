// SPDX-License-Identifier: BUSL-1.1
import { parseUserProfile, readJwtClaims } from "../claims.js";
import {
  claimsIncludeRoleState,
  mergeUserProfileIntoStoredSession,
  parseAuthorizationRoles,
  type JwtClaims,
} from "./claims.js";
import type { KeycloakSettings } from "./keycloak.js";
import { REFRESH_LOCK_TTL_MS, type SessionStore, type StoredSession } from "./store.js";

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;
const REFRESH_ATTEMPT_BUDGET_MS = Math.max(1000, REFRESH_LOCK_TTL_MS - 1000);
const REFRESH_MIN_FETCH_TIMEOUT_MS = 1000;
const REFRESH_FETCH_TIMEOUT_MS = Math.max(
  REFRESH_MIN_FETCH_TIMEOUT_MS,
  REFRESH_LOCK_TTL_MS - 2000,
);

/**
 * How many seconds before the access token expires to proactively refresh it,
 * so a normal page load never hits an expired access token.
 */
export const ACCESS_TOKEN_REFRESH_BUFFER_S = 60;

export type RefreshedClaims = {
  accessTokenClaims: JwtClaims | undefined;
  idTokenClaims: JwtClaims | undefined;
};

export type TokenRefreshOptions<Extra extends object> = {
  logTag: string;
  keycloak: Pick<KeycloakSettings, "issuerInternal" | "clientId" | "clientSecret">;
  store: SessionStore<Extra>;
  /**
   * The invariant a refreshed token must keep for the session to continue —
   * the check that stops a refresh from quietly swapping the session's
   * authority underneath it. Returns the reason to refuse, or undefined.
   */
  refreshInvariant(accessClaims: JwtClaims, stored: StoredSession<Extra>): string | undefined;
  /** The app's own stored fields, recomputed from the refreshed tokens. */
  refreshedFields(claims: RefreshedClaims, stored: StoredSession<Extra>): Extra;
};

export type TokenRefresh<Extra extends object> = {
  refreshSessionInRedis(sessionId: string, stored: StoredSession<Extra>): Promise<StoredSession<Extra>>;
  doRefreshAccessToken(stored: StoredSession<Extra>): Promise<StoredSession<Extra>>;
};

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasUsableAccessWindow(
  session: StoredSession<object>,
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  return (
    typeof session.accessToken === "string" &&
    session.accessToken.trim().length > 0 &&
    isFinitePositiveNumber(session.expiresAt) &&
    session.expiresAt - nowS > ACCESS_TOKEN_REFRESH_BUFFER_S &&
    (!isFinitePositiveNumber(session.refreshExpiresAt) ||
      session.refreshExpiresAt > nowS)
  );
}

async function fetchWithRefreshTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function nextRefreshAttemptAllowed(input: {
  attempt: number;
  delayMs: number;
  deadlineMs: number;
}): boolean {
  if (input.attempt >= MAX_RETRIES) return false;
  return Date.now() + input.delayMs + REFRESH_MIN_FETCH_TIMEOUT_MS < input.deadlineMs;
}

type RefreshPayload =
  | { ok: true; data: Record<string, unknown>; accessToken: string; expiresIn: number }
  | { ok: false; reason: string };

/** Reject a refresh response that is not a usable continuation of this session. */
function validateRefreshPayload<Extra extends object>(
  data: unknown,
  stored: StoredSession<Extra>,
  refreshInvariant: TokenRefreshOptions<Extra>["refreshInvariant"],
  nowS: number,
): RefreshPayload {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "response body is not an object" };
  }

  const payload = data as Record<string, unknown>;
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    return { ok: false, reason: "no access_token" };
  }

  const accessClaims = readJwtClaims(accessToken);
  if (!accessClaims) {
    return { ok: false, reason: "access_token is not a readable JWT" };
  }

  const expiresIn = payload.expires_in;
  if (!isFinitePositiveNumber(expiresIn)) {
    return { ok: false, reason: "no usable expires_in" };
  }

  const subject = accessClaims.sub;
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return { ok: false, reason: "no sub claim" };
  }
  if (stored.sub && subject !== stored.sub) {
    return { ok: false, reason: "sub changed mid-session" };
  }

  const tokenExpiresAt = accessClaims.exp;
  if (!isFinitePositiveNumber(tokenExpiresAt) || tokenExpiresAt <= nowS) {
    return { ok: false, reason: "refreshed token is already expired" };
  }

  if (!claimsIncludeRoleState(accessClaims)) {
    return { ok: false, reason: "refreshed token carries no role state" };
  }

  const refused = refreshInvariant(accessClaims, stored);
  if (refused) {
    return { ok: false, reason: refused };
  }

  const refreshExpiresIn = payload.refresh_expires_in;
  if (refreshExpiresIn != null && !isFinitePositiveNumber(refreshExpiresIn)) {
    return { ok: false, reason: "malformed refresh_expires_in" };
  }

  return { ok: true, data: payload, accessToken, expiresIn };
}

export function createTokenRefresh<Extra extends object>(
  options: TokenRefreshOptions<Extra>,
): TokenRefresh<Extra> {
  const { store } = options;
  const log = `[${options.logTag}]`;
  const tokenUrl = `${options.keycloak.issuerInternal}/protocol/openid-connect/token`;

  // Per-session refresh mutex. Two layers of deduplication:
  // 1. Process-local: in-memory Map prevents concurrent refreshes within one process.
  // 2. Distributed: Redis SET NX lock prevents concurrent refreshes across pods.
  const refreshPromises = new Map<string, Promise<StoredSession<Extra>>>();

  async function releaseRefreshLockSafely(sessionId: string, lockOwnerToken: string): Promise<void> {
    try {
      await store.releaseRefreshLock(sessionId, lockOwnerToken);
    } catch (error) {
      console.warn(`${log} Refresh lock release failed`, {
        sessionId,
        hasLockOwnerToken: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function doRefreshAccessToken(
    stored: StoredSession<Extra>,
    attempt = 1,
    deadlineMs = Date.now() + REFRESH_ATTEMPT_BUDGET_MS,
  ): Promise<StoredSession<Extra>> {
    if (!stored.refreshToken) {
      console.error(`${log} Token refresh skipped: missing refresh token`);
      return { ...stored, error: "RefreshTokenError" };
    }

    try {
      const remainingBudgetMs = deadlineMs - Date.now();
      if (remainingBudgetMs < REFRESH_MIN_FETCH_TIMEOUT_MS) {
        console.error(`${log} Token refresh skipped: lock budget exhausted`);
        return { ...stored, error: "RefreshTokenError" };
      }

      const response = await fetchWithRefreshTimeout(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: stored.refreshToken,
          client_id: options.keycloak.clientId,
          client_secret: options.keycloak.clientSecret,
        }),
      }, Math.min(REFRESH_FETCH_TIMEOUT_MS, remainingBudgetMs));

      if (!response.ok) {
        // Retry on 5xx (transient server errors), fail fast on 4xx
        const delay = BASE_DELAY * Math.pow(2, attempt - 1);
        if (
          response.status >= 500 &&
          nextRefreshAttemptAllowed({ attempt, delayMs: delay, deadlineMs })
        ) {
          console.warn(`${log} Token refresh attempt ${attempt} failed, retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          return doRefreshAccessToken(stored, attempt + 1, deadlineMs);
        }

        console.error(`${log} Token refresh failed:`, response.status);
        return { ...stored, error: "RefreshTokenError" };
      }

      const nowS = Math.floor(Date.now() / 1000);
      const parsed = validateRefreshPayload(await response.json(), stored, options.refreshInvariant, nowS);
      if (!parsed.ok) {
        // The reason is logged, not swallowed: "authority revoked" and
        // "Keycloak returned nonsense" both end the session, and a user asking
        // why they were signed out deserves the difference in the log.
        console.error(`${log} Token refresh rejected:`, parsed.reason);
        return { ...stored, error: "RefreshTokenError" };
      }

      const { data, accessToken, expiresIn } = parsed;
      const accessTokenClaims = readJwtClaims(accessToken);
      const refreshedIdToken = (data.id_token as string | undefined) ?? stored.idToken;
      const idTokenClaims = readJwtClaims(refreshedIdToken);

      const refreshedProfile = parseUserProfile({
        sub: stored.sub,
        stored,
        idTokenClaims,
        accessTokenClaims,
      });

      return mergeUserProfileIntoStoredSession({
        ...stored,
        ...options.refreshedFields({ accessTokenClaims, idTokenClaims }, stored),
        accessToken,
        idToken: refreshedIdToken,
        refreshToken: (data.refresh_token as string | undefined) ?? stored.refreshToken,
        expiresAt: nowS + expiresIn,
        roles: parseAuthorizationRoles(accessTokenClaims),
        // Keycloak returns refresh_expires_in - this is the true session lifetime.
        // If Keycloak omits it (e.g. offline_access scope), keep the old value.
        refreshExpiresAt: data.refresh_expires_in
          ? nowS + (data.refresh_expires_in as number)
          : stored.refreshExpiresAt,
        error: undefined,
      }, refreshedProfile);
    } catch (error) {
      // Network errors - retry with backoff
      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      if (nextRefreshAttemptAllowed({ attempt, delayMs: delay, deadlineMs })) {
        console.warn(`${log} Token refresh attempt ${attempt} failed, retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return doRefreshAccessToken(stored, attempt + 1, deadlineMs);
      }

      console.error(`${log} Token refresh failed after retries:`, error instanceof Error ? error.message : String(error));
      return { ...stored, error: "RefreshTokenError" };
    }
  }

  async function refreshSessionInRedis(
    sessionId: string,
    stored: StoredSession<Extra>,
  ): Promise<StoredSession<Extra>> {
    // Layer 1: process-local dedup
    const existing = refreshPromises.get(sessionId);
    if (existing) return existing;

    const promise = (async () => {
      // Layer 2: distributed lock via Redis SET NX
      let lockOwnerToken = await store.acquireRefreshLock(sessionId);
      if (!lockOwnerToken) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const updated = await store.getSession(sessionId);
        if (updated && !updated.error && hasUsableAccessWindow(updated)) return updated;

        lockOwnerToken = await store.acquireRefreshLock(sessionId);
        if (!lockOwnerToken) {
          // Another pod is still refreshing. Its result, good or bad, lands in
          // Redis; the next request reads it. Stamping an error on this cookie
          // now would sign the browser out of a session that may be fine.
          return updated ?? stored;
        }
      }

      try {
        // Refresh from what Redis holds now, not the pre-lock snapshot: a
        // holder that just finished may have rotated the refresh token, and a
        // consumed token would turn a good session into RefreshTokenError.
        const current = await store.getSession(sessionId);
        if (current?.error) return current;
        if (current && hasUsableAccessWindow(current)) return current;
        const refreshed = await doRefreshAccessToken(current ?? stored);
        await store.setSession(sessionId, refreshed);
        return refreshed;
      } finally {
        if (lockOwnerToken) {
          await releaseRefreshLockSafely(sessionId, lockOwnerToken);
        }
      }
    })().finally(() => {
      refreshPromises.delete(sessionId);
    });

    refreshPromises.set(sessionId, promise);
    return promise;
  }

  return { refreshSessionInRedis, doRefreshAccessToken: (stored) => doRefreshAccessToken(stored) };
}
