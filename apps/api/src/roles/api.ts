// SPDX-License-Identifier: BUSL-1.1
/**
 * API role: fastify server hosting the GraphQL endpoint at /api/graphql.
 *
 * Trimmed from the full apps/api service — the metrics route, erp document
 * routes, messaging/whatsapp webhooks, workflow node bridges, realtime dirty
 * worker, and entity-event fanout wiring are intentionally absent.
 */
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { readApiLimits } from "../config/limits.js";
import { assertProductionEnv } from "../config/production-guard.js";
import { createDatabaseRuntime, type DatabaseRuntime, type OpenShapeForgeDatabase } from "../db/connection.js";
import {
  checkGeneratedSchemaDrift,
  type GeneratedSchemaDriftResult,
} from "../db/schema-drift.js";
import { createGraphqlYoga } from "../graphql/yoga.js";
import { headersFromFastify } from "../http/headers.js";
import { registerGeneratedRestRoutes } from "../rest/generated-rest-routes.js";

/** Startup drift check must not delay readiness meaningfully. */
const DRIFT_CHECK_TIMEOUT_MS = 5000;

/**
 * Liveness/readiness endpoints are exempt from rate limiting: kubelet probes hit
 * them on a fixed schedule and must never be throttled, and they perform no
 * database or resolver work, so exempting them opens no amplification path.
 */
const RATE_LIMIT_EXEMPT_PATHS = new Set([
  "/api/health",
  "/api/ready",
  "/api/graphql/health",
]);

function isRateLimitExempt(url: string): boolean {
  const queryStart = url.indexOf("?");
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return RATE_LIMIT_EXEMPT_PATHS.has(path);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function driftBanner(drift: GeneratedSchemaDriftResult): string {
  return [
    "============================================================================",
    `GENERATED SCHEMA DRIFT DETECTED (status: ${drift.status})`,
    drift.status === "unmigrated"
      ? "The database has no applied generated-schema migration record (fresh DB?)."
      : "The database's generated schema is BEHIND the manifest bundled in this build.",
    `  recorded checksum: ${drift.recordedChecksum ?? "<none>"}`,
    `  bundled checksum:  ${drift.bundledChecksum}`,
    "Run `bun run db:migrate` to bring the database up to date.",
    "============================================================================",
  ].join("\n");
}

/**
 * Compare the connected database's applied generated-schema checksum with the
 * bundled manifest. In production a drifted (or unverifiable) schema is fatal;
 * in development it logs loudly but never blocks startup.
 */
async function enforceGeneratedSchemaFreshness(
  log: FastifyBaseLogger,
  db: OpenShapeForgeDatabase,
): Promise<void> {
  const production = process.env.NODE_ENV === "production";

  let drift: GeneratedSchemaDriftResult;
  try {
    drift = await withTimeout(
      checkGeneratedSchemaDrift(db),
      DRIFT_CHECK_TIMEOUT_MS,
      "generated schema drift check",
    );
  } catch (error) {
    if (production) {
      throw new Error(
        "Unable to verify generated schema freshness at startup; refusing to serve.",
        { cause: error },
      );
    }
    log.error(
      { err: error },
      "Generated schema drift check failed at startup (database unreachable?); continuing without verification.",
    );
    return;
  }

  if (drift.status === "ok") {
    log.debug(
      { checksum: drift.bundledChecksum },
      "Generated schema drift check: database matches the bundled manifest.",
    );
    return;
  }

  if (production) {
    throw new Error(driftBanner(drift));
  }
  log.warn(driftBanner(drift));
}

function bodyFromFastify(method: string, body: unknown): BodyInit | undefined {
  if (method === "GET" || method === "HEAD" || body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    const copy = new Uint8Array(body);
    return new Blob([copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)]);
  }
  return JSON.stringify(body);
}

export function createApiApp(
  options: {
    databaseUrl?: string;
  } = {},
) {
  const limits = readApiLimits();

  // Default level stays "info"; LOG_LEVEL=debug surfaces the drift "ok" line.
  // trustProxy lets Fastify derive the real client IP from X-Forwarded-For (the
  // rate-limit key) behind the ingress; requestTimeout bounds the whole request
  // so a slow/hung request cannot pin a worker (issue #130).
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: limits.trustProxy,
    requestTimeout: limits.requestTimeoutMs,
  });

  // Request-rate boundary, before GraphQL/REST execution. Keyed on the client IP
  // (default keyGenerator + trustProxy). In-memory store => enforced per API
  // instance; see apps/api/src/config/limits.ts. Health probes are exempt.
  void app.register(rateLimit, {
    max: limits.rateLimitMax,
    timeWindow: limits.rateLimitWindowMs,
    allowList: (request) => isRateLimitExempt(request.url),
    // 429 with Retry-After (added by the plugin); body carries no limiter internals.
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Rate limit exceeded. Please retry later.",
    }),
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  let databaseRuntime: DatabaseRuntime | undefined;

  if (options.databaseUrl) {
    databaseRuntime = createDatabaseRuntime({
      databaseUrl: options.databaseUrl,
    });

    app.addHook("onClose", async () => {
      await databaseRuntime?.close();
    });

    const runtime = databaseRuntime;
    app.addHook("onReady", async () => {
      await enforceGeneratedSchemaFreshness(app.log, runtime.db);
    });
  } else {
    app.log.warn("DATABASE_URL is not set; GraphQL runs without a database.");
  }

  const yoga = createGraphqlYoga(
    databaseRuntime ? { db: databaseRuntime.db } : {},
  );
  const dbOptions = databaseRuntime ? { db: databaseRuntime.db } : {};

  // Register the routes inside a child plugin so they load AFTER the rate-limit
  // plugin above. @fastify/rate-limit attaches its per-route guard through an
  // onRoute hook that only sees routes registered once it has loaded; routes
  // added directly on `app` (which happens synchronously, before the deferred
  // plugin loads) would silently escape the limiter.
  void app.register(async (routes) => {
    routes.get("/api/health", async () => ({
      status: "ok",
      role: "api",
    }));

    routes.get("/api/ready", async () => ({
      status: "ready",
      role: "api",
    }));

    routes.get("/api/graphql/health", async () => ({
      status: "ok",
      role: "api",
    }));

    routes.route({
      url: "/api/graphql",
      method: ["GET", "POST", "OPTIONS"],
      handler: async (request, reply) => {
        const origin = `${request.protocol}://${request.headers.host ?? "localhost"}`;
        const response = await yoga.fetch(
          new URL(request.url, origin),
          {
            method: request.method,
            headers: headersFromFastify(request.headers),
            body: bodyFromFastify(request.method, request.body),
          },
          {
            fastifyRequest: request,
            fastifyReply: reply,
          },
        );

        return reply.send(response);
      },
    });

    registerGeneratedRestRoutes(routes, dbOptions);
  });

  return app;
}

export async function startApiRole() {
  // Fail closed BEFORE serving: in production, refuse to start with an unsafe
  // auth configuration (unpinned bearer audience, default/absent context
  // secret, or no complete auth method). No-op in dev/test.
  assertProductionEnv();

  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "0.0.0.0";
  const app = createApiApp(
    process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {},
  );

  await app.listen({ port, host });
}
