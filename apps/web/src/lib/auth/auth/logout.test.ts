// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  handleLogoutRequest,
  resolveCanonicalAppOrigin,
  revokeKeycloakRefreshSession,
  type LogoutDependencies,
} from "./logout";

const APP_ORIGIN = "https://app.example.test";

function logoutRequest(input?: {
  origin?: string;
  requestUrl?: string;
  forwardedHost?: string;
  forwardedProto?: string;
  csrfToken?: string;
  reason?: string;
}): NextRequest {
  const body = new URLSearchParams({
    csrfToken: input?.csrfToken ?? "test-csrf-token",
  });
  if (input?.reason !== undefined) body.set("reason", input.reason);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: input?.origin ?? APP_ORIGIN,
    Cookie: "openshapeforge.session-token=test-cookie",
    "Sec-Fetch-Site": "same-origin",
  };
  if (input?.forwardedHost) headers["X-Forwarded-Host"] = input.forwardedHost;
  if (input?.forwardedProto) headers["X-Forwarded-Proto"] = input.forwardedProto;

  return new NextRequest(input?.requestUrl ?? `${APP_ORIGIN}/api/logout`, {
    method: "POST",
    headers,
    body,
  });
}

function validAuthResponse(reason?: "session_expired"): Response {
  const url = new URL("/login", APP_ORIGIN);
  if (reason) url.searchParams.set("reason", reason);
  return Response.json(
    { url: url.href },
    { headers: { "Set-Cookie": "openshapeforge.session-token=; Path=/; Max-Age=0" } },
  );
}

function dependencies(
  overrides: Partial<LogoutDependencies> = {},
): LogoutDependencies {
  return {
    appOrigin: APP_ORIGIN,
    authPost: async () => validAuthResponse(),
    getAuthenticatedSession: async () => ({ sessionId: "session-under-test" }),
    consumeSession: async () => ({ refreshToken: "test-refresh-token" }),
    revokeRefreshSession: async () => true,
    transientCookieNames: [
      "openshapeforge.csrf-token",
      "openshapeforge.callback-url",
    ],
    secureCookies: true,
    ...overrides,
  };
}

