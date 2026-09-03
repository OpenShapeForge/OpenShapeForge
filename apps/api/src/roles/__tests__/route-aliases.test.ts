// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { createApiApp } from "../api.js";

const originalAliases = process.env.OPENSHAPEFORGE_ROUTE_ALIASES;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (originalAliases === undefined) {
    delete process.env.OPENSHAPEFORGE_ROUTE_ALIASES;
  } else {
    process.env.OPENSHAPEFORGE_ROUTE_ALIASES = originalAliases;
  }
});

describe("canonical operational routes", () => {
  test("refuses the obsolete route-alias setting at startup, including when empty", () => {
    for (const value of ["", "/healthz=/api/health"]) {
      process.env.OPENSHAPEFORGE_ROUTE_ALIASES = value;
      expect(() => createApiApp({ cors: false })).toThrow(
        /OPENSHAPEFORGE_ROUTE_ALIASES is no longer supported/,
      );
    }
  });

  test("serves only the canonical liveness path", async () => {
    delete process.env.OPENSHAPEFORGE_ROUTE_ALIASES;
    app = createApiApp({ cors: false });
    const canonical = await app.inject({ method: "GET", url: "/api/health" });
    expect(canonical.statusCode).toBe(200);
    expect(canonical.json() as unknown).toEqual({ status: "ok", role: "api" });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/graphql/health" })).statusCode).toBe(404);
  });
});
