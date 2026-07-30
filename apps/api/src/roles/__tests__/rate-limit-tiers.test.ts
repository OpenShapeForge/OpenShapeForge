// SPDX-License-Identifier: BUSL-1.1
/**
 * Tiered budgets, the shared store, and the limiter counters (#161).
 *
 * The existing rate-limit.test.ts covers the boundary itself; this covers what
 * #161 added on top. The shared-store tests need a Redis/Valkey instance and
 * skip without one — but "skipped" is reported, so a green run cannot be
 * mistaken for a proven one:
 *
 *   docker run -d -p 6399:6379 redis:7-alpine
 *   TEST_REDIS_URL=redis://127.0.0.1:6399 bun test src/roles
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import type { FastifyInstance } from "fastify";
import {
  TRUSTED_CONTEXT_HEADERS,
  applyTrustedContextHeaders,
} from "@openshapeforge/auth";
import { createApiApp } from "../api.js";
import { createRateLimitMetrics, createRedisRateLimitStore } from "../rate-limit.js";

const SECRET = "openshapeforge-local-dev-context-secret";
// Read from a TEST-only variable: setting API_RATE_LIMIT_REDIS_URL for the whole
// run would silently reconfigure every other suite that builds an app.
const REDIS_URL = process.env.TEST_REDIS_URL;
const GRAPHQL_URL = "/api/graphql?query=%7B__typename%7D";

const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

/** Headers a trusted service-to-service caller sends, signed with the shared secret. */
function trustedHeaders(tenantId: string, userId: string): Record<string, string> {
  const headers = new Headers();
  applyTrustedContextHeaders(headers, { tenantId, userId, roles: [] }, { secret: SECRET });
  return Object.fromEntries(headers.entries());
}

describe("tiered budgets", () => {
  test("a signed trusted-context caller gets the trusted budget, not the anonymous one", async () => {
    setEnv("OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET", SECRET);
    setEnv("API_RATE_LIMIT_MAX", "2");
    setEnv("API_RATE_LIMIT_MAX_TRUSTED", "6");
    setEnv("API_RATE_LIMIT_REDIS_URL", undefined);
    app = createApiApp();

    const headers = trustedHeaders("11111111-1111-1111-1111-111111111111", "u1");
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({ method: "GET", url: GRAPHQL_URL, headers });
      expect(res.statusCode).not.toBe(429);
    }
    const limited = await app.inject({ method: "GET", url: GRAPHQL_URL, headers });
    expect(limited.statusCode).toBe(429);
  });

  test("an unsigned caller claiming the same identity stays on the anonymous budget", async () => {
    // The forgery this closes: without signature verification, sending the
    // identity headers alone would buy the higher tier.
    setEnv("OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET", SECRET);
    setEnv("API_RATE_LIMIT_MAX", "2");
    setEnv("API_RATE_LIMIT_MAX_TRUSTED", "6");
    setEnv("API_RATE_LIMIT_REDIS_URL", undefined);
    app = createApiApp();

    const forged = {
      [TRUSTED_CONTEXT_HEADERS.tenantId]: "11111111-1111-1111-1111-111111111111",
      [TRUSTED_CONTEXT_HEADERS.userId]: "u1",
    };
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "GET", url: GRAPHQL_URL, headers: forged });
      expect(res.statusCode).not.toBe(429);
    }
    const limited = await app.inject({ method: "GET", url: GRAPHQL_URL, headers: forged });
    expect(limited.statusCode).toBe(429);
  });

  test("one trusted caller exhausting its budget does not throttle another", async () => {
    setEnv("OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET", SECRET);
    setEnv("API_RATE_LIMIT_MAX", "2");
    setEnv("API_RATE_LIMIT_MAX_TRUSTED", "3");
    setEnv("API_RATE_LIMIT_REDIS_URL", undefined);
    app = createApiApp();

    const first = trustedHeaders("11111111-1111-1111-1111-111111111111", "u1");
    const second = trustedHeaders("22222222-2222-2222-2222-222222222222", "u2");

    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "GET", url: GRAPHQL_URL, headers: first });
    }
    expect((await app.inject({ method: "GET", url: GRAPHQL_URL, headers: first })).statusCode).toBe(429);
    expect((await app.inject({ method: "GET", url: GRAPHQL_URL, headers: second })).statusCode).not.toBe(429);
  });

  test("counts throttled requests per tier without recording the request itself", async () => {
    setEnv("OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET", SECRET);
    setEnv("API_RATE_LIMIT_MAX", "1");
    setEnv("API_RATE_LIMIT_REDIS_URL", undefined);
    app = createApiApp();

    await app.inject({ method: "GET", url: GRAPHQL_URL });
    await app.inject({ method: "GET", url: GRAPHQL_URL });

    const snapshot = app.rateLimitMetrics.snapshot();
    expect(snapshot.throttled.anonymous).toBeGreaterThan(0);
    expect(snapshot.storeErrors).toBe(0);
    // Numbers only — no keys, no paths, no headers.
    expect(Object.keys(snapshot).sort()).toEqual(["allowed", "storeErrors", "throttled"]);
  });
});

