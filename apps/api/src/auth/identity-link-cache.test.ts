// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import { __resetIdentityLinkCacheForTests, cachedLinkState, invalidateIdentityLink, linkCacheKey, linkGeneration, storeLinkState } from "./identity-link-session.js";

const realNow = Date.now;
afterEach(() => { Date.now = realNow; __resetIdentityLinkCacheForTests(); });
const key = linkCacheKey("issuer", "subject", "tenant");

test("expiry removes the value and rejects a read that outlives its generation", () => {
  let now = realNow(); Date.now = () => now;
  const generation = linkGeneration(key);
  now += 60_001;
  expect(cachedLinkState(key)).toBeUndefined();
  storeLinkState(key, generation, null);
  expect(cachedLinkState(key)).toBeUndefined();
  storeLinkState(key, linkGeneration(key), null);
  expect(cachedLinkState(key)).toEqual({ state: null });
});

test("invalidation and eviction cannot let an old in-flight read repopulate the cache", () => {
  for (const remove of [() => invalidateIdentityLink("issuer", "subject", "tenant"), () => {
    for (let i = 0; i < 10_000; i++) linkGeneration(`other-${i}`);
  }]) {
    const old = linkGeneration(key);
    remove();
    const current = linkGeneration(key);
    expect(current).not.toBe(old);
    storeLinkState(key, old, null);
    expect(cachedLinkState(key)).toBeUndefined();
    storeLinkState(key, current, null);
    expect(cachedLinkState(key)).toEqual({ state: null });
    __resetIdentityLinkCacheForTests();
  }
});

test("a committed result retires the generation of concurrent older reads", () => {
  const generation = linkGeneration(key);
  storeLinkState(key, generation, null);
  expect(linkGeneration(key)).not.toBe(generation);
  storeLinkState(key, generation, { status: "linked" } as never);
  expect(cachedLinkState(key)).toEqual({ state: null });
});

test("unique identities stay bounded and reading a hot identity preserves it", () => {
  storeLinkState(key, linkGeneration(key), null);
  for (let i = 0; i < 10_000; i++) {
    storeLinkState(`identity-${i}`, linkGeneration(`identity-${i}`), null);
    expect(cachedLinkState(key)).toEqual({ state: null });
  }
  expect(cachedLinkState("identity-0")).toBeUndefined();
  expect(cachedLinkState("identity-9999")).toEqual({ state: null });
  const tenantB = linkCacheKey("issuer", "subject", "other-tenant");
  expect(cachedLinkState(tenantB)).toBeUndefined();
});
