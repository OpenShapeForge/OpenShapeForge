// SPDX-License-Identifier: BUSL-1.1
import type { LogoutReason } from "./auth/logout";

function safeLoginRedirect(value: unknown, reason?: LogoutReason): string | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value, globalThis.location.origin);
    if (url.origin !== globalThis.location.origin || url.pathname !== "/login") {
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

export async function requestLogout(reason?: LogoutReason): Promise<boolean> {
  try {
    const csrfResponse = await fetch("/api/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!csrfResponse.ok) {
      return false;
    }

    const csrfPayload = await csrfResponse.json() as { csrfToken?: unknown };
    if (typeof csrfPayload.csrfToken !== "string" || !csrfPayload.csrfToken) {
      return false;
    }

    const body = new URLSearchParams({ csrfToken: csrfPayload.csrfToken });
    if (reason) {
      body.set("reason", reason);
    }

    const response = await fetch("/api/logout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) {
      return false;
    }

    const payload = await response.json() as { url?: unknown };
    const redirect = safeLoginRedirect(payload.url, reason);
    if (!redirect) {
      return false;
    }

    globalThis.location.assign(redirect);
    return true;
  } catch {
    return false;
  }
}
