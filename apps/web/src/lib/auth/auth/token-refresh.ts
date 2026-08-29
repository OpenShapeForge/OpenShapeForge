// SPDX-License-Identifier: BUSL-1.1
import {
  parseTenantId,
  parseTenantContext,
  parseUserProfile,
  readJwtClaims,
} from "@openshapeforge/auth";
import {
  acquireRefreshLock,
  REFRESH_LOCK_TTL_MS,
  getSession,
  replaceSessionIfUnchanged,
  releaseRefreshLock,
} from "../redis";
import type { StoredSession } from "../redis";
import {
  claimsIncludeRoleState,
  mergeUserProfileIntoStoredSession,
  parseAuthorizationRoles,
  resolveRefreshedGroups,
} from "./claims";
import { issuerInternal, keycloakClientSecret } from "./keycloak";

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
 * How many seconds before the access token expires to proactively refresh it.
 * This ensures the user never hits an expired access token during normal use.
 * The SessionExpiryGuard monitors the refresh token expiry separately.
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
    console.warn("[auth] Refresh lock release failed", {
      sessionId,
      hasLockOwnerToken: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateRefreshPayload(
  data: unknown,
  stored: StoredSession,
  nowS = Math.floor(Date.now() / 1000),
): { ok: true; data: Record<string, unknown>; accessToken: string; expiresIn: number } | { ok: false } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false };
  }

  const payload = data as Record<string, unknown>;
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    return { ok: false };
  }

  const accessClaims = readJwtClaims(accessToken);
  if (!accessClaims) {
    return { ok: false };
  }

  const expiresIn = payload.expires_in;
  if (!isFinitePositiveNumber(expiresIn)) {
    return { ok: false };
  }

  const subject = accessClaims.sub;
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return { ok: false };
  }
  if (stored.sub && subject !== stored.sub) {
    return { ok: false };
  }

  const tokenExpiresAt = accessClaims.exp;
  if (!isFinitePositiveNumber(tokenExpiresAt) || tokenExpiresAt <= nowS) {
    return { ok: false };
  }

  const tenantId = parseTenantId(accessClaims);
  if (!tenantId) {
    return { ok: false };
  }
  if (stored.tenantId && tenantId !== stored.tenantId) {
    return { ok: false };
  }

  if (!claimsIncludeRoleState(accessClaims)) {
    return { ok: false };
  }

  const refreshExpiresIn = payload.refresh_expires_in;
  if (
    refreshExpiresIn != null &&
    !isFinitePositiveNumber(refreshExpiresIn)
  ) {
    return { ok: false };
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

  const promise = refreshSessionWithDistributedLock(sessionId, stored, {
    acquireLock: acquireRefreshLock,
    getSession,
    refresh: doRefreshAccessToken,
    replaceSession: replaceSessionIfUnchanged,
    releaseLock: releaseRefreshLockSafely,
    wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  }).finally(() => {
    refreshPromises.delete(sessionId);
  });

  refreshPromises.set(sessionId, promise);
  return promise;
}

export interface RefreshSessionLockDependencies {
  acquireLock: (sessionId: string) => Promise<string | null>;
  getSession: (sessionId: string) => Promise<StoredSession | null>;
  refresh: (stored: StoredSession) => Promise<StoredSession>;
  replaceSession: (
    sessionId: string,
    expected: StoredSession,
    replacement: StoredSession,
  ) => Promise<boolean>;
  releaseLock: (sessionId: string, ownerToken: string) => Promise<void>;
  wait: (delayMs: number) => Promise<void>;
}

/**
 * Refresh only from a record read after the distributed lock is held. A waiter
 * may have captured `stored` before logout; re-reading here prevents that stale
 * snapshot from recreating a session deleted while the waiter slept.
 */
