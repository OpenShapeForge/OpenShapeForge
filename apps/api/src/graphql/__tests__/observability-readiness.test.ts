// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { Registry, type SanitizedErrorReport } from "@openshapeforge/observability";
import type { RuntimeModule } from "../../modules/contract.js";
import { createApiApp } from "../../roles/api.js";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";

function signedMetricsHeaders(secret: string) {
  const headers = new Headers();
  applyTrustedContextHeaders(headers, {
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    roles: [], groups: [],
  }, { secret });
  return Object.fromEntries(headers);
}

const syntheticModule: RuntimeModule = {
  name: "synthetic-observability",
  graphql: () => ({
    queryFields: "syntheticUnexpected(secret: String!): String!",
    resolvers: {
      Query: {
        syntheticUnexpected: (_parent: unknown, input: { secret: string }) => {
          throw new Error(`private resolver value: ${input.secret}`);
        },
      },
    },
  }),
};

describe("operational readiness", () => {
  test("keeps probes exempt and authenticates then rate-limits metrics", async () => {
    const original = process.env.API_RATE_LIMIT_MAX;
    const originalTrusted = process.env.API_RATE_LIMIT_MAX_TRUSTED;
    const originalSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
    const secret = "observability-metrics-test-secret";
    process.env.API_RATE_LIMIT_MAX = "1";
    process.env.API_RATE_LIMIT_MAX_TRUSTED = "1";
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = secret;
    let app = createApiApp({ cors: false, readinessChecks: [] });
    try {
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/ready" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/ready" })).statusCode).toBe(200);

      await app.close();
      app = createApiApp({ cors: false, readinessChecks: [] });
      expect((await app.inject({ method: "GET", url: "/api/metrics" })).statusCode).toBe(401);
      const headers = signedMetricsHeaders(secret);
      expect((await app.inject({ method: "GET", url: "/api/metrics", headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/metrics", headers })).statusCode).toBe(429);
    } finally {
      await app.close();
      if (original === undefined) delete process.env.API_RATE_LIMIT_MAX;
      else process.env.API_RATE_LIMIT_MAX = original;
      if (originalTrusted === undefined) delete process.env.API_RATE_LIMIT_MAX_TRUSTED;
      else process.env.API_RATE_LIMIT_MAX_TRUSTED = originalTrusted;
      if (originalSecret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
      else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = originalSecret;
    }
  });

  test("keeps liveness healthy and recovers readiness without a restart", async () => {
    let databaseReady = false;
    let schemaReady = false;
    const app = createApiApp({
      cors: false,
      readinessChecks: [
        {
          name: "database",
          check: () => {
            if (!databaseReady) throw new Error("postgres://private@database/internal");
          },
        },
        {
          name: "schema",
          check: () => {
            if (!schemaReady) throw new Error("private migration checksum");
          },
        },
        { name: "runtime_modules", check: () => undefined },
      ],
      readinessCacheMs: 0,
    });

    try {
      const live = await app.inject({ method: "GET", url: "/api/health" });
      expect(live.statusCode).toBe(200);

      const unavailable = await app.inject({ method: "GET", url: "/api/ready" });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json() as unknown).toEqual({
        status: "not_ready",
        checks: {
          database: "not_ready",
          schema: "not_ready",
          runtime_modules: "ready",
        },
      });
      expect(unavailable.body).not.toContain("postgres://");

      databaseReady = true;
      const stale = await app.inject({ method: "GET", url: "/api/ready" });
      expect(stale.statusCode).toBe(503);
      expect(stale.json().checks.schema).toBe("not_ready");
      expect(stale.body).not.toContain("checksum");

      schemaReady = true;
      const recovered = await app.inject({ method: "GET", url: "/api/ready" });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().status).toBe("ready");
    } finally {
      await app.close();
    }
  });

  test("includes runtime module checks and fails readiness with their dependencies", async () => {
    let dependencyReady = true;
    const app = createApiApp({
      cors: false,
      modules: {
        loaded: [{
          name: "dependency-module",
          readinessChecks: [
            { name: "zeta_dependency", check: () => undefined },
            {
              name: "external_dependency",
              check: () => {
                if (!dependencyReady) throw new Error("private dependency detail");
              },
            },
          ],
        }],
        failures: [],
      },
      readinessChecks: [],
      readinessCacheMs: 0,
    });

    try {
      const ready = await app.inject({ method: "GET", url: "/api/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json() as unknown).toEqual({
        status: "ready",
        checks: {
          external_dependency: "ready",
          zeta_dependency: "ready",
        },
      });

      dependencyReady = false;
      const unavailable = await app.inject({ method: "GET", url: "/api/ready" });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json() as unknown).toEqual({
        status: "not_ready",
        checks: {
          external_dependency: "not_ready",
          zeta_dependency: "ready",
        },
      });
      expect(unavailable.body).not.toContain("private dependency detail");
    } finally {
      await app.close();
    }
  });

  test("refuses duplicate and core-reserved module readiness names", async () => {
    for (const loaded of [
      [{
        name: "first",
        readinessChecks: [{ name: "shared_dependency", check: () => undefined }],
      }, {
        name: "second",
        readinessChecks: [{ name: "shared_dependency", check: () => undefined }],
      }],
      [{
        name: "reserved",
        readinessChecks: [{ name: "database", check: () => undefined }],
      }],
    ] satisfies RuntimeModule[][]) {
      const app = createApiApp({
        cors: false,
        modules: { loaded, failures: [] },
        readinessChecks: [],
      });
      await expect(app.ready()).rejects.toThrow(/collides with/);
      await app.close().catch(() => undefined);
    }
  });

  test("awaits every module close hook and reports cleanup rejection", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const app = createApiApp({
      cors: false,
      modules: {
        loaded: [{
          name: "first",
          close: async () => void order.push("first"),
        }, {
          name: "rejecting",
          close: async () => {
            order.push("rejecting");
            throw new Error("close failed");
          },
        }, {
          name: "awaited",
          close: () => new Promise<void>((resolve) => {
            order.push("awaited:start");
            release = () => {
              order.push("awaited:end");
              resolve();
            };
          }),
        }],
        failures: [],
      },
      readinessChecks: [],
    });
    await app.ready();

    let settled = false;
    const closing = app.close().finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(order).toEqual(["awaited:start"]);

    release?.();
    await expect(closing).rejects.toThrow(/API resources failed to close/);
    expect(order).toEqual([
      "awaited:start",
      "awaited:end",
      "rejecting",
      "first",
    ]);
  });
});

