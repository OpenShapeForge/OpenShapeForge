// SPDX-License-Identifier: BUSL-1.1
/**
 * Rate-limit boundary tests. These build the real Fastify app (no database —
 * createApiApp runs GraphQL without one) and drive it with app.inject, so they
 * exercise the actual @fastify/rate-limit wiring without a network or DB.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/roles 2>&1
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { createApiApp } from "../api.js";

const RATE_LIMIT_MAX_ENV = "API_RATE_LIMIT_MAX";
const originalMax = process.env[RATE_LIMIT_MAX_ENV];
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (originalMax === undefined) delete process.env[RATE_LIMIT_MAX_ENV];
  else process.env[RATE_LIMIT_MAX_ENV] = originalMax;
});

describe("API rate limiting", () => {
  test("throttles a non-exempt route with 429 + Retry-After once the budget is spent", async () => {
    process.env[RATE_LIMIT_MAX_ENV] = "3";
    app = createApiApp();

    // The first `max` requests are admitted (whatever the handler returns);
    // the very next one is rejected by the limiter.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/api/graphql?query=%7B__typename%7D" });
      expect(res.statusCode).not.toBe(429);
    }

    const limited = await app.inject({ method: "GET", url: "/api/graphql?query=%7B__typename%7D" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    // Body carries a generic message, not limiter internals.
    expect(limited.json()).toMatchObject({ statusCode: 429, error: "Too Many Requests" });
  });

  test("liveness/readiness probes are never throttled", async () => {
    process.env[RATE_LIMIT_MAX_ENV] = "1";
    app = createApiApp();

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
    }
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/api/ready" });
      expect(res.statusCode).toBe(200);
    }
  });
});
