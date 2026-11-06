// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { readSessionContinuation } from "./session-continuation.js";

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
