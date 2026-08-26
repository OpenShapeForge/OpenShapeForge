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
    app = createApiApp({ cors: false });

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

  // The REST routes and the MCP server each install an encapsulated error
  // handler that runs everything through toHttpError. A limiter rejection is
  // neither an HttpError nor a GraphQLError, so it used to fall through to the
  // redacted 500 — telling a client to retry at exactly the moment the limiter
  // wanted it to back off, and doing so only on these two transports while
  // GraphQL answered 429 correctly.
  for (const [transport, request] of [
    ["REST", { method: "GET" as const, url: "/api/rest/v1/relations" }],
    [
      "MCP",
      {
        method: "POST" as const,
        url: "/api/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      },
    ],
  ] as const) {
    test(`${transport} reports a throttled request as 429, not a redacted 500`, async () => {
      process.env[RATE_LIMIT_MAX_ENV] = "2";
      app = createApiApp({ cors: false });

      let limited: Awaited<ReturnType<FastifyInstance["inject"]>> | undefined;
      for (let i = 0; i < 6 && !limited; i++) {
        const res = await app.inject(request);
        if (res.statusCode === 429) limited = res;
      }

      expect(limited).toBeDefined();
      expect(limited!.headers["retry-after"]).toBeDefined();
      expect(limited!.json()).toMatchObject({
        error: { code: "TOO_MANY_REQUESTS" },
      });
    });
  }

  test("liveness/readiness probes are never throttled", async () => {
    process.env[RATE_LIMIT_MAX_ENV] = "1";
    app = createApiApp({
      cors: false,
      readinessChecks: [{ name: "controlled", check: () => undefined }],
    });

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
