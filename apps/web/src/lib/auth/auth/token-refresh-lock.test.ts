// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { StoredSession } from "../redis";
import { refreshSessionWithDistributedLock } from "./token-refresh";

test("a refresh waiter cannot recreate a session deleted before lock retry", async () => {
  const sessionId = "session-under-test";
  const capturedBeforeLogout: StoredSession = {
    sub: "test-user",
    accessToken: "expired-test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: 1,
  };
  let stored: StoredSession | null = capturedBeforeLogout;
  let acquireCalls = 0;
  let refreshCalls = 0;
  let replaceCalls = 0;
  let releaseCalls = 0;

  const result = await refreshSessionWithDistributedLock(
    sessionId,
    capturedBeforeLogout,
    {
      acquireLock: async (requestedId) => {
        expect(requestedId).toBe(sessionId);
        acquireCalls += 1;
        return acquireCalls === 1 ? null : "test-lock-owner";
      },
      wait: async (delayMs) => {
        expect(delayMs).toBe(2000);
        // The exact race: logout acquires the lock held by the first refresher,
        // deletes the record, and releases it while this waiter sleeps.
        stored = null;
      },
      getSession: async (requestedId) => {
        expect(requestedId).toBe(sessionId);
        return stored;
      },
      refresh: async () => {
        refreshCalls += 1;
        return capturedBeforeLogout;
      },
      replaceSession: async () => {
        replaceCalls += 1;
        return true;
      },
      releaseLock: async (requestedId, ownerToken) => {
        expect(requestedId).toBe(sessionId);
        expect(ownerToken).toBe("test-lock-owner");
        releaseCalls += 1;
      },
    },
  );

  expect(result.error).toBe("RefreshTokenError");
  expect(stored).toBeNull();
  expect(acquireCalls).toBe(2);
  expect(refreshCalls).toBe(0);
  expect(replaceCalls).toBe(0);
  expect(releaseCalls).toBe(1);
});

test("an expired lock cannot let refresh recreate a session deleted before CAS", async () => {
  const sessionId = "session-under-test";
  const captured: StoredSession = {
    sub: "test-user",
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
  let getCalls = 0;
  let replaceCalls = 0;
  let releaseCalls = 0;

  const result = await refreshSessionWithDistributedLock(sessionId, captured, {
    acquireLock: async () => "expired-owner-token",
    wait: async () => {},
    getSession: async () => {
      getCalls += 1;
      return persisted;
    },
    refresh: async () => refreshed,
    replaceSession: async (requestedId, expected, replacement) => {
      expect(requestedId).toBe(sessionId);
      expect(expected).toBe(captured);
      expect(replacement).toBe(refreshed);
      replaceCalls += 1;

      // The refresh lock expires after the final GET. Logout then atomically
      // consumes the record before this single-key CAS executes.
      persisted = null;
      return false;
    },
    releaseLock: async (_requestedId, ownerToken) => {
      expect(ownerToken).toBe("expired-owner-token");
      releaseCalls += 1;
    },
  });

  expect(result.error).toBe("RefreshTokenError");
  expect(persisted).toBeNull();
  expect(getCalls).toBe(3);
  expect(replaceCalls).toBe(1);
  expect(releaseCalls).toBe(1);
});
