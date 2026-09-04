// SPDX-License-Identifier: BUSL-1.1
/**
 * API role: fastify server hosting the GraphQL endpoint at /api/graphql.
 *
 * Trimmed from the full apps/api service — the metrics route, erp document
 * routes, messaging/whatsapp webhooks, workflow node bridges, realtime dirty
 * worker, and entity-event fanout wiring are intentionally absent.
 */
import rateLimit from "@fastify/rate-limit";
import {
  registerOperationalRoutes,
  type OperationalRoutesOptions,
} from "@openshapeforge/observability/fastify";
import {
  sanitizeError,
  type ReadinessCheck,
  type Registry,
  type SanitizedErrorReport,
} from "@openshapeforge/observability";
import type { GraphqlCorsPolicy } from "@openshapeforge/observability/yoga";
import Fastify from "fastify";
import { readApiLimits } from "../config/limits.js";
import { readGraphqlCorsPolicy } from "../config/graphql-cors.js";
import { assertProductionEnv } from "../config/production-guard.js";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../db/connection.js";
import {
  createGraphqlYoga,
  type PersistedOperationManifest,
} from "../graphql/yoga.js";
import { headersFromFastify } from "../http/headers.js";
import { registerGeneratedRestRoutes } from "../rest/generated-rest-routes.js";
import { registerConnectorRestRoutes } from "../connectors/rest-routes.js";
import { registerConnectorOAuthRoutes } from "../connectors/oauth-routes.js";
import { readConnectorRuntimeConfig } from "../connectors/runtime-config.js";
import { registerControlRestRoutes } from "../control/rest-routes.js";
import { registerDocumentRestRoutes } from "../documents/rest-routes.js";
import { registerGeneratedMcpServer } from "../mcp/generated-mcp-server.js";
import {
  registerAuthorizationServerMetadataAliases,
  registerProtectedResourceMetadata,
} from "../mcp/protected-resource-metadata.js";
import { registerApiKeyRestRoutes } from "../auth/api-key/rest-routes.js";
import { readApiKeyProvisioningConfig } from "../auth/api-key/runtime-config.js";
import { resolveSessionContext } from "../auth/identity.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  assertSingleModuleEgressOwner,
  closeRuntimeModules,
  initRuntimeModules,
  loadRuntimeModules,
  type ModuleRegistry,
} from "../modules/registry.js";
import { ModulePlatformRuntime } from "../modules/platform.js";
import {
  classifyRequest,
  createRateLimitMetrics,
  createRedisRateLimitStore,
  type RateLimitMetrics,
} from "./rate-limit.js";
import {
  API_READINESS_ERROR_CODES,
  createApiReadinessChecks,
  enforceGeneratedSchemaFreshness,
} from "./api-readiness.js";
import {
  bindOperationHandlers,
  listOperationContracts,
  registerOperationRestRoutes,
  type OperationContract,
} from "../operations/runtime.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Limiter decision counters, per tier. Read by tests and diagnostics. */
    rateLimitMetrics: RateLimitMetrics;
  }
}

/**
 * Health and readiness probes must never be throttled: Kubernetes treats any
 * non-2xx readiness response as a failed pod. Metrics stays rate limited and
 * additionally requires a signed internal context below.
 */
const RATE_LIMIT_EXEMPT_PATHS = new Set([
  "/api/health",
  "/api/ready",
]);

function isRateLimitExempt(url: string): boolean {
  const queryStart = url.indexOf("?");
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return RATE_LIMIT_EXEMPT_PATHS.has(path);
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
    return new Blob([
      copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
    ]);
  }
  return JSON.stringify(body);
}

