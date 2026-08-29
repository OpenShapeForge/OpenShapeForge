// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { StoredSession } from "../redis";
import { hydrateStoredSessionProfile } from "./session-hydration";

test("admin profile hydration cannot recreate a logged-out session", async () => {
  const sessionId = "admin-session-under-test";
  const captured: StoredSession = { sub: "test-operator" };
  let persisted: StoredSession | null = captured;
  let replaceCalls = 0;

  const result = await hydrateStoredSessionProfile(sessionId, captured, {
    replaceSession: async (_requestedId, _expected, replacement) => {
      expect(replacement.name).toBe("test-operator");
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
