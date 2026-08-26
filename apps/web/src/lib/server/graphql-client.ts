// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { cookies } from "next/headers";
import { getCachedSession } from "@/lib/cached-session";
import { GRAPHQL_CACHE_VERSION_COOKIE } from "@/lib/graphql-cache-version";
import { buildGatewayGraphqlUrl } from "@/lib/server/gateway";
import { executeGraphqlTransport } from "@/lib/server/persisted-operation";
import { startWebTelemetrySpan } from "@/lib/server/opentelemetry";
import { applyTraceHeaders, readTraceContext } from "@/lib/server/trace-context";
import { buildGraphqlGatewayRequestContext } from "./graphql-client/context";
import {
  GraphqlProxyError,
  extractPayloadMessage,
  statusFromGraphqlPayload,
  type GraphqlPayload,
} from "./graphql-client/errors";

export { buildGraphqlGatewayRequestContext } from "./graphql-client/context";
export { GraphqlProxyError, isGraphqlProxyError } from "./graphql-client/errors";

type GraphqlQueryCacheEntry = {
  expiresAt: number;
  value: unknown;
};

const GRAPHQL_QUERY_CACHE_TTL_MS = 10_000;
const GRAPHQL_QUERY_CACHE_MAX_ENTRIES = 200;
const graphqlQueryCache = new Map<string, GraphqlQueryCacheEntry>();
const graphqlInFlightQueries = new Map<string, Promise<unknown>>();

function isGraphqlMutation(query: string): boolean {
  return /^\s*mutation\b/i.test(query);
}

function readGraphqlOperation(input: string): {
  type: "mutation" | "query" | "subscription" | "unknown";
  name?: string;
} {
  const match = input.match(
    /^\s*(mutation|query|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)?/i,
  );
  return {
    type:
      (match?.[1]?.toLowerCase() as
        | "mutation"
        | "query"
        | "subscription"
        | undefined) ?? "unknown",
    ...(match?.[2] ? { name: match[2] } : {}),
  };
}

function buildGraphqlQueryCacheKey(input: {
  endpoint: string;
  sessionKey: string;
  cacheVersion: string;
  query: string;
  variables?: Record<string, unknown>;
}): string {
  return JSON.stringify([
    input.endpoint,
    input.sessionKey,
    input.cacheVersion,
    input.query,
    input.variables ?? null,
  ]);
}

async function readGraphqlCacheVersion(): Promise<string> {
  try {
    const cookieStore = await cookies();
    return cookieStore.get(GRAPHQL_CACHE_VERSION_COOKIE)?.value ?? "";
  } catch {
    return "";
  }
}

function readGraphqlQueryCache<TData>(cacheKey: string): TData | undefined {
  const cached = graphqlQueryCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  if (cached.expiresAt <= Date.now()) {
    graphqlQueryCache.delete(cacheKey);
    return undefined;
  }

  return cached.value as TData;
}

function writeGraphqlQueryCache<TData>(cacheKey: string, value: TData): void {
  if (graphqlQueryCache.size >= GRAPHQL_QUERY_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, entry] of graphqlQueryCache) {
      if (entry.expiresAt <= now) {
        graphqlQueryCache.delete(key);
      }
    }
  }

  if (graphqlQueryCache.size >= GRAPHQL_QUERY_CACHE_MAX_ENTRIES) {
    const oldestKey = graphqlQueryCache.keys().next().value;
    if (oldestKey) {
      graphqlQueryCache.delete(oldestKey);
    }
  }

  graphqlQueryCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + GRAPHQL_QUERY_CACHE_TTL_MS,
  });
}

function clearSessionGraphqlQueryCache(sessionKey: string): void {
  for (const key of graphqlQueryCache.keys()) {
    if (key.includes(`"${sessionKey}"`)) {
      graphqlQueryCache.delete(key);
    }
  }

  for (const key of graphqlInFlightQueries.keys()) {
    if (key.includes(`"${sessionKey}"`)) {
      graphqlInFlightQueries.delete(key);
    }
  }
}

export async function clearCurrentSessionGraphqlQueryCache(): Promise<void> {
  const session = await getCachedSession();
  const sessionKey = session?.sessionId ?? session?.sub ?? session?.tenantId ?? null;
  if (!sessionKey) {
    return;
  }

  clearSessionGraphqlQueryCache(sessionKey);
}