describe("logout request boundary", () => {
  test("accepts only an HTTP(S) origin-only canonical app URL", () => {
    expect(resolveCanonicalAppOrigin(`${APP_ORIGIN}/`)).toBe(APP_ORIGIN);
    for (const invalid of [
      "ftp://app.example.test",
      "https://user@app.example.test",
      "https://app.example.test/base-path",
      "https://app.example.test/?query=1",
      "https://app.example.test/#fragment",
    ]) {
      expect(resolveCanonicalAppOrigin(invalid)).toBeNull();
    }
  });

  test("uses the canonical public origin behind an internal ingress URL", async () => {
    const callbackUrls: Array<string | null> = [];
    const authRequestUrls: string[] = [];
    const authRequestOrigins: string[] = [];
    const response = await handleLogoutRequest(
      logoutRequest({
        requestUrl: "http://127.0.0.1:3000/api/logout",
        origin: APP_ORIGIN,
        forwardedHost: "app.example.test",
        forwardedProto: "https",
      }),
      dependencies({
        authPost: async (request) => {
          authRequestUrls.push(request.url);
          authRequestOrigins.push([
            request.headers.get("host"),
            request.headers.get("x-forwarded-host"),
            request.headers.get("x-forwarded-proto"),
          ].join("|"));
          callbackUrls.push(
            (await request.formData()).get("callbackUrl") as string | null,
          );
          return validAuthResponse();
        },
        getAuthenticatedSession: async () => null,
      }),
    );

    expect(response.status).toBe(200);
    expect(authRequestUrls).toEqual([`${APP_ORIGIN}/api/auth/signout`]);
    expect(authRequestOrigins).toEqual([
      "app.example.test|app.example.test|https",
    ]);
    expect(callbackUrls).toEqual([`${APP_ORIGIN}/login`]);
    expect(await response.json()).toEqual({ url: `${APP_ORIGIN}/login` });
  });

  test("rejects the internal request origin when the canonical app is public", async () => {
    const response = await handleLogoutRequest(
      logoutRequest({
        requestUrl: "http://localhost:3000/api/logout",
        origin: "http://localhost:3000",
      }),
      dependencies(),
    );

    expect(response.status).toBe(403);
  });

  test("fails closed when the canonical app origin is missing or invalid", async () => {
    for (const appOrigin of [null, resolveCanonicalAppOrigin("not a URL")]) {
      const response = await handleLogoutRequest(
        logoutRequest(),
        dependencies({ appOrigin }),
      );
      expect(response.status).toBe(503);
    }
  });

  test("rejects a cross-origin request before Auth.js or Redis is touched", async () => {
    let authCalls = 0;
    let consumeCalls = 0;
    const response = await handleLogoutRequest(
      logoutRequest({ origin: "https://attacker.example.test" }),
      dependencies({
        authPost: async () => {
          authCalls += 1;
          return validAuthResponse();
        },
        consumeSession: async () => {
          consumeCalls += 1;
          return null;
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(authCalls).toBe(0);
    expect(consumeCalls).toBe(0);
  });

  test("rejects an Auth.js CSRF failure without deleting the session", async () => {
    let consumeCalls = 0;
    const response = await handleLogoutRequest(
      logoutRequest({ csrfToken: "invalid-csrf-token" }),
      dependencies({
        authPost: async () => Response.json({
          url: `${APP_ORIGIN}/api/auth/error?error=MissingCSRF`,
        }),
        consumeSession: async () => {
          consumeCalls += 1;
          return null;
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(consumeCalls).toBe(0);
  });

  test("deletes the bound session, revokes its refresh session, and clears cookies", async () => {
    const sessions = new Map([["session-under-test", { refreshToken: "test-refresh-token" }]]);
    let consumedId: string | undefined;
    let revokedToken: string | undefined;

    const response = await handleLogoutRequest(
      logoutRequest(),
      dependencies({
        consumeSession: async (sessionId) => {
          consumedId = sessionId;
          const stored = sessions.get(sessionId) ?? null;
          sessions.delete(sessionId);
          return stored;
        },
        revokeRefreshSession: async (refreshToken) => {
          revokedToken = refreshToken;
          return true;
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(consumedId).toBe("session-under-test");
    expect(sessions.get("session-under-test")).toBeUndefined();
    expect(revokedToken).toBe("test-refresh-token");
    const setCookies = response.headers.getSetCookie().join("\n");
    expect(setCookies).toContain("openshapeforge.session-token=");
    expect(setCookies).toContain("openshapeforge.csrf-token=");
    expect(setCookies).toContain("openshapeforge.callback-url=");
    expect(setCookies).toContain("Max-Age=0");
    expect(setCookies).toContain("Secure");
  });

  test("holds back cookie clearing when exact Redis deletion fails", async () => {
    let localFailureCalls = 0;
    const response = await handleLogoutRequest(
      logoutRequest(),
      dependencies({
        consumeSession: async () => {
          throw new Error("test store unavailable");
        },
        onLocalFailure: () => {
          localFailureCalls += 1;
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(localFailureCalls).toBe(1);
  });

  test("keeps local logout complete when upstream revocation is unavailable", async () => {
    const sessions = new Map([["session-under-test", { refreshToken: "test-refresh-token" }]]);
    let revocationFailureCalls = 0;
    const response = await handleLogoutRequest(
      logoutRequest(),
      dependencies({
        consumeSession: async (sessionId) => {
          const stored = sessions.get(sessionId) ?? null;
          sessions.delete(sessionId);
          return stored;
        },
        revokeRefreshSession: async () => false,
        onRevocationFailure: () => {
          revocationFailureCalls += 1;
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(sessions.has("session-under-test")).toBe(false);
    expect(response.headers.getSetCookie().join("\n")).toContain("Max-Age=0");
    expect(revocationFailureCalls).toBe(1);
  });

  test("clears a stale Auth.js cookie when no Redis-backed session remains", async () => {
    let consumeCalls = 0;
    const response = await handleLogoutRequest(
      logoutRequest({ reason: "session_expired" }),
      dependencies({
        authPost: async () => validAuthResponse("session_expired"),
        getAuthenticatedSession: async () => null,
        consumeSession: async () => {
          consumeCalls += 1;
          return null;
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(consumeCalls).toBe(0);
    expect(await response.json()).toEqual({
      url: `${APP_ORIGIN}/login?reason=session_expired`,
    });
  });
});

describe("Keycloak refresh-session revocation", () => {
  test("POSTs credentials and refresh token only in the form body", async () => {
    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(null, { status: 204 });
    });

    const revoked = await revokeKeycloakRefreshSession({
      endpoint: "https://identity.example.test/realms/test/protocol/openid-connect/logout",
      clientId: "test-client",
      clientSecret: "test-client-secret",
      refreshToken: "test-refresh-token",
    }, fetchMock);

    expect(revoked).toBe(true);
    expect(String(capturedUrl)).toBe(
      "https://identity.example.test/realms/test/protocol/openid-connect/logout",
    );
    expect(String(capturedUrl)).not.toContain("test-refresh-token");
    expect(capturedInit?.method).toBe("POST");
    const body = capturedInit?.body as URLSearchParams;
    expect(body.get("client_id")).toBe("test-client");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("refresh_token")).toBe("test-refresh-token");
    expect(capturedInit?.redirect).toBe("manual");
  });

  test("returns a safe failure for network and non-success responses", async () => {
    const input = {
      endpoint: "https://identity.example.test/realms/test/protocol/openid-connect/logout",
      clientId: "test-client",
      clientSecret: "test-client-secret",
      refreshToken: "test-refresh-token",
    };

    expect(await revokeKeycloakRefreshSession(
      input,
      async () => new Response(null, { status: 503 }),
    )).toBe(false);
    expect(await revokeKeycloakRefreshSession(
      input,
      async () => { throw new Error("test network failure"); },
    )).toBe(false);
  });
});
