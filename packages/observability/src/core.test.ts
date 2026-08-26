// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { Registry } from "prom-client";
import { runReadinessChecks, publicReadinessBody } from "./readiness.js";
import { sanitizeError } from "./redaction.js";
import { getProcessPrometheusRegistry } from "./registry.js";
import {
  createYogaCorsConfiguration,
  createYogaMetricsPlugin,
  validateCorsPolicy,
} from "./yoga.js";

describe("observability core", () => {
  test("resolves one registry per process", () => {
    expect(getProcessPrometheusRegistry()).toBe(getProcessPrometheusRegistry());
  });

  test("registers the Yoga metric collectors once per registry", () => {
    const registry = new Registry();
    const options = {
      registry,
      metricPrefix: "test_host",
      allowedOperationNames: new Set(["HealthProbe"]),
    };
    expect(createYogaMetricsPlugin(options)).toBe(createYogaMetricsPlugin(options));
    expect(() => createYogaMetricsPlugin({
      ...options,
      metricPrefix: "other_host",
    })).toThrow(/different Yoga metric policy/);
  });

  test("redacts message, stack, cause, and unsafe codes", () => {
    const error = Object.assign(new Error("token=private"), {
      code: "private-user@example.test",
      cause: new Error("database internals"),
    });
    const report = sanitizeError(error, "graphql.unexpected");
    expect(report).toEqual({
      category: "graphql.unexpected",
      errorType: "Error",
    });
    expect(JSON.stringify(report)).not.toMatch(/private|database|token|stack|cause/i);
  });

  test("runs every readiness check and exposes only status", async () => {
    const result = await runReadinessChecks([
      { name: "database", check: () => undefined },
      { name: "schema", check: () => { throw new Error("secret host"); } },
    ]);
    expect(result.ready).toBe(false);
    expect(publicReadinessBody(result)).toEqual({
      status: "not_ready",
      checks: { database: "ready", schema: "not_ready" },
    });
    expect(JSON.stringify(publicReadinessBody(result))).not.toContain("secret host");
  });
});

describe("Yoga CORS policy", () => {
  test("accepts explicit disablement and exact allowlists", () => {
    expect(validateCorsPolicy(false)).toBe(false);
    expect(validateCorsPolicy({
      origin: ["https://app.example.test"],
      credentials: true,
    })).toMatchObject({
      origin: ["https://app.example.test"],
      credentials: true,
      allowedHeaders: ["content-type", "authorization"],
    });
  });

  test("rejects wildcard, null, lookalike syntax, paths, and duplicates", () => {
    for (const origin of ["*", "null", "*.example.test", "https://app.example.test/path"]) {
      expect(() => validateCorsPolicy({ origin })).toThrow(/exact HTTP/);
    }
    expect(() => validateCorsPolicy({
      origin: ["https://app.example.test", "https://app.example.test"],
    })).toThrow(/duplicates/);
  });

  test("validates every result from a dynamic host policy", async () => {
    const cors = createYogaCorsConfiguration((request) => ({
      origin: request.headers.get("origin") === "https://app.example.test"
        ? "https://app.example.test"
        : "*",
    }));
    expect(typeof cors).toBe("function");
    await expect((cors as (request: Request) => Promise<unknown>)(
      new Request("https://api.example.test", { headers: { origin: "https://evil.test" } }),
    )).rejects.toThrow(/exact HTTP/);
  });
});
