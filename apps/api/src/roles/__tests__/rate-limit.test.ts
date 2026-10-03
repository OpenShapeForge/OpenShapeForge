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
import { applyTrustedContextHeaders } from "@openshapeforge/auth";

const RATE_LIMIT_MAX_ENV = "API_RATE_LIMIT_MAX";
const originalMax = process.env[RATE_LIMIT_MAX_ENV];
const originalTrustProxy = process.env.API_TRUST_PROXY;
const originalContextSecret =
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (originalMax === undefined) delete process.env[RATE_LIMIT_MAX_ENV];
  else process.env[RATE_LIMIT_MAX_ENV] = originalMax;
  if (originalTrustProxy === undefined) delete process.env.API_TRUST_PROXY;
  else process.env.API_TRUST_PROXY = originalTrustProxy;
  if (originalContextSecret === undefined)
    delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  else
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = originalContextSecret;
});

describe("API rate limiting", () => {
  test.each([
    ["default", undefined, 1], ["one", "1", 1], ["two", "2", 2],
  ])("%s trusted proxy hops isolate client budgets and ignore addresses beyond the trusted chain", async (_label, setting, hops) => {
    process.env[RATE_LIMIT_MAX_ENV] = "2";
    if (setting === undefined) delete process.env.API_TRUST_PROXY;
    else process.env.API_TRUST_PROXY = setting;
    app = createApiApp({ cors: false });
    void app.register(async (scope) => {
      scope.get("/test/client-ip", (request) => ({ ip: request.ip }));
    });
    const forwarded = (client: string, spoof?: string) => [spoof, client, ...(hops === 2 ? ["192.0.2.10"] : [])]
      .filter(Boolean).join(", ");
    const call = (client: string, spoof?: string) => app!.inject({
      method: "GET", url: "/test/client-ip", remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": forwarded(client, spoof) },
    });
    expect((await call("203.0.113.7")).json<{ ip: string }>()).toEqual({ ip: "203.0.113.7" });
    expect((await call("203.0.113.7", "198.51.100.1")).statusCode).toBe(200);
    expect((await call("203.0.113.7", "198.51.100.2")).statusCode).toBe(429);
    expect((await call("203.0.113.8")).statusCode).toBe(200);
  });

  test.each(["0", "false"])("%s proxy trust keeps forwarded addresses in the socket's shared budget", async (setting) => {
    process.env[RATE_LIMIT_MAX_ENV] = "1";
    process.env.API_TRUST_PROXY = setting;
    app = createApiApp({ cors: false });
    void app.register(async (scope) => {
      scope.get("/test/client-ip", (request) => ({ ip: request.ip }));
    });
    const call = (client: string) => app!.inject({
      method: "GET", url: "/test/client-ip", remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": client },
    });
    expect((await call("203.0.113.7")).json<{ ip: string }>()).toEqual({ ip: "10.0.0.1" });
    expect((await call("203.0.113.8")).statusCode).toBe(429);
  });

  test("throttles a non-exempt route with 429 + Retry-After once the budget is spent", async () => {
    process.env[RATE_LIMIT_MAX_ENV] = "3";
    app = createApiApp({ cors: false });

    // The first `max` requests are admitted (whatever the handler returns);
    // the very next one is rejected by the limiter.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/graphql?query=%7B__typename%7D",
      });
      expect(res.statusCode).not.toBe(429);
    }

    const limited = await app.inject({
      method: "GET",
      url: "/api/graphql?query=%7B__typename%7D",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    // Body carries a generic message, not limiter internals.
    expect(limited.json()).toMatchObject({
      statusCode: 429,
      error: "Too Many Requests",
    });
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

  test("keeps liveness and readiness probes exempt", async () => {
    process.env[RATE_LIMIT_MAX_ENV] = "1";
    app = createApiApp({
      cors: false,
      readinessChecks: [{ name: "controlled", check: () => undefined }],
    });

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
    }
    expect(
      (await app.inject({ method: "GET", url: "/api/ready" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/ready" })).statusCode,
    ).toBe(200);
  });

  test("keeps metrics private to a signed internal caller", async () => {
    const secret = "metrics-route-test-secret";
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = secret;
    app = createApiApp({ cors: false });
    expect(
      (await app.inject({ method: "GET", url: "/api/metrics" })).statusCode,
    ).toBe(401);

    const headers = new Headers();
    applyTrustedContextHeaders(
      headers,
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        roles: [],
        groups: [],
      },
      { secret },
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: Object.fromEntries(headers),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
  });
});
