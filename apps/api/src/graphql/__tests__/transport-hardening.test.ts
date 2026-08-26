// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import persistedManifest from "../../generated/graphql/persisted-operations.json" with { type: "json" };
import { createApiApp } from "../../roles/api.js";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { __resetSessionResolverForTests } from "../../auth/identity.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalRateLimit = process.env.API_RATE_LIMIT_MAX;
const originalMaxDepth = process.env.GRAPHQL_MAX_DEPTH;
const originalContextSecret = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalRateLimit === undefined) delete process.env.API_RATE_LIMIT_MAX;
  else process.env.API_RATE_LIMIT_MAX = originalRateLimit;
  if (originalMaxDepth === undefined) delete process.env.GRAPHQL_MAX_DEPTH;
  else process.env.GRAPHQL_MAX_DEPTH = originalMaxDepth;
  if (originalContextSecret === undefined) delete process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET;
  else process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = originalContextSecret;
  __resetSessionResolverForTests();
});

function persistedEntry(operationName: string): [string, string] {
  const entry = Object.entries(persistedManifest.operations).find(([, query]) =>
    new RegExp(`\\b${operationName}\\b`).test(query),
  );
  if (!entry) throw new Error(`Missing persisted operation ${operationName}.`);
  return entry;
}

async function persistedRequest(
  hash: string,
  variables?: Record<string, unknown>,
) {
  return app!.inject({
    method: "POST",
    url: "/api/graphql/persisted",
    headers: { "content-type": "application/json" },
    payload: {
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    },
  });
}

