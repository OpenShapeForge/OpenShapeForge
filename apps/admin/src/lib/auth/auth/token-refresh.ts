// SPDX-License-Identifier: BUSL-1.1
import {
  parseUserProfile,
  readJwtClaims,
} from "@openshapeforge/auth";
import {
  acquireRefreshLock,
  REFRESH_LOCK_TTL_MS,
  getSession,
  releaseRefreshLock,
  setSession,
} from "../redis";
import type { StoredSession } from "../redis";
import {
  claimsIncludeRoleState,
  hasPlatformOperatorRole,
  mergeUserProfileIntoStoredSession,
  parseAuthorizationRoles,
} from "./claims";
import { issuerInternal, keycloakClientId, keycloakClientSecret } from "./keycloak";

// Per-session refresh mutex. Two layers of deduplication:
// 1. Process-local: in-memory Map prevents concurrent refreshes within one process.
// 2. Distributed: Redis SET NX lock prevents concurrent refreshes across pods.
const refreshPromises = new Map<string, Promise<StoredSession>>();

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

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasUsableAccessWindow(
  session: StoredSession,
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

async function releaseRefreshLockSafely(
  sessionId: string,
  lockOwnerToken: string,
): Promise<void> {
  try {
    await releaseRefreshLock(sessionId, lockOwnerToken);
  } catch (error) {
    console.warn("[admin-auth] Refresh lock release failed", {
      sessionId,
      hasLockOwnerToken: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Reject a refresh response that is not a usable continuation of this session.
 *
 * THE ONE PLACE THIS DIVERGES MEANINGFULLY FROM apps/web. Its version requires
 * `parseTenantId(accessClaims)` to be present and to match the stored tenant:
 * a token with no `tid` is treated as malformed. Control-realm tokens NEVER
 * carry a `tid` — that omission is authored deliberately — so porting the check
 * unchanged would fail every single refresh, roughly a minute before the access
 * token would otherwise expire, and the operator would be silently signed out
 * mid-session.
 *
 * Dropping the check outright would be worse: it is the invariant that stops a
 * refresh from quietly swapping the session's authority underneath it. The
 * equivalent invariant HERE is the operator role. A refresh that comes back
 * without `platform-operator` means the role was revoked while the operator was
 * signed in, and the session must die rather than coast on the roles captured
 * at login. So the tenant check is not removed; it is replaced with the check
 * that means the same thing in this realm.
 */
function validateRefreshPayload(
  data: unknown,
  stored: StoredSession,
  nowS = Math.floor(Date.now() / 1000),
): { ok: true; data: Record<string, unknown>; accessToken: string; expiresIn: number } | { ok: false; reason: string } {
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

  // The replacement for apps/web's tenant check — see the doc comment above.
  if (!hasPlatformOperatorRole(parseAuthorizationRoles(accessClaims))) {
    return { ok: false, reason: `refreshed token no longer carries the operator role` };
  }

  const refreshExpiresIn = payload.refresh_expires_in;
  if (
    refreshExpiresIn != null &&
    !isFinitePositiveNumber(refreshExpiresIn)
  ) {
    return { ok: false, reason: "malformed refresh_expires_in" };
  }

  return { ok: true, data: payload, accessToken, expiresIn };
}

export async function refreshSessionInRedis(
  sessionId: string,
  stored: StoredSession,
): Promise<StoredSession> {
  // Layer 1: process-local dedup
  const existing = refreshPromises.get(sessionId);
  if (existing) return existing;

  const promise = (async () => {
    // Layer 2: distributed lock via Redis SET NX
    let lockOwnerToken = await acquireRefreshLock(sessionId);
    if (!lockOwnerToken) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const updated = await getSession(sessionId);
      if (updated && !updated.error && hasUsableAccessWindow(updated)) return updated;

      lockOwnerToken = await acquireRefreshLock(sessionId);
      if (!lockOwnerToken) {
        return { ...(updated ?? stored), error: "RefreshTokenError" };
      }
    }

    try {
      const refreshed = await doRefreshAccessToken(stored);
      const current = await getSession(sessionId);
      if (current && !current.error && hasUsableAccessWindow(current)) {
        return current;
      }
      await setSession(sessionId, refreshed);
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

export async function doRefreshAccessToken(
  stored: StoredSession,
  attempt = 1,
  deadlineMs = Date.now() + REFRESH_ATTEMPT_BUDGET_MS,
): Promise<StoredSession> {
  if (!stored.refreshToken) {
    console.error("[admin-auth] Token refresh skipped: missing refresh token");
    return { ...stored, error: "RefreshTokenError" };
  }

  const tokenUrl = `${issuerInternal}/protocol/openid-connect/token`;

  try {
    const remainingBudgetMs = deadlineMs - Date.now();
    if (remainingBudgetMs < REFRESH_MIN_FETCH_TIMEOUT_MS) {
      console.error("[admin-auth] Token refresh skipped: lock budget exhausted");
      return { ...stored, error: "RefreshTokenError" };
    }

    const response = await fetchWithRefreshTimeout(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: keycloakClientId,
        client_secret: keycloakClientSecret,
      }),
    }, Math.min(REFRESH_FETCH_TIMEOUT_MS, remainingBudgetMs));

    if (!response.ok) {
      // Retry on 5xx (transient server errors), fail fast on 4xx
      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      if (
        response.status >= 500 &&
        nextRefreshAttemptAllowed({ attempt, delayMs: delay, deadlineMs })
      ) {
        console.warn(
          `[admin-auth] Token refresh attempt ${attempt} failed, retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return doRefreshAccessToken(stored, attempt + 1, deadlineMs);
      }

      console.error("[admin-auth] Token refresh failed:", response.status);
      return { ...stored, error: "RefreshTokenError" };
    }

    const nowS = Math.floor(Date.now() / 1000);
    const parsed = validateRefreshPayload(await response.json(), stored, nowS);
    if (!parsed.ok) {
      // The reason is logged, not swallowed: "operator role revoked" and
      // "Keycloak returned nonsense" both end the session, and an operator
      // asking why they were signed out deserves the difference in the log.
      console.error("[admin-auth] Token refresh rejected:", parsed.reason);
      return { ...stored, error: "RefreshTokenError" };
    }

    const { data, accessToken, expiresIn } = parsed;

    const refreshedAccessClaims = readJwtClaims(accessToken);
    const refreshedIdToken = (data.id_token as string | undefined) ?? stored.idToken;
    const refreshedIdClaims = readJwtClaims(refreshedIdToken);

    const refreshedRoles = parseAuthorizationRoles(refreshedAccessClaims);

    const refreshedProfile = parseUserProfile({
      sub: stored.sub,
      stored,
      idTokenClaims: refreshedIdClaims,
      accessTokenClaims: refreshedAccessClaims,
    });

    return mergeUserProfileIntoStoredSession({
      ...stored,
      accessToken,
      idToken: refreshedIdToken,
      refreshToken: (data.refresh_token as string | undefined) ?? stored.refreshToken,
      expiresAt: nowS + expiresIn,
      roles: refreshedRoles,
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
      console.warn(
        `[admin-auth] Token refresh attempt ${attempt} failed, retrying in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return doRefreshAccessToken(stored, attempt + 1, deadlineMs);
    }

    console.error("[admin-auth] Token refresh failed after retries:", error instanceof Error ? error.message : String(error));
    return { ...stored, error: "RefreshTokenError" };
  }
}
