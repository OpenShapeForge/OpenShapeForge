// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { applyTrustedContextHeaders } from "../packages/auth/src/index.js";
import { Registry } from "../packages/observability/src/index.js";
import webManifest from "../apps/web/src/generated/persisted-operations.json" with { type: "json" };
import { __resetSessionResolverForTests } from "../apps/api/src/auth/identity.js";
import type { RuntimeModule } from "../apps/api/src/modules/contract.js";
import { createApiApp } from "../apps/api/src/roles/api.js";
import {
  createPersistedOperationEnvelope,
  executeGraphqlTransport,
} from "../apps/web/src/lib/server/persisted-operation-core.js";

const savedEnv = {
  node: process.env.NODE_ENV,
  secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET,
  anonymousLimit: process.env.API_RATE_LIMIT_MAX,
  trustedLimit: process.env.API_RATE_LIMIT_MAX_TRUSTED,
  depth: process.env.GRAPHQL_MAX_DEPTH,
};
const contextSecret = "live-rolling-transport-secret-438";
const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
let app: ReturnType<typeof createApiApp> | null = null;
let mutationExecutions = 0;
const temporaryWebOperations = new Set<string>();
const rollingModule: RuntimeModule = {
  name: "rolling-operation-proof",
  graphql: () => ({
    mutationFields: "rollingCounter: Int!",
    resolvers: {
      Mutation: {
        rollingCounter: () => ++mutationExecutions,
      },
    },
  }),
};

afterEach(async () => {
  await app?.close();
  app = null;
  mutationExecutions = 0;
  for (const hash of temporaryWebOperations) {
    delete (webManifest.operations as Record<string, string>)[hash];
  }
  temporaryWebOperations.clear();
  for (const [name, value] of [
    ["NODE_ENV", savedEnv.node],
    ["OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET", savedEnv.secret],
    ["API_RATE_LIMIT_MAX", savedEnv.anonymousLimit],
    ["API_RATE_LIMIT_MAX_TRUSTED", savedEnv.trustedLimit],
    ["GRAPHQL_MAX_DEPTH", savedEnv.depth],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetSessionResolverForTests();
});

function generatedOperation(operationName: string): string {
  const operation = Object.values(webManifest.operations).find((query) =>
    new RegExp(`\\b${operationName}\\b`).test(query),
  );
  if (!operation) throw new Error(`Missing generated operation ${operationName}.`);
  return operation;
}

function installWebOperation(query: string): { canonical: string; hash: string } {
  const envelope = createPersistedOperationEnvelope(query);
  const canonical = envelope.canonicalQuery;
  const hash = envelope.persistedBody.extensions.persistedQuery.sha256Hash;
  (webManifest.operations as Record<string, string>)[hash] = canonical;
  temporaryWebOperations.add(hash);
  return { canonical, hash };
}

function identityHeaders(): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: "Basic live-transport-proof",
  });
  applyTrustedContextHeaders(headers, { tenantId, userId, roles: [] }, {
    secret: contextSecret,
  });
  return headers;
}

async function listen(options: Parameters<typeof createApiApp>[0]): Promise<string> {
  process.env.NODE_ENV = "production";
  process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET = contextSecret;
  __resetSessionResolverForTests();
  app = createApiApp({
    ...options,
    metricsRegistry: new Registry(),
    logStream: { write: () => undefined },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing API listener address.");
  return `http://127.0.0.1:${address.port}`;
}

function liveInput(origin: string, headers: Headers, query: string, calls: RequestInit[]) {
  return {
    profile: "persisted" as const,
    persistedEndpoint: `${origin}/api/graphql/persisted`,
    rawEndpoint: `${origin}/api/graphql`,
    headers,
    query,
    requestCache: "no-store" as const,
    fetcher: async (url: string, init: RequestInit) => {
      calls.push(init);
      return fetch(url, init);
    },
  };
}

describe("live web to API rolling persisted-operation contract", () => {
  test("executes a stale mutation exactly once with identity and rate limits intact", async () => {
    process.env.API_RATE_LIMIT_MAX_TRUSTED = "4";
    const mutation = installWebOperation("mutation RollingCounter { rollingCounter }");
    const origin = await listen({
      cors: false,
      modules: { loaded: [rollingModule], failures: [] },
      persistedOperations: { operationNames: [], operations: {} },
    });
    const headers = identityHeaders();
    const calls: RequestInit[] = [];

    const queryResult = await executeGraphqlTransport(liveInput(
      origin,
      headers,
      generatedOperation("ActiveTenantShell"),
      calls,
    ));
    expect((queryResult.payload as { errors: { extensions: { code: string } }[] })
      .errors[0]?.extensions.code).toBe("DATABASE_NOT_CONFIGURED");

    const mutationResult = await executeGraphqlTransport({
      ...liveInput(origin, headers, mutation.canonical, calls),
    });
    expect(mutationResult.payload).toEqual({ data: { rollingCounter: 1 } });
    expect(mutationExecutions).toBe(1);
    expect(calls).toHaveLength(4);
    for (const [index, call] of calls.entries()) {
      const body = JSON.parse(String(call.body));
      expect(Boolean(body.query)).toBe(index % 2 === 1);
      const sent = new Headers(call.headers);
      expect(sent.get("authorization")).toBe("Basic live-transport-proof");
      expect(sent.get("x-tenant-id")).toBe(tenantId);
      expect(sent.get("x-user-id")).toBe(userId);
      expect(sent.get("x-openshapeforge-context-signature")).toBeTruthy();
    }

    const limited = await fetch(`${origin}/api/ready`, { headers });
    expect(limited.status).toBe(429);
  });

  test("executes a manifest-hit mutation once without a raw retry", async () => {
    const mutation = installWebOperation("mutation RollingCounter { rollingCounter }");
    const origin = await listen({
      cors: false,
      modules: { loaded: [rollingModule], failures: [] },
      persistedOperations: {
        operationNames: ["RollingCounter"],
        operations: { [mutation.hash]: mutation.canonical },
      },
    });
    const calls: RequestInit[] = [];
    const result = await executeGraphqlTransport(liveInput(
      origin,
      identityHeaders(),
      mutation.canonical,
      calls,
    ));
    expect(result.payload).toEqual({ data: { rollingCounter: 1 } });
    expect(mutationExecutions).toBe(1);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.body)).query).toBeUndefined();
  });

  test("never executes a runtime-only mutation after a hash miss", async () => {
    const origin = await listen({
      cors: false,
      modules: { loaded: [rollingModule], failures: [] },
      persistedOperations: { operationNames: [], operations: {} },
    });
    const calls: RequestInit[] = [];
    const result = await executeGraphqlTransport(liveInput(
      origin,
      identityHeaders(),
      "mutation RuntimeOnlyCounter { rollingCounter }",
      calls,
    ));
    expect(JSON.stringify(result.payload)).toMatch(/PersistedQueryNotFound/);
    expect(mutationExecutions).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("applies GraphQL Armor to the authenticated raw fallback", async () => {
    process.env.GRAPHQL_MAX_DEPTH = "1";
    const origin = await listen({
      cors: false,
      persistedOperations: { operationNames: [], operations: {} },
    });
    const calls: RequestInit[] = [];
    const result = await executeGraphqlTransport(liveInput(
      origin,
      identityHeaders(),
      generatedOperation("HealthProbe"),
      calls,
    ));
    expect(calls).toHaveLength(2);
    expect((result.payload as { data?: unknown }).data).toBeUndefined();
    expect(JSON.stringify(result.payload)).toMatch(/depth/i);
  });
});
