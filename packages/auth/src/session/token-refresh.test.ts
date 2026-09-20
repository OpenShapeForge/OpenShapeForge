// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { createTokenRefresh, type TokenRefreshOptions } from "./token-refresh.js";
import type { SessionStore, StoredSession } from "./store.js";

type Fields = { tenantId?: string | undefined };

const originalFetch = globalThis.fetch;
const originalError = console.error;
const originalWarn = console.warn;
afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  console.warn = originalWarn;
});

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.`;
}

function fakeStore(initial: Record<string, StoredSession<Fields>> = {}): SessionStore<Fields> & {
  records: Map<string, StoredSession<Fields>>;
  locks: Map<string, string>;
} {
  const records = new Map(Object.entries(initial));
  const locks = new Map<string, string>();
  return {
    records,
    locks,
    async getSession(id) { return records.get(id) ?? null; },
    async setSession(id, data) { records.set(id, data); },
    async deleteSession(id) { records.delete(id); },
    async acquireRefreshLock(id) {
      if (locks.has(id)) return null;
      const token = `lock-${id}`;
      locks.set(id, token);
      return token;
    },
    async releaseRefreshLock(id, token) { if (locks.get(id) === token) locks.delete(id); },
    resetForTests() { records.clear(); locks.clear(); },
  };
}

const nowS = () => Math.floor(Date.now() / 1000);

function keycloakResponses(...bodies: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; body: string }> = [];
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    const next = bodies[Math.min(index++, bodies.length - 1)]!;
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function refresher(
  store: SessionStore<Fields>,
  overrides: Partial<TokenRefreshOptions<Fields>> = {},
) {
  return createTokenRefresh<Fields>({
    logTag: "test",
    keycloak: { issuerInternal: "http://keycloak.test/realms/r", clientId: "gateway", clientSecret: "s" },
    store,
    refreshInvariant: (claims, stored) =>
      stored.tenantId && claims.tid !== stored.tenantId ? "tenant changed mid-session" : undefined,
    refreshedFields: (claims, stored) => ({ tenantId: (claims.accessTokenClaims?.tid as string) ?? stored.tenantId }),
    ...overrides,
  });
}

const stored: StoredSession<Fields> = {
  sub: "user-1",
  tenantId: "tenant-a",
  accessToken: jwt({ sub: "user-1", tid: "tenant-a", exp: nowS() - 1 }),
  refreshToken: "refresh-1",
  expiresAt: nowS() - 1,
  refreshExpiresAt: nowS() + 3600,
  roles: ["old-role"],
};

describe("doRefreshAccessToken", () => {
  test("a usable refresh rewrites tokens, roles and the app's own fields", async () => {
    console.error = () => {};
    const calls = keycloakResponses({
      status: 200,
      body: {
        access_token: jwt({ sub: "user-1", tid: "tenant-a", exp: nowS() + 300, realm_access: { roles: ["new-role"] } }),
        expires_in: 300,
        refresh_token: "refresh-2",
        refresh_expires_in: 7200,
      },
    });

    const refreshed = await refresher(fakeStore()).doRefreshAccessToken(stored);

    expect(refreshed.error).toBeUndefined();
    expect(refreshed.roles).toEqual(["new-role"]);
    expect(refreshed.refreshToken).toBe("refresh-2");
    expect(refreshed.tenantId).toBe("tenant-a");
    expect(refreshed.expiresAt).toBeGreaterThan(nowS() + 290);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://keycloak.test/realms/r/protocol/openid-connect/token");
    expect(calls[0]!.body).toContain("client_id=gateway");
    expect(calls[0]!.body).toContain("refresh_token=refresh-1");
  });

  test("the app's invariant refuses a token that changed the session's authority", async () => {
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    keycloakResponses({
      status: 200,
      body: {
        access_token: jwt({ sub: "user-1", tid: "tenant-b", exp: nowS() + 300, realm_access: { roles: [] } }),
        expires_in: 300,
      },
    });

    const refreshed = await refresher(fakeStore()).doRefreshAccessToken(stored);

    expect(refreshed.error).toBe("RefreshTokenError");
    expect(refreshed.accessToken).toBe(stored.accessToken);
    expect(logged.some((args) => String(args[1]).includes("tenant changed mid-session"))).toBe(true);
  });

  test("a token without role state or with another subject is refused", async () => {
    console.error = () => {};
    const noRoles = jwt({ sub: "user-1", tid: "tenant-a", exp: nowS() + 300 });
    keycloakResponses({ status: 200, body: { access_token: noRoles, expires_in: 300 } });
    expect((await refresher(fakeStore()).doRefreshAccessToken(stored)).error).toBe("RefreshTokenError");

    const otherSubject = jwt({ sub: "user-2", tid: "tenant-a", exp: nowS() + 300, realm_access: { roles: ["r"] } });
    keycloakResponses({ status: 200, body: { access_token: otherSubject, expires_in: 300 } });
    expect((await refresher(fakeStore()).doRefreshAccessToken(stored)).error).toBe("RefreshTokenError");
  });

  test("a 4xx fails fast; a 5xx is retried and then succeeds", async () => {
    console.error = () => {};
    console.warn = () => {};
    const rejected = keycloakResponses({ status: 400, body: { error: "invalid_grant" } });
    expect((await refresher(fakeStore()).doRefreshAccessToken(stored)).error).toBe("RefreshTokenError");
    expect(rejected).toHaveLength(1);

    const retried = keycloakResponses(
      { status: 503 },
      {
        status: 200,
        body: {
          access_token: jwt({ sub: "user-1", tid: "tenant-a", exp: nowS() + 300, realm_access: { roles: ["r"] } }),
          expires_in: 300,
        },
      },
    );
    const refreshed = await refresher(fakeStore()).doRefreshAccessToken(stored);
    expect(refreshed.error).toBeUndefined();
    expect(retried).toHaveLength(2);
  });
});

describe("refreshSessionInRedis", () => {
  test("holds the distributed lock around the refresh and persists the result", async () => {
    console.error = () => {};
    const store = fakeStore({ "s1": stored });
    keycloakResponses({
      status: 200,
      body: {
        access_token: jwt({ sub: "user-1", tid: "tenant-a", exp: nowS() + 300, realm_access: { roles: ["r"] } }),
        expires_in: 300,
      },
    });

    const refreshed = await refresher(store).refreshSessionInRedis("s1", stored);

    expect(refreshed.error).toBeUndefined();
    expect(store.records.get("s1")?.accessToken).toBe(refreshed.accessToken);
    expect(store.locks.size).toBe(0);
  });

  test("a lock held by another pod past the wait leaves the cookie alone", async () => {
    console.error = () => {};
    const store = fakeStore({ "s1": stored });
    store.locks.set("s1", "held-elsewhere");
    const calls = keycloakResponses({ status: 500 });

    const result = await refresher(store).refreshSessionInRedis("s1", stored);

    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(store.records.get("s1")).toBe(stored);
  }, 10_000);

  test("after taking the lock it refreshes the record another pod just wrote", async () => {
    console.error = () => {};
    const rotated: StoredSession<Fields> = { ...stored, refreshToken: "refresh-rotated" };
    const store = fakeStore({ "s1": rotated });
    const calls = keycloakResponses({
      status: 200,
      body: {
        access_token: jwt({ sub: "user-1", tid: "tenant-a", exp: nowS() + 300, realm_access: { roles: ["r"] } }),
        expires_in: 300,
      },
    });

    await refresher(store).refreshSessionInRedis("s1", stored);

    expect(calls[0]!.body).toContain("refresh_token=refresh-rotated");
  });

  test("a session gone from Redis is not resurrected from the snapshot", async () => {
    console.error = () => {};
    const store = fakeStore();
    const calls = keycloakResponses({ status: 200, body: {} });

    const result = await refresher(store).refreshSessionInRedis("s1", stored);

    expect(result.error).toBe("RefreshTokenError");
    expect(calls).toHaveLength(0);
    expect(store.records.has("s1")).toBe(false);
  });

  test("concurrent callers in one process share a single refresh", async () => {
    console.error = () => {};
    const store = fakeStore({ "s1": stored });
    const calls = keycloakResponses({
      status: 200,
      body: {
        access_token: jwt({ sub: "user-1", tid: "tenant-a", exp: nowS() + 300, realm_access: { roles: ["r"] } }),
        expires_in: 300,
      },
    });
    const refresh = refresher(store);

    const [a, b] = await Promise.all([
      refresh.refreshSessionInRedis("s1", stored),
      refresh.refreshSessionInRedis("s1", stored),
    ]);

    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });
});