function preflight(origin: string) {
  return app!.inject({
    method: "OPTIONS",
    url: "/api/graphql",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
}

describe("consumer-configured GraphQL CORS", () => {
  test("reflects only exact configured origins with the configured credentials policy", async () => {
    app = createApiApp({
      cors: {
        origin: ["http://localhost:3000", "https://app.example.test"],
        methods: ["POST", "OPTIONS"],
        allowedHeaders: ["authorization", "content-type"],
        credentials: true,
      },
    });

    for (const origin of ["http://localhost:3000", "https://app.example.test"]) {
      const response = await preflight(origin);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(response.headers["access-control-allow-methods"]).toContain("POST");
      expect(response.headers["access-control-allow-headers"]).toContain("authorization");
    }

    for (const origin of ["https://evil.test", "https://app.example.test.evil.test", "null"]) {
      const response = await preflight(origin);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    }
  });

  test("supports an explicit deployment with no CORS response headers", async () => {
    app = createApiApp({ cors: false });
    const response = await preflight("http://localhost:3000");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  test("does not affect non-browser GraphQL requests", async () => {
    app = createApiApp({ cors: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/graphql",
      headers: { "content-type": "application/json" },
      payload: { query: "query ServiceHealth { health { status role } }" },
    });
    expect(response.json().data.health).toEqual({ status: "ok", role: "api" });
  });
});

describe("persisted first-party GraphQL profile", () => {
  test("executes a known query by hash and rejects unknown, altered, and raw operations", async () => {
    app = createApiApp({ cors: false });
    const [healthHash, healthQuery] = persistedEntry("HealthProbe");
    const known = await persistedRequest(healthHash);
    expect(known.json().data.health).toEqual({ status: "ok", role: "api" });

    const unknown = await persistedRequest("0".repeat(64));
    expect(JSON.stringify(unknown.json())).toMatch(/PersistedQueryNotFound/);

    const alteredHash = createHash("sha256").update(`${healthQuery} `).digest("hex");
    const altered = await persistedRequest(alteredHash);
    expect(JSON.stringify(altered.json())).toMatch(/PersistedQueryNotFound/);

    const staleWebDeployment = await app.inject({
      method: "POST",
      url: "/api/graphql/persisted",
      headers: { "content-type": "application/json" },
      payload: {
        operationName: "HealthProbe",
        extensions: { persistedQuery: { version: 1, sha256Hash: "1".repeat(64) } },
      },
    });
    expect(JSON.stringify(staleWebDeployment.json())).toMatch(/PersistedQueryNotFound/);
    expect(staleWebDeployment.json().data).toBeUndefined();

    const raw = await app.inject({
      method: "POST",
      url: "/api/graphql/persisted",
      headers: { "content-type": "application/json" },
      payload: { query: healthQuery },
    });
    expect(JSON.stringify(raw.json())).toMatch(/PersistedQueryOnly/);
  });

  test("preserves authentication for a known query and mutation", async () => {
    app = createApiApp({ cors: false });
    const [queryHash] = persistedEntry("ActiveTenantShell");
    const query = await persistedRequest(queryHash);
    expect(query.json().errors[0].extensions.code).toBe("UNAUTHENTICATED");

    const [mutationHash] = persistedEntry("PersistTaskOutput");
    const mutation = await persistedRequest(mutationHash, { input: { id: crypto.randomUUID(), output: {} } });
    expect(mutation.json().errors[0].extensions.code).toBe("UNAUTHENTICATED");
  });

  test("still applies GraphQL Armor before executing a persisted operation", async () => {
    process.env.GRAPHQL_MAX_DEPTH = "1";
    app = createApiApp({ cors: false });
    const [healthHash] = persistedEntry("HealthProbe");
    const response = await persistedRequest(healthHash);
    expect(response.json().data).toBeUndefined();
    expect(JSON.stringify(response.json())).toMatch(/depth/i);
  });

  test("keeps the authenticated integration profile deliberate and rate-limits persisted requests", async () => {
    process.env.API_RATE_LIMIT_MAX = "1";
    app = createApiApp({ cors: false });
    const raw = await app.inject({
      method: "POST",
      url: "/api/graphql",
      headers: { "content-type": "application/json" },
      payload: { query: "query IntegrationHealth { health { status } }" },
    });
    expect(raw.json().data.health.status).toBe("ok");

    await app.close();
    app = createApiApp({ cors: false });
    const [healthHash] = persistedEntry("HealthProbe");
    expect((await persistedRequest(healthHash)).statusCode).not.toBe(429);
    expect((await persistedRequest(healthHash)).statusCode).toBe(429);
  });

  test("requires verified production identity and ignores caller-supplied profile markers", async () => {
    process.env.NODE_ENV = "production";
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = "transport-hardening-secret";
    __resetSessionResolverForTests();
    app = createApiApp({ cors: false });
    const payload = { query: "query IntegrationHealth { health { status } }" };

    const anonymous = await app.inject({
      method: "POST",
      url: "/api/graphql",
      headers: {
        "content-type": "application/json",
        "x-openshapeforge-arbitrary-profile": "authenticated",
      },
      payload,
    });
    expect(JSON.stringify(anonymous.json())).toMatch(/PersistedQueryOnly/);

    const trusted = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(trusted, {
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      roles: [],
    }, { secret: "transport-hardening-secret" });
    const authenticated = await app.inject({
      method: "POST",
      url: "/api/graphql",
      headers: Object.fromEntries(trusted.entries()),
      payload,
    });
    expect(authenticated.json().data.health.status).toBe("ok");
  });

  test("supports one authenticated raw retry for a stale web manifest", async () => {
    process.env.NODE_ENV = "production";
    process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = "rolling-fallback-secret";
    __resetSessionResolverForTests();
    app = createApiApp({ cors: false });
    const stale = await persistedRequest("f".repeat(64));
    expect(JSON.stringify(stale.json())).toMatch(/PersistedQueryNotFound/);

    const headers = new Headers({ "content-type": "application/json" });
    applyTrustedContextHeaders(headers, {
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      roles: [],
    }, { secret: "rolling-fallback-secret" });
    const fallback = await app.inject({
      method: "POST",
      url: "/api/graphql",
      headers: Object.fromEntries(headers.entries()),
      payload: { query: "query HealthProbe { health { status role } }" },
    });
    expect(fallback.json().data.health).toEqual({ status: "ok", role: "api" });
  });
});

describe("GraphiQL developer profile", () => {
  test("serves a safe usable OSF default query only outside production", async () => {
    process.env.NODE_ENV = "development";
    app = createApiApp({ cors: false });
    const development = await app.inject({
      method: "GET",
      url: "/api/graphql",
      headers: { accept: "text/html" },
    });
    expect(development.statusCode).toBe(200);
    expect(development.body).toContain("OsfHealth");
    expect(development.body).toContain("Authorization");
    expect(development.body).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);

    await app.close();
    process.env.NODE_ENV = "production";
    app = createApiApp({ cors: false });
    const production = await app.inject({
      method: "GET",
      url: "/api/graphql",
      headers: { accept: "text/html" },
    });
    expect(production.headers["content-type"] ?? "").not.toContain("text/html");
    expect(production.body).not.toContain("OsfHealth");
  });
});
