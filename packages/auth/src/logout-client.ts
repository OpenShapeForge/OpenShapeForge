// SPDX-License-Identifier: BUSL-1.1
import type { LogoutReason } from "./logout.js";

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type BrowserLocation = {
  origin: string;
  assign(url: string): void;
};

export interface LogoutClientDependencies {
  fetch: FetchImplementation;
  getLocation: () => BrowserLocation;
  wait: (delayMs: number) => Promise<void>;
}

export interface LogoutRequestOptions {
  /** Retry one HTTP 503 response, for the bounded refresh-lock race. */
  retryOnceOnServiceUnavailable?: boolean;
  retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 1_000;

const defaultDependencies: LogoutClientDependencies = {
  fetch,
  getLocation: () => (
    globalThis as typeof globalThis & { location: BrowserLocation }
  ).location,
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

function safeLoginRedirect(
  value: unknown,
  origin: string,
  reason?: LogoutReason,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== "/login") {
      return null;
    }
    if ((url.searchParams.get("reason") ?? undefined) !== reason) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

type LogoutAttempt =
  | { outcome: "success"; redirect: string }
  | { outcome: "retryable" }
  | { outcome: "failed" };

async function attemptLogout(
  reason: LogoutReason | undefined,
  dependencies: LogoutClientDependencies,
): Promise<LogoutAttempt> {
  try {
    const csrfResponse = await dependencies.fetch("/api/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!csrfResponse.ok) {
      return { outcome: "failed" };
    }

    const csrfPayload = await csrfResponse.json() as { csrfToken?: unknown };
    if (typeof csrfPayload.csrfToken !== "string" || !csrfPayload.csrfToken) {
      return { outcome: "failed" };
    }

    const body = new URLSearchParams({ csrfToken: csrfPayload.csrfToken });
    if (reason) {
      body.set("reason", reason);
    }

    const response = await dependencies.fetch("/api/logout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (response.status === 503) {
      return { outcome: "retryable" };
    }
    if (!response.ok) {
      return { outcome: "failed" };
    }

    const payload = await response.json() as { url?: unknown };
    const redirect = safeLoginRedirect(
      payload.url,
      dependencies.getLocation().origin,
      reason,
    );
    return redirect
      ? { outcome: "success", redirect }
      : { outcome: "failed" };
  } catch {
    return { outcome: "failed" };
  }
}

/**
 * Execute the browser logout flow. Manual logout performs one attempt.
 * Automatic expiry may opt into exactly one delayed retry when the server
 * reports 503 because a token refresh can briefly own the session lock.
 */
export async function requestLogout(
  reason?: LogoutReason,
  options: LogoutRequestOptions = {},
  dependencies: LogoutClientDependencies = defaultDependencies,
): Promise<boolean> {
  const maximumAttempts = options.retryOnceOnServiceUnavailable ? 2 : 1;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const result = await attemptLogout(reason, dependencies);
    if (result.outcome === "success") {
      dependencies.getLocation().assign(result.redirect);
      return true;
    }
    if (result.outcome !== "retryable" || attempt === maximumAttempts) {
      return false;
    }
    await dependencies.wait(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }

  return false;
}
