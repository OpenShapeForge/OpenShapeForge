// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import manifest from "../apps/web/src/generated/persisted-operations.json" with { type: "json" };
import {
  createPersistedOperationEnvelope,
  executeGraphqlTransport,
} from "../apps/web/src/lib/server/persisted-operation-core.js";

const missPayload = {
  errors: [{
    message: "PersistedQueryNotFound",
    extensions: { code: "PERSISTED_QUERY_NOT_IN_LIST" },
  }],
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function generatedOperation(prefix: string): string {
  const operation = Object.values(manifest.operations).find((query) => query.startsWith(prefix));
  if (!operation) throw new Error(`Missing generated operation starting with ${prefix}.`);
  return operation;
}

function transportInput(query: string, fetcher: typeof fetch) {
  return {
    profile: "persisted" as const,
    persistedEndpoint: "https://gateway.example.test/api/graphql/persisted",
    rawEndpoint: "https://gateway.example.test/api/graphql",
    headers: new Headers({
      authorization: "Bearer test-identity",
      "x-openshapeforge-tenant-id": "tenant-test",
    }),
    query,
    requestCache: "no-store" as const,
    fetcher,
  };
}

describe("web GraphQL persisted transport", () => {
  test("sends hash-only first and preserves identity on one generated-operation fallback", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const query = generatedOperation("query HealthProbe");
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return calls.length === 1 ? jsonResponse(missPayload) : jsonResponse({ data: { health: { status: "ok" } } });
    };

    const result = await executeGraphqlTransport(transportInput(query, fetcher));
    expect(result.payload).toEqual({ data: { health: { status: "ok" } } });
    expect(calls).toHaveLength(2);
    const first = JSON.parse(String(calls[0]!.init.body));
    const second = JSON.parse(String(calls[1]!.init.body));
    expect(first.query).toBeUndefined();
    expect(first.extensions.persistedQuery.sha256Hash)
      .toBe(createPersistedOperationEnvelope(query).persistedBody.extensions.persistedQuery.sha256Hash);
    expect(second.query).toBe(query);
    expect(calls.map((call) => call.url)).toEqual([
      "https://gateway.example.test/api/graphql/persisted",
      "https://gateway.example.test/api/graphql",
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe("Bearer test-identity");
      expect(headers.get("x-openshapeforge-tenant-id")).toBe("tenant-test");
    }
  });

  test("retries a generated mutation only after its hash-only miss", async () => {
    const bodies: Record<string, unknown>[] = [];
    const query = generatedOperation("mutation PersistTaskOutput");
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? jsonResponse(missPayload) : jsonResponse({ data: { updateTask: { id: "task" } } });
    };
    await executeGraphqlTransport(transportInput(query, fetcher));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.query).toBeUndefined();
    expect(bodies[1]!.query).toBe(query);
  });

  test("does not retry resolver errors that only resemble a persisted miss", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return jsonResponse({
        errors: [{ message: "PersistedQueryNotFound", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
      });
    };
    await executeGraphqlTransport(transportInput(generatedOperation("query HealthProbe"), fetcher));
    expect(calls).toBe(1);
  });

  test("never raw-retries an operation absent from the generated web manifest", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return jsonResponse(missPayload);
    };
    await executeGraphqlTransport(transportInput("query RuntimePrivate { health { status } }", fetcher));
    expect(calls).toBe(1);
  });
});
