/**
 * API role: fastify server hosting the GraphQL endpoint at /api/graphql.
 *
 * Trimmed from the full apps/api service — the metrics route, erp document
 * routes, messaging/whatsapp webhooks, workflow node bridges, realtime dirty
 * worker, and entity-event fanout wiring are intentionally absent.
 */
import Fastify, { type FastifyBaseLogger } from "fastify";
import { assertProductionEnv } from "../config/production-guard.js";
import { createDatabaseRuntime, type DatabaseRuntime, type OpenShapeForgeDatabase } from "../db/connection.js";
import {
  checkGeneratedSchemaDrift,
  type GeneratedSchemaDriftResult,
} from "../db/schema-drift.js";
import { createGraphqlYoga } from "../graphql/yoga.js";

/** Startup drift check must not delay readiness meaningfully. */
const DRIFT_CHECK_TIMEOUT_MS = 5000;

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

function headersFromFastify(
  headers: Record<string, string | string[] | undefined>,
) {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }
    if (value !== undefined) {
      result.set(key, value);
    }
  }

  return result;
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
  // Default level stays "info"; LOG_LEVEL=debug surfaces the drift "ok" line.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
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

  app.get("/api/health", async () => ({
    status: "ok",
    role: "api",
  }));

  app.get("/api/ready", async () => ({
    status: "ready",
    role: "api",
  }));

  app.get("/api/graphql/health", async () => ({
    status: "ok",
    role: "api",
  }));

  app.route({
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