export async function refreshSessionWithDistributedLock(
  sessionId: string,
  stored: StoredSession,
  dependencies: RefreshSessionLockDependencies,
): Promise<StoredSession> {
  let updated: StoredSession | null = null;
  let lockOwnerToken = await dependencies.acquireLock(sessionId);
  if (!lockOwnerToken) {
    await dependencies.wait(2000);
    updated = await dependencies.getSession(sessionId);
    if (updated && !updated.error && hasUsableAccessWindow(updated)) {
      return updated;
    }

    lockOwnerToken = await dependencies.acquireLock(sessionId);
    if (!lockOwnerToken) {
      return { ...(updated ?? stored), error: "RefreshTokenError" };
    }
  }

  try {
    const lockedSession = await dependencies.getSession(sessionId);
    if (!lockedSession) {
      return { ...(updated ?? stored), error: "RefreshTokenError" };
    }
    if (lockedSession.error) {
      return { ...lockedSession, error: "RefreshTokenError" };
    }
    if (hasUsableAccessWindow(lockedSession)) {
      return lockedSession;
    }

    const refreshed = await dependencies.refresh(lockedSession);
    const latest = await dependencies.getSession(sessionId);
    if (!latest) {
      return { ...lockedSession, error: "RefreshTokenError" };
    }
    if (latest.error) {
      return { ...latest, error: "RefreshTokenError" };
    }
    if (hasUsableAccessWindow(latest)) {
      return latest;
    }

    const replaced = await dependencies.replaceSession(
      sessionId,
      latest,
      refreshed,
    );
    if (!replaced) {
      const current = await dependencies.getSession(sessionId);
      if (current && !current.error && hasUsableAccessWindow(current)) {
        return current;
      }
      return { ...(current ?? latest), error: "RefreshTokenError" };
    }
    return refreshed;
  } finally {
    await dependencies.releaseLock(sessionId, lockOwnerToken);
  }
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
    console.error("[auth] Token refresh skipped: missing refresh token");
    return { ...stored, error: "RefreshTokenError" };
  }

  const tokenUrl = `${issuerInternal}/protocol/openid-connect/token`;

  try {
    const remainingBudgetMs = deadlineMs - Date.now();
    if (remainingBudgetMs < REFRESH_MIN_FETCH_TIMEOUT_MS) {
      console.error("[auth] Token refresh skipped: lock budget exhausted");
      return { ...stored, error: "RefreshTokenError" };
    }

    const response = await fetchWithRefreshTimeout(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        client_id: process.env.AUTH_KEYCLOAK_ID ?? "openshapeforge-gateway",
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
          `[auth] Token refresh attempt ${attempt} failed, retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return doRefreshAccessToken(stored, attempt + 1, deadlineMs);
      }

      console.error("[auth] Token refresh failed:", response.status);
      return { ...stored, error: "RefreshTokenError" };
    }

    const nowS = Math.floor(Date.now() / 1000);
    const parsed = validateRefreshPayload(await response.json(), stored, nowS);
    if (!parsed.ok) {
      console.error("[auth] Token refresh failed: malformed success response");
      return { ...stored, error: "RefreshTokenError" };
    }

    const { data, accessToken, expiresIn } = parsed;

    const refreshedAccessClaims = readJwtClaims(accessToken);
    const refreshedIdToken = (data.id_token as string | undefined) ?? stored.idToken;
    const refreshedIdClaims = readJwtClaims(refreshedIdToken);

    const refreshedRoles = claimsIncludeRoleState(refreshedAccessClaims)
      ? parseAuthorizationRoles(refreshedAccessClaims)
      : stored.roles;
    const refreshedGroups = resolveRefreshedGroups(
      refreshedAccessClaims,
      refreshedIdClaims,
      stored.groups,
    );
    const tenantId = (refreshedAccessClaims?.tid as string | undefined) ?? stored.tenantId;
    const actorType = parseTenantContext(refreshedAccessClaims, tenantId)
      ?? (refreshedAccessClaims?.act as string | undefined)
      ?? stored.actorType;

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
      groups: refreshedGroups,
      tenantId,
      actorType,
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
        `[auth] Token refresh attempt ${attempt} failed, retrying in ${delay}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return doRefreshAccessToken(stored, attempt + 1, deadlineMs);
    }

    console.error("[auth] Token refresh failed after retries:", error instanceof Error ? error.message : String(error));
    return { ...stored, error: "RefreshTokenError" };
  }
}
