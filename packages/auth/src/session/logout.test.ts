// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import type { Session } from "next-auth";
import { createLogoutHandler } from "./logout.js";

const keycloak = { logoutUrl: "https://identity.example.test/realms/app/protocol/openid-connect/logout", clientId: "app" };
const originalError = console.error;
afterEach(() => {
  console.error = originalError;
});

function harness(session: Partial<Session> | null, failures: { auth?: boolean; delete?: boolean } = {}) {
  const calls = { deleted: [] as string[], signedOut: 0 };
  console.error = () => {};
  const logout = createLogoutHandler({
    logTag: "test",
    keycloak,
    auth: async () => {
      if (failures.auth) throw new Error("redis down");
      return session as Session | null;
    },
    deleteSession: async (id) => {
      if (failures.delete) throw new Error("redis down");
      calls.deleted.push(id);
    },
    signOut: async () => {
      calls.signedOut += 1;
    },
  });
  return { logout, calls };
}

test("deletes the stored session, clears the cookie and ends the Keycloak session", async () => {
  const { logout, calls } = harness({ sessionId: "s-1", idToken: "id.token.value" });
  const response = await logout();
  expect(calls).toEqual({ deleted: ["s-1"], signedOut: 1 });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(keycloak.logoutUrl);
  expect(location.searchParams.get("client_id")).toBe("app");
  expect(location.searchParams.get("id_token_hint")).toBe("id.token.value");
});

test("still clears the cookie when there is no session or the store fails", async () => {
  for (const [session, failures] of [
    [null, {}],
    [{ sessionId: "s-2" }, { delete: true }],
    [{ sessionId: "s-3" }, { auth: true }],
  ] as const) {
    const { logout, calls } = harness(session, failures);
    const response = await logout();
    expect(calls.signedOut).toBe(1);
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.has("id_token_hint")).toBe(false);
  }
});