export async function executeGraphqlRequest<TData>(input: {
  query: string;
  variables?: Record<string, unknown>;
  cache?: RequestCache;
  traceHeaders?: Headers;
  /**
   * The web server keeps a short process-local read cache to collapse duplicate
   * server component reads. Highly-mutating authoring surfaces can opt out so a
   * refresh immediately after a mutation cannot reuse an older definition.
   */
  queryCache?: boolean;
  /**
   * Fixed first-party operations use the generated persisted manifest. Only
   * callers that deliberately build a query at runtime may choose the existing
   * authenticated integration profile.
   */
  profile?: "persisted" | "integration";
}): Promise<TData> {
  const gatewayUrl = buildGatewayGraphqlUrl();
  const profile = input.profile ?? "persisted";
  if (profile === "persisted") {
    gatewayUrl.pathname = `${gatewayUrl.pathname.replace(/\/$/, "")}/persisted`;
  }
  const endpoint = gatewayUrl.toString();
  const { headers, session } = await buildGraphqlGatewayRequestContext({
    traceHeaders: input.traceHeaders,
  });

  const isReadOperation = !isGraphqlMutation(input.query);
  const sessionKey =
    session.sessionId ?? session.sub ?? session.tenantId ?? "anonymous";
  const cacheVersion = isReadOperation ? await readGraphqlCacheVersion() : "";
  const shouldUseQueryCache = isReadOperation && input.queryCache !== false;
  const queryCacheKey = shouldUseQueryCache
    ? buildGraphqlQueryCacheKey({
        endpoint,
        sessionKey,
        cacheVersion,
        query: input.query,
        variables: input.variables,
      })
    : null;

  if (queryCacheKey) {
    const cached = readGraphqlQueryCache<TData>(queryCacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const inFlight = graphqlInFlightQueries.get(queryCacheKey);
    if (inFlight) {
      return inFlight as Promise<TData>;
    }
  } else {
    clearSessionGraphqlQueryCache(sessionKey);
  }

  const requestPromise = (async () => {
    let response: Response;
    let payload: unknown;
    let isJsonResponse = false;
    let responseStatus: number | undefined;
    const operation = readGraphqlOperation(input.query);
    const trace = {
      traceId: readTraceContext(headers).traceId,
      traceparent: "",
    };
    const span = startWebTelemetrySpan({
      name: `GraphQL ${operation.type}${operation.name ? ` ${operation.name}` : ""}`,
      kind: "SPAN_KIND_CLIENT",
      trace,
      attributes: {
        "server.address": new URL(endpoint).host,
        "graphql.operation.type": operation.type,
        "graphql.operation.name": operation.name,
      },
    });
    applyTraceHeaders(headers, span.traceContext());
    try {
      const requestCache = input.cache ?? "no-store";
      const attempt = await executeGraphqlTransport({
        profile,
        persistedEndpoint: endpoint,
        rawEndpoint: buildGatewayGraphqlUrl().toString(),
        headers,
        query: input.query,
        variables: input.variables,
        operationName: operation.name,
        requestCache,
      });
      response = attempt.response;
      payload = attempt.payload;
      isJsonResponse = attempt.isJsonResponse;
      responseStatus = response.status;
    } catch (cause) {
      const message = `GraphQL backend unreachable at ${endpoint}`;
      const error = new Error(message) as Error & {
        cause?: unknown;
        networkError?: { message: string; status?: number };
      };
      error.cause = cause;
      error.networkError = {
        message,
      };
      span.recordException(error);
      span.end({ "error.type": "network", "http.response.status_code": responseStatus });
      throw error;
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok) {
      const error = new GraphqlProxyError(
        extractPayloadMessage(payload, response.statusText || "GraphQL request failed."),
        response.status,
        payload,
      );
      span.recordException(error);
      span.end({ "http.response.status_code": response.status });
      throw error;
    }

    if (!isJsonResponse) {
      const error = new GraphqlProxyError(
        `GraphQL endpoint returned ${contentType || "a non-JSON response"}.`,
        502,
        payload,
      );
      span.recordException(error);
      span.end({ "http.response.status_code": response.status });
      throw error;
    }

    if (payload && typeof payload === "object" && Array.isArray((payload as GraphqlPayload<TData>).errors)) {
      const error = new GraphqlProxyError(
        extractPayloadMessage(payload, "GraphQL request failed."),
        statusFromGraphqlPayload(payload),
        payload,
      );
      span.recordException(error);
      span.end({ "http.response.status_code": response.status, "graphql.errors": true });
      throw error;
    }

    const data = ((payload as GraphqlPayload<TData> | null)?.data ?? null) as TData;

    if (queryCacheKey) {
      writeGraphqlQueryCache(queryCacheKey, data);
    }

    span.end({ "http.response.status_code": response.status });
    return data;
  })();

  if (queryCacheKey) {
    graphqlInFlightQueries.set(queryCacheKey, requestPromise);
  }

  try {
    return await requestPromise;
  } finally {
    if (queryCacheKey) {
      graphqlInFlightQueries.delete(queryCacheKey);
    }
  }
}
