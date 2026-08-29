// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { StoredSession } from "../redis";
import { refreshSessionWithDistributedLock } from "./token-refresh";

test("admin refresh cannot recreate a session deleted before lock retry", async () => {
  const sessionId = "admin-session-under-test";
  const captured: StoredSession = {
    sub: "test-operator",
    accessToken: "expired-test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: 1,
  };
  let persisted: StoredSession | null = captured;
  let acquireCalls = 0;
  let replaceCalls = 0;

  const result = await refreshSessionWithDistributedLock(sessionId, captured, {
    acquireLock: async () => {
      acquireCalls += 1;
      return acquireCalls === 1 ? null : "test-owner-token";
    },
    wait: async () => {
      persisted = null;
    },
    getSession: async () => persisted,
    refresh: async () => captured,
    replaceSession: async () => {
      replaceCalls += 1;
      return true;
    },
    releaseLock: async () => {},
  });

  expect(result.error).toBe("RefreshTokenError");
  expect(persisted).toBeNull();
  expect(acquireCalls).toBe(2);
  expect(replaceCalls).toBe(0);
});

test("admin refresh cannot recreate a session deleted after its final GET", async () => {
  const sessionId = "admin-session-under-test";
  const captured: StoredSession = {
    sub: "test-operator",
    accessToken: "expired-test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: 1,
  };
  const refreshed: StoredSession = {
    ...captured,
    accessToken: "new-test-access-token",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
  let persisted: StoredSession | null = captured;
  let replaceCalls = 0;

  const result = await refreshSessionWithDistributedLock(sessionId, captured, {
    acquireLock: async () => "expired-owner-token",
    wait: async () => {},
    getSession: async () => persisted,
    refresh: async () => refreshed,
    replaceSession: async () => {
      replaceCalls += 1;
      persisted = null;
      return false;
    },
    releaseLock: async () => {},
  });

  expect(result.error).toBe("RefreshTokenError");
  expect(persisted).toBeNull();
  expect(replaceCalls).toBe(1);
});
