// SPDX-License-Identifier: BUSL-1.1
/**
 * A Keycloak that accepts the connection and never answers must not hold an
 * API-key request (or a provisioning call) open indefinitely: every fetch is
 * bounded by the control plane's Keycloak request timeout. The bound is
 * shortened here so the test does not wait the full ten seconds.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { REQUEST_TIMEOUT_MS } from "../../control/keycloak-service-account.js";
import { encryptSecret, keyringFromEnv } from "../../platform/secrets.js";
import { __resetExchangeCacheForTests, exchangeForToken } from "./exchange.js";
import { KeycloakAdmin } from "./keycloak-admin.js";

const realTimeout = AbortSignal.timeout;
let requested: number[] = [];

beforeEach(() => {
  requested = [];
  AbortSignal.timeout = (ms: number) => {
    requested.push(ms);
    return realTimeout.call(AbortSignal, 20);
  };
  __resetExchangeCacheForTests();
});
afterEach(() => {
  AbortSignal.timeout = realTimeout;
});

/** Answers only by rejecting when the caller's signal aborts; without one it hangs. */
const hangingFetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
})) as typeof fetch;

/** Rejects instead of hanging the test run when the code under test passed no signal. */
function within<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("fetch was never aborted")), 1_000))]);
}

test("the token exchange aborts a Keycloak that never answers", async () => {
  const keyring = keyringFromEnv(`fixture:${Buffer.alloc(32, 7).toString("base64")}`)!;
  const secret = encryptSecret(keyring, "integration-1", "clientSecret", "client-secret");
  const exchange = exchangeForToken({ issuer: "https://keycloak.example.test/realms/tenants", keyring, fetch: hangingFetch },
    "integration-1", "api-key-client", secret);
  await expect(within(exchange)).rejects.toMatchObject({ name: "TimeoutError" });
  expect(requested).toEqual([REQUEST_TIMEOUT_MS]);
});

test("the provisioning admin client aborts a Keycloak that never answers", async () => {
  const admin = new KeycloakAdmin({ baseUrl: "https://keycloak.example.test", realm: "tenants",
    clientId: "openshapeforge-apikey-provisioner", clientSecret: "local-only", fetch: hangingFetch });
  await expect(within(admin.clientExists("api-key-client"))).rejects.toMatchObject({ name: "TimeoutError" });
  expect(requested).toEqual([REQUEST_TIMEOUT_MS]);

  // Past the admin token, the admin request itself is bounded as well.
  requested = [];
  let calls = 0;
  const tokenThenHang = ((url: string, init?: RequestInit) => calls++ === 0
    ? Promise.resolve(Response.json({ access_token: "admin-token", expires_in: 300 }))
    : hangingFetch(url, init)) as typeof fetch;
  const bounded = new KeycloakAdmin({ baseUrl: "https://keycloak.example.test", realm: "tenants",
    clientId: "openshapeforge-apikey-provisioner", clientSecret: "local-only", fetch: tokenThenHang });
  await expect(within(bounded.clientExists("api-key-client"))).rejects.toMatchObject({ name: "TimeoutError" });
  expect(requested).toEqual([REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS]);
});