describe.skipIf(!REDIS_URL)("shared store", () => {
  test("two instances share ONE budget", async () => {
    // The whole point of #161: with an in-memory store these two apps would
    // each admit `max` requests, so a client would get 2× the budget.
    setEnv("API_RATE_LIMIT_MAX", "3");
    setEnv("API_RATE_LIMIT_REDIS_URL", REDIS_URL);
    setEnv("OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET", undefined);

    // Distinct key prefix per run, so a re-run does not inherit its own counters.
    const client = new RedisClient(REDIS_URL!);
    await client.send("EVAL", ["redis.call('FLUSHDB') return 1", "0"]);
    client.close();

    const first = createApiApp();
    const second = createApiApp();
    try {
      const statuses: number[] = [];
      for (const instance of [first, second, first, second, first, second]) {
        const res = await instance.inject({ method: "GET", url: GRAPHQL_URL });
        statuses.push(res.statusCode);
      }
      // 3 admitted across BOTH instances, then throttled — not 3 each.
      expect(statuses.filter((status) => status === 429).length).toBe(3);
      expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("a store outage does not become an API outage", async () => {
    const metrics = createRateLimitMetrics();
    const errors: unknown[] = [];
    const { Store, close } = createRedisRateLimitStore(
      "redis://127.0.0.1:1", // nothing listens here
      metrics,
      (error) => errors.push(error),
    );
    const store = new Store({});
    const result = await new Promise<Error | null>((resolve) => {
      store.incr("ip:1.2.3.4", (error) => resolve(error), 1000, 10);
    });
    expect(result).toBeTruthy();
    expect(metrics.storeErrors).toBe(1);
    expect(errors.length).toBe(1);
    await close();
  });

  test("a key with no expiry is treated as a full window, not as expired", async () => {
    // PTTL returns -1 for a key without a TTL. Reporting that verbatim as the
    // remaining window would hand the caller a fresh budget every request.
    const metrics = createRateLimitMetrics();
    const { Store, close } = createRedisRateLimitStore(REDIS_URL!, metrics, () => {});
    const store = new Store({});
    const client = new RedisClient(REDIS_URL!);
    await client.send("SET", ["osf-rl:ip:no-ttl", "5"]);

    const result = await new Promise<{ current: number; ttl: number }>((resolve, reject) => {
      store.incr("ip:no-ttl", (error, value) => (error ? reject(error) : resolve(value!)), 60_000, 10);
    });
    expect(result.current).toBe(6);
    expect(result.ttl).toBe(60_000);

    await client.send("DEL", ["osf-rl:ip:no-ttl"]);
    client.close();
    await close();
  });
});

if (!REDIS_URL) {
  // Reported, not silent: a green run without this line proved the shared store.
  console.log(
    "rate-limit-tiers: shared-store tests SKIPPED (set TEST_REDIS_URL to run them).",
  );
}
