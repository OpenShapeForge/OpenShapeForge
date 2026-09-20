// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { createTokenRefresh, type SessionStore } from "@openshapeforge/auth/session";
import {
  hasApplicationTenantContext,
  parseAuthorizationRoles,
  refreshedTenantFields,
  resolveInitialGroups,
  resolveInitialTenantId,
  tenantRefreshInvariant,
  type TenantSessionFields,
} from "./claims";

describe("web authentication claims", () => {
  test("accepts tenant identities without hard-coded product personas", () => {
    expect(hasApplicationTenantContext({ tid: "tenant-a" }, undefined, undefined)).toBe(true);
    expect(hasApplicationTenantContext(undefined, { tid: "tenant-b" }, undefined)).toBe(true);
    expect(hasApplicationTenantContext(undefined, undefined, { tid: "  " })).toBe(false);
    expect(hasApplicationTenantContext(undefined, undefined, undefined)).toBe(false);
  });

  test("keeps every authored realm and client role for generated UI authorization", () => {
    expect(parseAuthorizationRoles({
      realm_access: { roles: ["realm-reader"] },
      resource_access: {
        "resource-api": { roles: ["Data.All.Read"] },
        "application-api": { roles: ["Application.Editor"] },
      },
    })).toEqual(["realm-reader", "Data.All.Read", "Application.Editor"]);
  });

  test("uses only claims for groups and tenant context", () => {
    expect(resolveInitialGroups(undefined, { groups: ["/tenant-a/editors"] }, undefined)).toEqual([
      "/tenant-a/editors",
    ]);
    expect(resolveInitialGroups(undefined, undefined, { tid: "tenant-a" })).toEqual([]);
    expect(resolveInitialTenantId({ tid: 7 }, { tid: "tenant-a" }, undefined)).toBe("tenant-a");
  });
});

describe("tenant refresh invariant", () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  const jwt = (claims: Record<string, unknown>) =>
    `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
  const nowS = () => Math.floor(Date.now() / 1000);
  const store: SessionStore<TenantSessionFields> = {
    async getSession() { return null; },
    async setSession() {},
    async deleteSession() {},
    async acquireRefreshLock() { return "lock"; },
    async releaseRefreshLock() {},
    resetForTests() {},
  };
  const refresh = createTokenRefresh<TenantSessionFields>({
    logTag: "test",
    keycloak: { issuerInternal: "http://keycloak.test/realms/r", clientId: "c", clientSecret: "s" },
    store,
    refreshInvariant: tenantRefreshInvariant,
    refreshedFields: refreshedTenantFields,
  });
  const stored = { sub: "u", tenantId: "tenant-a", refreshToken: "r", groups: ["/tenant-a/editors"] };
  const answer = (claims: Record<string, unknown>) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: jwt(claims), expires_in: 300 }), { status: 200 })) as unknown as typeof fetch;
  };

  test("refuses a refreshed token without a tenant or from another tenant", async () => {
    const reasons: string[] = [];
    console.error = (...args: unknown[]) => { reasons.push(String(args[1])); };

    answer({ sub: "u", exp: nowS() + 300, realm_access: { roles: ["r"] } });
    expect((await refresh.doRefreshAccessToken(stored)).error).toBe("RefreshTokenError");
    answer({ sub: "u", tid: "tenant-b", exp: nowS() + 300, realm_access: { roles: ["r"] } });
    expect((await refresh.doRefreshAccessToken(stored)).error).toBe("RefreshTokenError");

    expect(reasons).toEqual(["refreshed token carries no tenant", "tenant changed mid-session"]);
  });

  test("keeps the tenant, refreshes groups and actor type from the new token", async () => {
    answer({ sub: "u", tid: "tenant-a", act: "employee", groups: ["/tenant-a/admins"], exp: nowS() + 300, realm_access: { roles: ["r"] } });
    const refreshed = await refresh.doRefreshAccessToken(stored);
    expect(refreshed.error).toBeUndefined();
    expect(refreshed.tenantId).toBe("tenant-a");
    expect(refreshed.actorType).toBe("employee");
    expect(refreshed.groups).toEqual(["/tenant-a/admins"]);
  });
});
