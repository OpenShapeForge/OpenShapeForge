// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import type { OperationContract } from "../../operations/runtime.js";
import { createApiApp } from "../api.js";

const originalAliases = process.env.OPENSHAPEFORGE_ROUTE_ALIASES;
let app: FastifyInstance | undefined;

const aliasedOperation: OperationContract = {
  key: "demo.read",
  plugin: "demo",
  title: "Read demo",
  description: "Reads a demo value.",
  handler: "readDemo",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: {},
  errors: [],
  auth: { mode: "public" },
  tenancy: { mode: "none" },
  idempotency: { mode: "none" },
  transports: {
    rest: {
      method: "GET",
      path: "/api/demo/read",
      aliases: ["/api/legacy/read"],
      response: { kind: "json" },
    },
    mcp: { enabled: false, reason: "REST startup fixture." },
    graphql: { enabled: false, reason: "REST startup fixture." },
    typescript: { enabled: false, reason: "REST startup fixture." },
  },
};

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (originalAliases === undefined) {
    delete process.env.OPENSHAPEFORGE_ROUTE_ALIASES;
  } else {
    process.env.OPENSHAPEFORGE_ROUTE_ALIASES = originalAliases;
  }
});

describe("deployment route aliases", () => {
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

  test("refuses unaudited module routes when compiled REST aliases exist", async () => {
    delete process.env.OPENSHAPEFORGE_ROUTE_ALIASES;
    app = createApiApp({
      cors: false,
      operationContracts: [aliasedOperation],
      modules: {
        loaded: [{
          name: "legacy",
          restRoutes(routes) {
            routes.get("/legacy", async () => ({ ok: true }));
          },
        }],
        failures: [],
      },
    });
    await expect(app.ready()).rejects.toThrow(
      /REST aliases require every module route.*legacy.*PluginOperationContract/,
    );
  });

  test("preserves legacy module routes when no compiled REST alias exists", async () => {
    delete process.env.OPENSHAPEFORGE_ROUTE_ALIASES;
    app = createApiApp({
      cors: false,
      operationContracts: [],
      modules: {
        loaded: [{
          name: "legacy",
          restRoutes(routes) {
            routes.get("/legacy", async () => ({ ok: true }));
          },
        }],
        failures: [],
      },
    });
    const response = await app.inject({ method: "GET", url: "/legacy" });
    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toEqual({ ok: true });
  });
});
