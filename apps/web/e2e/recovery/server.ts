// SPDX-License-Identifier: BUSL-1.1
/** Isolated HTTP host for the real Auth.js handlers, Redis store and Keycloak flow. */
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { createSessionAuth, createSessionStore, createKeycloakSettings } from "../../../../packages/auth/src/session/index.js";

const issuer = process.env.AUTH_RECOVERY_ISSUER;
if (!issuer || new URL(issuer).hostname !== "127.0.0.1" || !process.env.REDIS_URL) {
  throw new Error("An isolated loopback Keycloak issuer and REDIS_URL are required.");
}
const prefix = `recovery-${randomUUID()}`;
const store = createSessionStore({ keyPrefix: prefix, logTag: "recovery-test" });
let sessionId: string | undefined;
let mode: "healthy" | "rate-limit" | "stalled" = "healthy";
let calls = 0;
let canceled = false;
const settings = createKeycloakSettings({ issuer, clientId: "recovery-web", clientSecret: "isolated-test-secret", authSecret: "isolated-session-recovery-auth-secret" });
settings.issuerInternal = "http://localhost:3950/refresh-provider";
const sessionAuth = createSessionAuth({
  logTag: "recovery-test", cookiePrefix: "recovery", keycloak: settings,
  store: { ...store, setSession: async (id, data) => { sessionId = id; await store.setSession(id, data); } },
  admit: claims => Boolean(claims.accessTokenClaims?.sub), initialFields: () => ({}),
  refreshedFields: () => ({}), refreshInvariant: () => undefined, sessionFields: () => ({}),
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 3950, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/auth/")) {
    const handler = request.method === "POST" ? sessionAuth.handlers.POST : sessionAuth.handlers.GET;
    return handler(new NextRequest(request));
  }
  if (url.pathname.startsWith("/refresh-provider/")) {
    calls++;
    if (mode === "rate-limit") return Response.json({ error: "temporarily_unavailable" }, { status: 429, headers: { "Retry-After": "1" } });
    if (mode === "stalled") return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":')); },
      cancel() { canceled = true; },
    }), { headers: { "Content-Type": "application/json" } });
    return fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: await request.text() });
  }
  if (url.pathname === "/test/state") {
    const stored = sessionId ? await store.getSession(sessionId) : null;
    return Response.json({ exists: Boolean(stored), error: stored?.error ?? null, calls, canceled });
  }
  if (url.pathname === "/test/expire" && request.method === "POST") {
    const requested = await request.json() as { mode: typeof mode };
    if (!["healthy", "rate-limit", "stalled"].includes(requested.mode) || !sessionId) return new Response(null, { status: 400 });
    const stored = await store.getSession(sessionId);
    if (!stored) return new Response(null, { status: 404 });
    mode = requested.mode; calls = 0; canceled = false;
    await store.updateSession(sessionId, { ...stored, expiresAt: Math.floor(Date.now() / 1000) - 1, error: undefined, refreshRetryAt: undefined });
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/test/recover" && request.method === "POST") {
    mode = "healthy";
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/login") {
    const csrf = await sessionAuth.handlers.GET(new NextRequest(new URL("/api/auth/csrf", request.url), { headers: request.headers }));
    const body = await csrf.json();
    const headers = new Headers({ "content-type": "text/html" });
    for (const cookie of csrf.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return new Response(`<h1>Session recovery test</h1><form method="post" action="/api/auth/signin/keycloak"><input type="hidden" name="csrfToken" value="${body.csrfToken}"><input type="hidden" name="callbackUrl" value="http://localhost:3950/"><button>Sign in with Keycloak</button></form>`, { headers });
  }
  return new Response('<h1>Session recovery test</h1><p>The authenticated session is verified through /api/auth/session.</p>', { headers: { "content-type": "text/html" } });
} });
const close = async () => { server.stop(true); if (sessionId) await store.deleteSession(sessionId); store.resetForTests(); process.exit(0); };
process.on("SIGTERM", close); process.on("SIGINT", close);
