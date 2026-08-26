// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Registry } from "prom-client";
import Fastify from "fastify";
import { registerOperationalRoutes } from "./fastify.js";
import { runReadinessChecks, publicReadinessBody } from "./readiness.js";
import { sanitizeError } from "./redaction.js";
import { getProcessPrometheusRegistry } from "./registry.js";
import {
  applyBoundedHttpSpanAttributes,
  bootstrapOpenTelemetry,
  shutdownOpenTelemetry,
} from "./otel.js";
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

  test("keeps registry and Yoga collectors idempotent across module reloads", async () => {
    const registryModules = await Promise.all([
      import(new URL("./registry.ts?reload=one", import.meta.url).href),
      import(new URL("./registry.ts?reload=two", import.meta.url).href),
    ]);
    expect(registryModules[0].getProcessPrometheusRegistry())
      .toBe(registryModules[1].getProcessPrometheusRegistry());

    const yogaModules = await Promise.all([
      import(new URL("./yoga.ts?reload=one", import.meta.url).href),
      import(new URL("./yoga.ts?reload=two", import.meta.url).href),
    ]);
    const registry = new Registry();
    const options = {
      registry,
      metricPrefix: "reload_host",
      allowedOperationNames: new Set(["HealthProbe"]),
    };
    expect(yogaModules[0].createYogaMetricsPlugin(options))
      .toBe(yogaModules[1].createYogaMetricsPlugin(options));
  });

  test("exports bounded HTTP span attributes without query or OAuth values", () => {
    const attributes = new Map<string, unknown>();
    const span = {
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
        return this;
      },
    };
    const secret = "private-oauth-code-7f3a";
    applyBoundedHttpSpanAttributes(span, {
      url: `/api/graphql?query=PrivateDocument&variables=${secret}&code=${secret}`,
    } as never);
    expect(Object.fromEntries(attributes)).toMatchObject({
      "http.target": "[REDACTED]",
      "http.url": "[REDACTED]",
      "url.full": "[REDACTED]",
      "url.path": "[REDACTED]",
      "url.query": "[REDACTED]",
      "user_agent.original": "[REDACTED]",
      "client.address": "[REDACTED]",
      "network.peer.address": "[REDACTED]",
      "network.peer.port": 0,
    });
    expect(JSON.stringify(Object.fromEntries(attributes))).not.toContain(secret);
  });

  test("redacts identifiers from a live instrumented HTTP request", async () => {
    const secret = "span-secret-user-agent-7f3a";
    const script = `
      const collected = [];
      const exporter = {
        export(spans, done) {
          collected.push(...spans.map((span) => ({
            attributes: span.attributes,
            resource: span.resource.attributes,
          })));
          done({ code: 0 });
        },
        shutdown() { return Promise.resolve(); },
      };
      const otel = await import("./src/otel.ts");
      otel.bootstrapOpenTelemetry({ serviceName: "export-test", traceExporter: exporter });
      const Fastify = (await import("fastify")).default;
      const app = Fastify({ logger: false });
      app.get("/health", async () => ({ status: "ok" }));
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener address.");
      const { request } = await import("node:http");
      await new Promise((resolve, reject) => {
        const outgoing = request({
          host: "127.0.0.1",
          port: address.port,
          path: "/health?code=${secret}",
          method: "gEt",
          headers: {
            host: "tenant-${secret}.example.test:54321",
            "user-agent": "${secret}",
            "x-forwarded-for": "198.51.100.77",
          },
        }, (response) => {
          response.resume();
          response.on("end", resolve);
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
      await app.close();
      await otel.shutdownOpenTelemetry();
      process.stdout.write(JSON.stringify(collected));
    `;
    const process = Bun.spawn(["bun", "--eval", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const exported = JSON.parse(stdout) as {
      attributes: Record<string, unknown>;
      resource: Record<string, unknown>;
    }[];
    expect(exported.length).toBeGreaterThan(0);
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain("198.51.100.77");
    expect(stdout).not.toContain("tenant-");
    for (const { attributes, resource } of exported) {
      expect(attributes["user_agent.original"]).toBe("[REDACTED]");
      expect(attributes["client.address"]).toBe("[REDACTED]");
      expect(attributes["network.peer.address"]).toBe("[REDACTED]");
      expect(attributes["server.address"]).toBe("[REDACTED]");
      expect(attributes["server.port"]).toBe(0);
      expect(attributes["http.request.method_original"]).toBe("[REDACTED]");
      expect(resource["service.name"]).toBe("export-test");
      for (const forbidden of [
        "host.name",
        "host.id",
        "process.owner",
        "process.executable.path",
        "process.command_args",
      ]) {
        expect(resource[forbidden]).toBeUndefined();
      }
    }
  }, 15_000);

  test("keeps the OTel lifecycle process-global across module reloads", async () => {
    const first = bootstrapOpenTelemetry({
      serviceName: "observability-test",
      tracesEndpoint: "http://127.0.0.1:4318/v1/traces",
    });
    const reloaded = await import(new URL("./otel.ts?reload=lifecycle", import.meta.url).href);
    expect(reloaded.bootstrapOpenTelemetry({
      serviceName: "ignored-after-first-start",
      tracesEndpoint: "http://127.0.0.1:4318/v1/traces",
    })).toBe(first);
    await shutdownOpenTelemetry();
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

  test("maps attacker-controlled error names and plausible codes to fixed values", () => {
    const error = Object.assign(new Error("private"), {
      name: "AliceSmith",
      code: "SECRET123",
    });
    expect(sanitizeError(error, "graphql.unexpected")).toEqual({
      category: "graphql.unexpected",
      errorType: "Error",
    });
    expect(sanitizeError(Object.assign(new TypeError(), { code: "ETIMEDOUT" }), "network"))
      .toEqual({ category: "network", errorType: "TypeError", errorCode: "ETIMEDOUT" });
    const hostCodes = new Set(["VERSIONED_LEDGER_AHEAD"]);
    expect(sanitizeError(
      Object.assign(new Error("private migration details"), { code: "VERSIONED_LEDGER_AHEAD" }),
      "readiness.schema",
      hostCodes,
    )).toEqual({
      category: "readiness.schema",
      errorType: "Error",
      errorCode: "VERSIONED_LEDGER_AHEAD",
    });
    expect(sanitizeError(
      Object.assign(new Error("private"), { code: "ATTACKER_CONTROLLED" }),
      "readiness.schema",
      hostCodes,
    ).errorCode).toBeUndefined();
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

  test("coalesces concurrent readiness probes and caches the result briefly", async () => {
    const app = Fastify({ logger: false });
    let runs = 0;
    registerOperationalRoutes(app, {
      registry: new Registry(),
      readinessCacheMs: 1_000,
      readinessChecks: [{
        name: "database",
        check: async () => {
          runs += 1;
          await Promise.resolve();
        },
      }],
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => app.inject({ method: "GET", url: "/api/ready" })),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(runs).toBe(1);
      expect((await app.inject({ method: "GET", url: "/api/ready" })).statusCode).toBe(200);
      expect(runs).toBe(1);
    } finally {
      await app.close();
    }
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
