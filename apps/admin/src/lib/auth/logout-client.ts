// SPDX-License-Identifier: BUSL-1.1
function safeLoginRedirect(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, globalThis.location.origin);
    return url.origin === globalThis.location.origin && url.pathname === "/login"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export async function requestLogout(): Promise<boolean> {
  try {
    const csrfResponse = await fetch("/api/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!csrfResponse.ok) return false;

    const csrfPayload = await csrfResponse.json() as { csrfToken?: unknown };
    if (typeof csrfPayload.csrfToken !== "string" || !csrfPayload.csrfToken) {
      return false;
    }

    const response = await fetch("/api/logout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrfToken: csrfPayload.csrfToken }),
    });
    if (!response.ok) return false;

    const payload = await response.json() as { url?: unknown };
    const redirect = safeLoginRedirect(payload.url);
    if (!redirect) return false;

    globalThis.location.assign(redirect);
    return true;
  } catch {
    return false;
  }
}
