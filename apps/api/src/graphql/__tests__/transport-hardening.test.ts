// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import persistedManifest from "../../generated/graphql/persisted-operations.json" with { type: "json" };
import { createApiApp } from "../../roles/api.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalRateLimit = process.env.API_RATE_LIMIT_MAX;
const originalMaxDepth = process.env.GRAPHQL_MAX_DEPTH;
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
