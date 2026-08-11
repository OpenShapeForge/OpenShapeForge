// SPDX-License-Identifier: BUSL-1.1
import { NextRequest } from "next/server";

export type LogoutReason = "session_expired";

type BoundSession = {
  sessionId?: string;
} | null;

type ConsumedSession = {
  refreshToken?: string;
} | null;

type AuthPostHandler = (request: NextRequest) => Promise<Response>;

export interface LogoutDependencies {
  appOrigin: string | null;
  authPost: AuthPostHandler;
  getAuthenticatedSession: () => Promise<BoundSession>;
  consumeSession: (sessionId: string) => Promise<ConsumedSession>;
  revokeRefreshSession: (refreshToken: string) => Promise<boolean>;
  transientCookieNames: readonly string[];
  secureCookies: boolean;
  onLocalFailure?: () => void;
  onRevocationFailure?: () => void;
}

export interface RefreshSessionRevocation {
  endpoint: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  timeoutMs?: number;
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_REVOCATION_TIMEOUT_MS = 3_000;

function errorResponse(status: number): Response {
  return Response.json(
    { error: "Logout could not be completed." },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function resolveCanonicalAppOrigin(
  configuredUrl: string | undefined,
): string | null {
  if (!configuredUrl?.trim()) {
    return null;
  }

  try {
    const parsed = new URL(configuredUrl.trim());
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username
      || parsed.password
      || (parsed.pathname !== "/" && parsed.pathname !== "")
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function hasSameOrigin(request: NextRequest, appOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }

  try {
    if (new URL(origin).origin !== appOrigin) {
      return false;
    }
  } catch {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

function getReason(value: FormDataEntryValue | null): LogoutReason | undefined | null {
  if (value === null || value === "") {
    return undefined;
  }
  return value === "session_expired" ? value : null;
}

function getRedirectUrl(appOrigin: string, reason?: LogoutReason): URL {
  const redirect = new URL("/login", appOrigin);
  if (reason) {
    redirect.searchParams.set("reason", reason);
  }
  return redirect;
}

async function authJsAcceptedLogout(
  response: Response,
  expectedRedirect: URL,
): Promise<boolean> {
  if (!response.ok) {
    return false;
  }

  try {
    const payload = await response.clone().json() as { url?: unknown };
    if (typeof payload.url !== "string") {
      return false;
    }
    return new URL(payload.url, expectedRedirect).href === expectedRedirect.href;
  } catch {
    return false;
  }
}

function withClearedTransientCookies(
  response: Response,
  names: readonly string[],
  secure: boolean,
): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  const secureAttribute = secure ? "; Secure" : "";
  for (const name of names) {
    headers.append(
      "Set-Cookie",
      `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${secureAttribute}`,
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * POST the refresh token to Keycloak's server-side OIDC logout endpoint.
 * Tokens and client credentials are carried only in the request body and this
 * helper deliberately never logs its URL, body, response, or thrown error.
 */
export async function revokeKeycloakRefreshSession(
  input: RefreshSessionRevocation,
  fetchImplementation: FetchImplementation = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? DEFAULT_REVOCATION_TIMEOUT_MS,
  );

  try {
    const response = await fetchImplementation(input.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        refresh_token: input.refreshToken,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Complete a logout only after Auth.js has accepted its CSRF token. The Auth.js
 * response is held back until the exact Redis session has been removed; on a
 * local-store failure its cookie-clearing headers are discarded so callers do
 * not receive a false success that leaves a captured cookie replayable.
 */
export async function handleLogoutRequest(
  request: NextRequest,
  dependencies: LogoutDependencies,
): Promise<Response> {
  if (!dependencies.appOrigin) {
    return errorResponse(503);
  }

  if (!hasSameOrigin(request, dependencies.appOrigin)) {
    return errorResponse(403);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    return errorResponse(415);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400);
  }

  const csrfToken = form.get("csrfToken");
  const reason = getReason(form.get("reason"));
  if (typeof csrfToken !== "string" || csrfToken.length === 0 || reason === null) {
    return errorResponse(400);
  }

  const expectedRedirect = getRedirectUrl(dependencies.appOrigin, reason);
  const canonicalUrl = new URL(dependencies.appOrigin);
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  headers.set("X-Auth-Return-Redirect", "1");
  headers.set("host", canonicalUrl.host);
  headers.set("x-forwarded-host", canonicalUrl.host);
  headers.set("x-forwarded-proto", canonicalUrl.protocol.slice(0, -1));
  headers.delete("content-length");
  headers.delete("x-forwarded-port");

  const authRequest = new NextRequest(
    new URL("/api/auth/signout", dependencies.appOrigin),
    {
      method: "POST",
      headers,
      body: new URLSearchParams({
        csrfToken,
        callbackUrl: expectedRedirect.href,
      }),
    },
  );
  const authResponse = await dependencies.authPost(authRequest);
  if (!await authJsAcceptedLogout(authResponse, expectedRedirect)) {
    return errorResponse(403);
  }

  let session: BoundSession;
  try {
    session = await dependencies.getAuthenticatedSession();
  } catch {
    dependencies.onLocalFailure?.();
    return errorResponse(503);
  }

  if (session?.sessionId) {
    let consumed: ConsumedSession;
    try {
      consumed = await dependencies.consumeSession(session.sessionId);
    } catch {
      dependencies.onLocalFailure?.();
      return errorResponse(503);
    }

    if (consumed?.refreshToken) {
      let revoked = false;
      try {
        revoked = await dependencies.revokeRefreshSession(consumed.refreshToken);
      } catch {
        revoked = false;
      }
      if (!revoked) {
        dependencies.onRevocationFailure?.();
      }
    }
  }

  return withClearedTransientCookies(
    authResponse,
    dependencies.transientCookieNames,
    dependencies.secureCookies,
  );
}