describe("bounded GraphQL observability", () => {
  test("omits request URLs, addresses, and user agents from real structured logs", async () => {
    const lines: string[] = [];
    const secret = "logger-query-secret-7f3a";
    const userAgent = "private-client-fingerprint-91b2";
    const forwardedAddress = "198.51.100.77";
    const app = createApiApp({
      cors: false,
      readinessChecks: [],
      modules: {
        loaded: [],
        failures: [{
          name: "bounded-test-module",
          specifier: `file:///private/${secret}/module.ts`,
          reason: "module_missing",
          message: `Import failed with token ${secret}`,
        }],
      },
      logStream: { write: (line) => lines.push(line) },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/health?query=${secret}&variables=${secret}`,
        headers: {
          "user-agent": userAgent,
          "x-forwarded-for": forwardedAddress,
        },
      });
      expect(response.statusCode).toBe(200);
      app.log.error({
        err: Object.assign(new Error(secret), { name: userAgent, code: secret }),
      }, "Synthetic logger privacy check.");
    } finally {
      await app.close();
    }
    const output = lines.join("");
    expect(output).toContain("incoming request");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(userAgent);
    expect(output).not.toContain(forwardedAddress);
    expect(output).not.toContain("remoteAddress");
    expect(output).not.toContain('"pid"');
    expect(output).not.toContain('"hostname"');
    expect(output).not.toContain("/api/health?");
    expect(output).toContain('"category":"http.error"');
    expect(output).toContain('"module":"bounded-test-module"');
    expect(output).toContain('"reason":"module_missing"');
    expect(output).toContain("A runtime module was not loaded.");
  });

  test("exports low-cardinality metrics and reports unexpected errors without request data", async () => {
    const registry = new Registry();
    const reports: SanitizedErrorReport[] = [];
    const secret = "tenant-person-secret-7f3a";
    const originalContextSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
    const contextSecret = "bounded-metrics-context-secret";
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = contextSecret;
    const app = createApiApp({
      cors: false,
      metricsRegistry: registry,
      modules: { loaded: [syntheticModule], failures: [] },
      reportUnexpectedError: (report) => reports.push(report),
      readinessChecks: [],
    });

    try {
      const successful = await app.inject({
        method: "POST",
        url: "/api/graphql",
        headers: { "content-type": "application/json" },
        payload: { query: "query HealthProbe { health { status } }" },
      });
      expect(successful.json().data.health.status).toBe("ok");

      const expected = await app.inject({
        method: "POST",
        url: "/api/graphql",
        headers: { "content-type": "application/json" },
        payload: { query: "query ActiveTenantShell { currentTenant { id } }" },
      });
      expect(expected.json().errors[0].extensions.code).toBe("UNAUTHENTICATED");

      const validation = await app.inject({
        method: "POST",
        url: "/api/graphql",
        headers: { "content-type": "application/json" },
        payload: { query: "query HealthProbe { fieldThatDoesNotExist }" },
      });
      expect(validation.json().errors[0].extensions.code).toBe("GRAPHQL_VALIDATION_FAILED");

      const unexpected = await app.inject({
        method: "POST",
        url: "/api/graphql",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
          cookie: `session=${secret}`,
        },
        payload: {
          query: "query UnlistedPrivateOperation($secret: String!) { syntheticUnexpected(secret: $secret) }",
          variables: { secret },
        },
      });
      expect(unexpected.json().errors[0].message).toBe("Unexpected error.");
      expect(unexpected.body).not.toContain(secret);
      expect(reports).toEqual([
        { category: "graphql.unexpected", errorType: "Error" },
      ]);

      const metrics = (await app.inject({
        method: "GET", url: "/api/metrics", headers: signedMetricsHeaders(contextSecret),
      })).body;
      expect(metrics).toContain("openshapeforge_graphql_operations_total");
      expect(metrics).toContain('operation_name="HealthProbe"');
      expect(metrics).toContain('status_code="200"');
      expect(metrics).toContain('operation_name="Other"');
      expect(metrics).toContain('classification="expected"');
      expect(metrics).toContain('classification="unexpected"');
      expect(metrics).not.toContain(secret);
      expect(metrics).not.toContain("UnlistedPrivateOperation");
      expect(metrics).not.toContain("authorization");
      expect(metrics).not.toContain("cookie");
    } finally {
      await app.close();
      if (originalContextSecret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
      else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = originalContextSecret;
    }
  });
});