export function createApiApp(options: {
  cors: GraphqlCorsPolicy;
  databaseUrl?: string;
  /**
   * Runtime modules resolved by the caller. Kept a parameter rather than
   * loaded here because resolution is async and this factory is sync — and
   * tests that only need the core surface should not have to resolve
   * anything. `startApiRole` does the loading for the real process.
   */
  modules?: ModuleRegistry;
  metricsRegistry?: Registry;
  reportUnexpectedError?: (report: SanitizedErrorReport) => void;
  /** Controlled host override used to prove rolling manifest compatibility. */
  persistedOperations?: PersistedOperationManifest;
  /** Focused route tests may replace external dependencies with controlled checks. */
  readinessChecks?: readonly ReadinessCheck[];
  /** Override only for controlled tests that need immediate readiness transitions. */
  readinessCacheMs?: number;
  /** Capture the real structured logger in focused privacy regressions. */
  logStream?: { write(message: string): void };
  /** Controlled operation catalog override for startup invariant tests. */
  operationContracts?: readonly OperationContract[];
}) {
  if (process.env.OPENSHAPEFORGE_ROUTE_ALIASES !== undefined) {
    throw new Error(
      "OPENSHAPEFORGE_ROUTE_ALIASES is no longer supported. Use the canonical " +
        "/api/health, /api/ready, /api/metrics, and compiled API routes directly.",
    );
  }
  const modules: ModuleRegistry = options.modules ?? {
    loaded: [],
    failures: [],
  };
  const operationContracts = options.operationContracts ?? listOperationContracts();
  const limits = readApiLimits();

  // Default level stays "info"; LOG_LEVEL=debug surfaces the drift "ok" line.
  // trustProxy lets Fastify derive the real client IP from X-Forwarded-For (the
  // rate-limit key) behind the ingress; requestTimeout bounds the whole request
  // so a slow/hung request cannot pin a worker (issue #130).
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Pino's defaults include pid and hostname; both are unnecessary and a
      // developer hostname may itself contain a person's name.
      base: { service: "openshapeforge-api" },
      // URLs can contain GraphQL documents, OAuth codes, or entity IDs, while
      // addresses and user agents are unnecessary high-cardinality identifiers.
      serializers: {
        req: (request) => ({ method: request.method }),
        res: (reply) => ({ statusCode: reply.statusCode }),
        err: (error) => ({
          ...sanitizeError(error, "http.error"),
          type: "Error",
          message: "Redacted error.",
          stack: "",
        }),
      },
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    trustProxy: limits.trustProxy,
    requestTimeout: limits.requestTimeoutMs,
    // Browser handoff tokens (`/api/entity-configuration/<token>`,
    // mcp/handoff-store.ts) are `<tenant>.<handoff>.<secret>` — 117
    // characters — and the router's default of 100 answered them with 414
    // before the route ever ran (found live). Generous but bounded.
    maxParamLength: 512,
  });

  // Request-rate boundary, before GraphQL/REST execution — that ordering is
  // what protects the authentication path itself, so the tier is decided from
  // what a request can prove locally (see classifyRequest). Health probes are
  // exempt.
  const rateLimitMetrics = createRateLimitMetrics();
  const contextSecret =
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET?.trim() || undefined;
  const sharedStore = limits.rateLimitRedisUrl
    ? createRedisRateLimitStore(
        limits.rateLimitRedisUrl,
        rateLimitMetrics,
        (error) =>
          app.log.error(
            { err: error },
            "Rate-limit store unavailable; request not counted.",
          ),
      )
    : undefined;

  if (sharedStore) {
    app.log.info(
      "Rate limiting uses a shared store: one budget across all replicas.",
    );
  } else {
    app.log.warn(
      "Rate limiting uses an in-memory store: the budget is enforced PER INSTANCE. " +
        "Set API_RATE_LIMIT_REDIS_URL for an exact cross-replica limit.",
    );
  }

  void app.register(rateLimit, {
    // Per-request budget, so a trusted service-to-service caller does not
    // compete with anonymous traffic for one allowance.
    max: (request) =>
      limits.rateLimitTiers[classifyRequest(request, contextSecret).tier],
    keyGenerator: (request) => classifyRequest(request, contextSecret).key,
    timeWindow: limits.rateLimitWindowMs,
    allowList: (request) => isRateLimitExempt(request.url),
    ...(sharedStore ? { store: sharedStore.Store as never } : {}),
    // A store outage must not become an API outage: the request proceeds
    // uncounted, and createRedisRateLimitStore records it in storeErrors.
    skipOnError: true,
    onExceeding: (request) => {
      rateLimitMetrics.allowed[classifyRequest(request, contextSecret).tier] +=
        1;
    },
    onExceeded: (request) => {
      rateLimitMetrics.throttled[
        classifyRequest(request, contextSecret).tier
      ] += 1;
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
  let initialisedModules: ModuleRegistry["loaded"] = [];
  const databaseToClose = databaseRuntime;

  app.addHook("onClose", async () => {
    const failures: unknown[] = [];
    for (const close of [
      () => closeRuntimeModules(initialisedModules),
      ...(sharedStore ? [() => sharedStore.close()] : []),
      ...(databaseToClose ? [() => databaseToClose.close()] : []),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more API resources failed to close.");
    }
  });

  // Register the routes inside a child plugin so they load AFTER the rate-limit
  // plugin above. @fastify/rate-limit attaches its per-route guard through an
  // onRoute hook that only sees routes registered once it has loaded; routes
  // added directly on `app` (which happens synchronously, before the deferred
  // plugin loads) would silently escape the limiter.
  void app.register(async (routes) => {
    const modulePlatform = databaseRuntime
      ? new ModulePlatformRuntime(databaseRuntime.db)
      : undefined;
    const moduleContext = {
      ...dbOptions,
      ...(modulePlatform ? { platform: modulePlatform.services } : {}),
    };
    const initialised = await initRuntimeModules(modules, moduleContext);
    initialisedModules = initialised.loaded;
    const egressOwner = assertSingleModuleEgressOwner(initialised.loaded);
    const operationPlugins = new Set(operationContracts.map((operation) => operation.plugin));
    const operationModulesConfigured = modules.loaded.some((module) => operationPlugins.has(module.name)) ||
      modules.failures.some((failure) => operationPlugins.has(failure.name));
    // Ordinary runtime modules remain fail-soft. A canonical operation is a
    // stronger promise: every generated transport points at its handler, so a
    // load/init failure must stop boot instead of silently deleting the API.
    if (operationModulesConfigured) bindOperationHandlers(initialised.loaded, operationContracts);
    ready = {
      yoga: createGraphqlYoga({
        ...dbOptions,
        cors: options.cors,
        modules: initialised.loaded,
        moduleContext,
        ...(options.persistedOperations
          ? { persistedOperations: options.persistedOperations }
          : {}),
        ...(options.metricsRegistry
          ? { metricsRegistry: options.metricsRegistry }
          : {}),
        reportUnexpectedError:
          options.reportUnexpectedError ??
          ((report) =>
            routes.log.error(report, "Unexpected GraphQL execution error.")),
      }),
    };

    // A module that failed to load or initialise contributes nothing, and its
    // absence is otherwise invisible until a query 404s. Say so once, here.
    for (const failure of initialised.failures) {
      routes.log.error(
        { module: failure.name, reason: failure.reason },
        "A runtime module was not loaded.",
      );
    }

    routes.get("/api/health", async () => ({
      status: "ok",
      role: "api",
    }));

    const readinessChecks = createApiReadinessChecks(
      databaseRuntime,
      initialised,
      options.readinessChecks,
    );
    registerOperationalRoutes(routes, {
      readinessChecks,
      allowedReadinessErrorCodes: API_READINESS_ERROR_CODES,
      authorizeMetrics: (request) =>
        classifyRequest(request, contextSecret).tier === "trusted",
      ...(options.metricsRegistry ? { registry: options.metricsRegistry } : {}),
      ...(options.readinessCacheMs !== undefined
        ? { readinessCacheMs: options.readinessCacheMs }
        : {}),
    } satisfies OperationalRoutesOptions);

    for (const url of ["/api/graphql", "/api/graphql/persisted"])
      routes.route({
        url,
        method: ["GET", "POST", "OPTIONS"],
        handler: async (request, reply) => {
          const origin = `${request.protocol}://${request.headers.host ?? "localhost"}`;
          // `ready` is assigned at the top of this same registration, before any
          // route can be reached; the check is a type guard, not a race.
          if (!ready)
            throw new Error("GraphQL was not initialised before serving.");
          const yogaUrl = new URL(request.url, origin);
          const requestHeaders = headersFromFastify(request.headers);
          // These markers are host-owned. Never let a caller self-select a less
          // restrictive execution profile by sending the internal header.
          requestHeaders.delete("x-openshapeforge-persisted-profile");
          requestHeaders.delete("x-openshapeforge-arbitrary-profile");
          let verifiedSession: TrustedSessionContext | undefined;
          if (url.endsWith("/persisted")) {
            yogaUrl.pathname = "/api/graphql";
          } else if (process.env.NODE_ENV !== "production") {
            // Development keeps GraphiQL usable, including its POST requests.
            requestHeaders.set(
              "x-openshapeforge-arbitrary-profile",
              "development",
            );
          } else {
            verifiedSession = await resolveSessionContext(
              requestHeaders,
              dbOptions,
            );
            if (
              verifiedSession.credential !== "none" &&
              verifiedSession.tenantId &&
              verifiedSession.userId
            ) {
              requestHeaders.set(
                "x-openshapeforge-arbitrary-profile",
                "authenticated",
              );
            }
          }
          const response = await ready.yoga.fetch(
            yogaUrl,
            {
              method: request.method,
              headers: requestHeaders,
              body: bodyFromFastify(request.method, request.body),
            },
            {
              fastifyRequest: request,
              fastifyReply: reply,
              ...(verifiedSession ? { verifiedSession } : {}),
            },
          );

          return reply.send(response);
        },
      });

    registerGeneratedRestRoutes(routes, dbOptions);
    registerDocumentRestRoutes(routes, dbOptions);
    registerConnectorRestRoutes(routes, {
      ...dbOptions,
      config: readConnectorRuntimeConfig(),
      egressOwner,
    });
    // Inside the same child plugin, so the callback an unauthenticated stranger
    // can reach sits behind the rate limiter like everything else.
    registerConnectorOAuthRoutes(routes, {
      ...dbOptions,
      config: readConnectorRuntimeConfig(),
      publicOrigin: process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN,
      appOrigin: process.env.OPENSHAPEFORGE_APP_ORIGIN,
      egressOwner,
    });
    registerGeneratedMcpServer(routes, {
      ...dbOptions,
      modules: initialised.loaded,
      egressOwner,
      ...(modulePlatform ? { modulePlatform } : {}),
    });
    registerProtectedResourceMetadata(routes);
    registerAuthorizationServerMetadataAliases(routes);
    registerApiKeyRestRoutes(routes, {
      ...dbOptions,
      config: readApiKeyProvisioningConfig(),
    });
    // The tenant control plane, on its own mount and its own realm. Registered
    // unconditionally so an unconfigured deployment answers 503 naming what is
    // missing rather than 404, which reads like a version mismatch.
    registerControlRestRoutes(routes, dbOptions);

    for (const module of initialised.loaded) {
      module.restRoutes?.(routes, moduleContext);
    }
    if (operationModulesConfigured) {
      registerOperationRestRoutes(routes, initialised.loaded, moduleContext, operationContracts);
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
    cors: readGraphqlCorsPolicy(),
    ...(process.env.DATABASE_URL
      ? { databaseUrl: process.env.DATABASE_URL }
      : {}),
    modules: await loadRuntimeModules(),
  });

  await app.listen({ port, host });
  return app;
}
