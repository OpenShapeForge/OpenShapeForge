// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { Registry, type SanitizedErrorReport } from "@openshapeforge/observability";
import type { RuntimeModule } from "../../modules/contract.js";
import { createApiApp } from "../../roles/api.js";

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
});

describe("bounded GraphQL observability", () => {
  test("exports low-cardinality metrics and reports unexpected errors without request data", async () => {
    const registry = new Registry();
    const reports: SanitizedErrorReport[] = [];
    const secret = "tenant-person-secret-7f3a";
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

      const metrics = (await app.inject({ method: "GET", url: "/api/metrics" })).body;
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
    }
  });
});
