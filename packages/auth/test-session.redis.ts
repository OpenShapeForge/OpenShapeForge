// SPDX-License-Identifier: BUSL-1.1
/** Run explicitly against an isolated Redis: REDIS_URL=... bun test ./test-session.redis.ts. */
import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { createSessionStore } from "./src/session/store.js";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL must name an isolated test Redis.");
const prefix = `session-regression-${randomUUID()}`;
const store = createSessionStore({ keyPrefix: prefix, logTag: "session-regression" });
const redis = new Redis(process.env.REDIS_URL);
const key = `${prefix}:session:s1`;
const lock = `{${key}}:refresh-lock`;
afterAll(async () => {
  await redis.del(key, lock);
  store.resetForTests();
  await redis.quit();
});

test("Redis atomically fences an expired holder, preserves the new holder and refuses logout resurrection", async () => {
  await store.setSession("s1", { sub: "test-person", refreshToken: "initial" });
  const first = (await store.acquireRefreshLock("s1"))!;
  expect(first).toBeTruthy();
  expect(await store.acquireRefreshLock("s1")).toBeNull();
  expect(await store.updateSession("s1", { refreshToken: "first" }, first)).toBe(true);
  // Expire the old lease on the server; do not substitute a mocked lock map.
  await redis.pexpire(lock, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = (await store.acquireRefreshLock("s1"))!;
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  expect(await store.updateSession("s1", { refreshToken: "second" }, second)).toBe(true);
  expect(await store.updateSession("s1", { refreshToken: "stale" }, first)).toBe(false);
  await store.releaseRefreshLock("s1", first);
  expect(await store.acquireRefreshLock("s1")).toBeNull();
  expect((await store.getSession("s1"))?.refreshToken).toBe("second");
  await store.deleteSession("s1");
  expect(await store.updateSession("s1", { refreshToken: "resurrected" }, second)).toBe(false);
  expect(await store.getSession("s1")).toBeNull();
  await store.releaseRefreshLock("s1", second);
});
