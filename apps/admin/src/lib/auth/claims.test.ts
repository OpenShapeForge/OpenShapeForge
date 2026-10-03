// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { createTokenRefresh, type SessionStore } from "@openshapeforge/auth/session";
import { hasPlatformOperatorRole, operatorRefreshInvariant } from "./claims";

describe("operator refresh invariant", () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  const jwt = (claims: Record<string, unknown>) =>
    `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
  const nowS = () => Math.floor(Date.now() / 1000);
  const store: SessionStore = {
    async getSession() { return null; },
    async setSession() {},
    async deleteSession() {},
    async acquireRefreshLock() { return "lock"; },
    async releaseRefreshLock() {},
    resetForTests() {},
  };
  const refresh = createTokenRefresh({
    logTag: "test",
    keycloak: { issuerInternal: "http://keycloak.test/realms/control", clientId: "c", clientSecret: "s" },
    store,
    refreshInvariant: operatorRefreshInvariant,
    refreshedFields: () => ({}),
  });
  const stored = { sub: "op", refreshToken: "r", roles: ["platform-operator"] };
  const answer = (roles: string[]) => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: jwt({ sub: "op", exp: nowS() + 300, realm_access: { roles } }), expires_in: 300 }),
        { status: 200 },
      )) as unknown as typeof fetch;
  };

  test("a token that lost platform-operator ends the session", async () => {
    const reasons: string[] = [];
    console.error = (...args: unknown[]) => { reasons.push(String(args[1])); };
    answer(["something-else"]);
    const refreshed = await refresh.doRefreshAccessToken(stored);
    expect(refreshed.error).toBe("RefreshTokenError");
    expect(reasons).toEqual(["refreshed token no longer carries the operator role"]);
  });

  test("a token that keeps the role continues, without a tenant", async () => {
    answer(["platform-operator"]);
    const refreshed = await refresh.doRefreshAccessToken(stored);
    expect(refreshed.error).toBeUndefined();
    expect(hasPlatformOperatorRole(refreshed.roles ?? [])).toBe(true);
    expect("tenantId" in refreshed).toBe(false);
  });
});
