// SPDX-License-Identifier: BUSL-1.1
/**
 * The exchanged-token cache never serves a token across a role change.
 *
 * A token is minted with whatever roles the realm held when it was exchanged,
 * so one exchanged before a role change — cached, or still in flight when the
 * change landed — must not answer a request made after the change committed.
 * The cache and the in-flight map are therefore keyed by the integration row's
 * roles version, which every request reads (store.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { encryptSecret, keyringFromEnv } from "../../platform/secrets.js";
import {
  __resetExchangeCacheForTests,
  exchangeForToken,
  invalidateIntegrationToken,
} from "./exchange.js";

afterEach(__resetExchangeCacheForTests);

const keyring = keyringFromEnv(`test:${Buffer.alloc(32, 9).toString("base64")}`)!;
const secret = encryptSecret(keyring, "integration-1", "clientSecret", "synthetic-secret");
const issuer = "https://auth.example.test/realms/example";

/** A token endpoint whose answers the test releases one by one, in order. */
function heldTokenEndpoint() {
  const waiting: Array<() => void> = [];
  let minted = 0;
  const fetch = (async () => {
    const token = `token-${++minted}`;
    await new Promise<void>((release) => waiting.push(release));
    return Response.json({ access_token: token, expires_in: 900 });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    get exchanges() { return minted; },
    release: async (index: number) => {
      while (!waiting[index]) await Bun.sleep(1);
      waiting[index]!();
    },
  };
}

const exchange = (endpoint: { fetch: typeof fetch }, rolesVersion: string) =>
  exchangeForToken({ issuer, keyring, fetch: endpoint.fetch }, "integration-1", "client", secret, rolesVersion);

describe("the exchanged-token cache across a role change", () => {
  test("a token in flight when the roles changed answers no request made after the change", async () => {
    const endpoint = heldTokenEndpoint();
    // A request under the old roles starts an exchange the realm answers late.
    const before = exchange(endpoint, "v1");
    // The role change commits: the row is now v2, and the process drops what
    // it holds for the integration.
    invalidateIntegrationToken("integration-1");
    const after = exchange(endpoint, "v2");
    expect(endpoint.exchanges).toBe(2);

    // The old exchange lands first and is cached — under v1, which no request
    // reads any more.
    await endpoint.release(0);
    expect(await before).toBe("token-1");
    await endpoint.release(1);
    expect(await after).toBe("token-2");

    // Whatever order the two landed in, v2 is never answered with token-1.
    const again = exchange(endpoint, "v2");
    if (endpoint.exchanges === 3) await endpoint.release(2);
    expect(await again).not.toBe("token-1");
  });

  test("a stale exchange landing after the new token can only cost an extra exchange", async () => {
    const endpoint = heldTokenEndpoint();
    const before = exchange(endpoint, "v1");
    const after = exchange(endpoint, "v2");
    await endpoint.release(1);
    expect(await after).toBe("token-2");
    // The v1 exchange resolves last and displaces the v2 entry.
    await endpoint.release(0);
    expect(await before).toBe("token-1");

    const next = exchange(endpoint, "v2");
    await endpoint.release(2);
    expect(await next).toBe("token-3");
    // And v2 is cached again from then on.
    expect(await exchange(endpoint, "v2")).toBe("token-3");
    expect(endpoint.exchanges).toBe(3);
  });

  test("a request of the same version does not join an exchange that invalidation dropped", async () => {
    const endpoint = heldTokenEndpoint();
    const first = exchange(endpoint, "v1");
    invalidateIntegrationToken("integration-1");
    const second = exchange(endpoint, "v1");
    expect(endpoint.exchanges).toBe(2);
    await endpoint.release(0);
    await endpoint.release(1);
    expect(await first).toBe("token-1");
    expect(await second).toBe("token-2");
  });

  test("an unchanged version is still served from the cache", async () => {
    const endpoint = heldTokenEndpoint();
    const first = exchange(endpoint, "v1");
    const joined = exchange(endpoint, "v1");
    await endpoint.release(0);
    expect(await first).toBe("token-1");
    expect(await joined).toBe("token-1");
    expect(await exchange(endpoint, "v1")).toBe("token-1");
    expect(endpoint.exchanges).toBe(1);
  });
});
