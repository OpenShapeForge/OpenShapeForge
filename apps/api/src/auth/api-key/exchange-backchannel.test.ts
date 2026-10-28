// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import { encryptSecret, keyringFromEnv } from "../../platform/secrets.js";
import { __resetExchangeCacheForTests, exchangeForToken } from "./exchange.js";

afterEach(__resetExchangeCacheForTests);
test("API key exchange uses the configured backchannel without changing the issuer", async () => {
  const keyring = keyringFromEnv(`test:${Buffer.alloc(32, 7).toString("base64")}`)!;
  const secret = encryptSecret(keyring, "integration-1", "clientSecret", "synthetic-secret");
  const urls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({ access_token: "synthetic-token", expires_in: 60 });
  }) as typeof fetch;
  const issuer = "https://auth.example.test/realms/example";
  const tokenUrl = "http://keycloak.internal:8181/realms/example/protocol/openid-connect/token";
  expect(await exchangeForToken({ issuer, tokenUrl, keyring, fetch: fakeFetch }, "integration-1", "client", secret)).toBe("synthetic-token");
  expect(urls).toEqual([tokenUrl]);
  __resetExchangeCacheForTests();
  expect(await exchangeForToken({ issuer, keyring, fetch: fakeFetch }, "integration-1", "client", secret)).toBe("synthetic-token");
  expect(urls[1]).toBe(`${issuer}/protocol/openid-connect/token`);
});
