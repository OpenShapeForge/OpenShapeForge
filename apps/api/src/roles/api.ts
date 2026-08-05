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
import { registerConnectorRestRoutes } from "../connectors/rest-routes.js";
import { registerConnectorOAuthRoutes } from "../connectors/oauth-routes.js";
import { readConnectorRuntimeConfig } from "../connectors/runtime-config.js";
import { registerControlRestRoutes } from "../control/rest-routes.js";
import { registerGeneratedMcpServer } from "../mcp/generated-mcp-server.js";
import { initRuntimeModules, loadRuntimeModules, type ModuleRegistry } from "../modules/registry.js";
import {
  classifyRequest,
  createRateLimitMetrics,
  createRedisRateLimitStore,
  type RateLimitMetrics,
} from "./rate-limit.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Limiter decision counters, per tier. Read by tests and diagnostics. */
    rateLimitMetrics: RateLimitMetrics;
  }
}

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
    /**
     * Runtime modules resolved by the caller. Kept a parameter rather than
     * loaded here because resolution is async and this factory is sync — and
     * tests that only need the core surface should not have to resolve
     * anything. `startApiRole` does the loading for the real process.
     */
    modules?: ModuleRegistry;
  } = {},
) {
  const modules: ModuleRegistry = options.modules ?? { loaded: [], failures: [] };
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

  // Request-rate boundary, before GraphQL/REST execution — that ordering is
  // what protects the authentication path itself, so the tier is decided from
  // what a request can prove locally (see classifyRequest). Health probes are
  // exempt.
  const rateLimitMetrics = createRateLimitMetrics();
  const contextSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET?.trim() || undefined;
  const sharedStore = limits.rateLimitRedisUrl
    ? createRedisRateLimitStore(limits.rateLimitRedisUrl, rateLimitMetrics, (error) =>
        app.log.error({ err: error }, "Rate-limit store unavailable; request not counted."),
      )
    : undefined;

  if (sharedStore) {
    app.addHook("onClose", async () => {
      await sharedStore.close();
    });
    app.log.info("Rate limiting uses a shared store: one budget across all replicas.");
  } else {
    app.log.warn(
      "Rate limiting uses an in-memory store: the budget is enforced PER INSTANCE. " +
        "Set API_RATE_LIMIT_REDIS_URL for an exact cross-replica limit.",
    );
  }

  void app.register(rateLimit, {
    // Per-request budget, so a trusted service-to-service caller does not
    // compete with anonymous traffic for one allowance.
    max: (request) => limits.rateLimitTiers[classifyRequest(request, contextSecret).tier],
    keyGenerator: (request) => classifyRequest(request, contextSecret).key,
    timeWindow: limits.rateLimitWindowMs,
    allowList: (request) => isRateLimitExempt(request.url),
    ...(sharedStore ? { store: sharedStore.Store as never } : {}),
    // A store outage must not become an API outage: the request proceeds
    // uncounted, and createRedisRateLimitStore records it in storeErrors.
    skipOnError: true,
    onExceeding: (request) => {
      rateLimitMetrics.allowed[classifyRequest(request, contextSecret).tier] += 1;
    },
    onExceeded: (request) => {
      rateLimitMetrics.throttled[classifyRequest(request, contextSecret).tier] += 1;
    },
    // 429 with Retry-After (added by the plugin); body carries no limiter internals.
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Rate limit exceeded. Please retry later.",
    }),
  });

  app.decorate("rateLimitMetrics", rateLimitMetrics);

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

  const dbOptions = databaseRuntime ? { db: databaseRuntime.db } : {};

  // Modules are initialised, and the schema built from the survivors, inside
  // the async registration below rather than here: `init` needs the database
  // this function has only just created, and a module that fails to initialise
  // must not contribute a surface. `createApiApp` stays synchronous because its
  // callers — tests included — should not have to await a server they are only
  // constructing.
  let ready: { yoga: ReturnType<typeof createGraphqlYoga> } | null = null;

  // Register the routes inside a child plugin so they load AFTER the rate-limit
  // plugin above. @fastify/rate-limit attaches its per-route guard through an
  // onRoute hook that only sees routes registered once it has loaded; routes
  // added directly on `app` (which happens synchronously, before the deferred
  // plugin loads) would silently escape the limiter.
  void app.register(async (routes) => {
    const initialised = await initRuntimeModules(modules, dbOptions);
    ready = { yoga: createGraphqlYoga({ ...dbOptions, modules: initialised.loaded }) };

    // A module that failed to load or initialise contributes nothing, and its
    // absence is otherwise invisible until a query 404s. Say so once, here.
    for (const failure of initialised.failures) {
      routes.log.error(
        { module: failure.name, specifier: failure.specifier, reason: failure.reason },
        `Runtime module "${failure.name}" was not loaded: ${failure.message}`,
      );
    }

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
        // `ready` is assigned at the top of this same registration, before any
        // route can be reached; the check is a type guard, not a race.
        if (!ready) throw new Error("GraphQL was not initialised before serving.");
        const response = await ready.yoga.fetch(
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
    registerConnectorRestRoutes(routes, {
      ...dbOptions,
      config: readConnectorRuntimeConfig(),
    });
    // Inside the same child plugin, so the callback an unauthenticated stranger
    // can reach sits behind the rate limiter like everything else.
    registerConnectorOAuthRoutes(routes, {
      ...dbOptions,
      config: readConnectorRuntimeConfig(),
      publicOrigin: process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN,
      appOrigin: process.env.OPENSHAPEFORGE_APP_ORIGIN,
    });
    registerGeneratedMcpServer(routes, dbOptions);
    // The tenant control plane, on its own mount and its own realm. Registered
    // unconditionally so an unconfigured deployment answers 503 naming what is
    // missing rather than 404, which reads like a version mismatch.
    registerControlRestRoutes(routes, dbOptions);

    for (const module of initialised.loaded) {
      module.restRoutes?.(routes, dbOptions);
    }
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
  const app = createApiApp({
    ...(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {}),
    modules: await loadRuntimeModules(),
  });

  await app.listen({ port, host });
}
