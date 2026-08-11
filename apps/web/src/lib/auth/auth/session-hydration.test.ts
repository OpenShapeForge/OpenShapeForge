// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { StoredSession } from "../redis";
import { hydrateStoredSessionProfile } from "./session-hydration";

test("profile hydration cannot recreate a session deleted before its CAS", async () => {
  const sessionId = "session-under-test";
  const captured: StoredSession = { sub: "test-user" };
  let persisted: StoredSession | null = captured;
  let replaceCalls = 0;

  const result = await hydrateStoredSessionProfile(sessionId, captured, {
    replaceSession: async (requestedId, expected, replacement) => {
      expect(requestedId).toBe(sessionId);
      expect(expected).toBe(captured);
      expect(replacement.name).toBe("test-user");
      replaceCalls += 1;
      persisted = null;
      return false;
    },
    getSession: async () => persisted,
  });

  expect(result).toBeNull();
  expect(persisted).toBeNull();
  expect(replaceCalls).toBe(1);
});
