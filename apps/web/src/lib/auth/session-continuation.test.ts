// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { readSessionContinuation, sessionContinuationRetryAt } from "./session-continuation.js";

test("Continue keeps a recoverable session through provider and transport failures", async () => {
  for (const status of [429, 500, 503]) {
    expect((await readSessionContinuation(async () => new Response("", { status }))).state).toBe("unavailable");
  }
  expect((await readSessionContinuation(async () => { throw new Error("offline"); })).state).toBe("unavailable");
  const session = { error: "RefreshTokenUnavailable", accessToken: "", refreshRetryAt: Date.now() + 1000 };
  expect(await readSessionContinuation(async () => Response.json(session))).toMatchObject({ state: "unavailable", session });
  expect((await readSessionContinuation(async () => Response.json({ accessToken: "renewed" }))).state).toBe("ready");
});

test("Continue ends a definitively missing or rejected session", async () => {
  for (const session of [null, {}, { error: "RefreshTokenError", accessToken: "old" }]) {
    expect((await readSessionContinuation(async () => Response.json(session))).state).toBe("expired");
  }
  expect((await readSessionContinuation(async () => new Response("", { status: 401 }))).state).toBe("expired");
});

test("recovery backs off through stale server hints and respects future pacing", () => {
  const now = 100_000;
  expect(Array.from({ length: 8 }, (_, attempt) => sessionContinuationRetryAt(now, attempt, now - 1) - now))
    .toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  expect(sessionContinuationRetryAt(now, 0, now + 60_000)).toBe(now + 60_000);
  expect(sessionContinuationRetryAt(now, 0, Number.NaN)).toBe(now + 1000);
});
