// SPDX-License-Identifier: BUSL-1.1
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { ClientRequest, IncomingMessage } from "node:http";

export type OpenTelemetryBootstrapOptions = {
  /** Omit to keep tracing disabled rather than exporting to an implicit host. */
  tracesEndpoint?: string;
  serviceName: string;
  serviceNamespace?: string;
  headers?: Record<string, string>;
};

const OTEL_STATE_KEY = Symbol.for("openshapeforge.observability.otel-state");
type OtelGlobal = typeof globalThis & {
  [OTEL_STATE_KEY]?: { sdk: NodeSDK | null };
};

function state() {
  const target = globalThis as OtelGlobal;
  return (target[OTEL_STATE_KEY] ??= { sdk: null });
}

const REDACTED_QUERY_PARAMS = [
  "query", "variables", "extensions", "code", "state", "token",
  "access_token", "refresh_token", "id_token", "session_state", "key", "secret",
  "sig", "Signature", "AWSAccessKeyId", "X-Goog-Signature",
];

function safeTarget(raw: string | undefined): { target: string; hadQuery: boolean } {
  if (!raw) return { target: "/", hadQuery: false };
  try {
    const parsed = new URL(raw, "http://telemetry.invalid");
    return { target: parsed.pathname || "/", hadQuery: Boolean(parsed.search) };
  } catch {
    return { target: "/", hadQuery: raw.includes("?") };
  }
}

/** Overwrite attributes that otherwise carry OAuth or GraphQL query strings. */
export function applyBoundedHttpSpanAttributes(
  span: { setAttribute(name: string, value: string): unknown },
  request: ClientRequest | IncomingMessage,
): void {
  const raw = "path" in request && typeof request.path === "string"
    ? request.path
    : "url" in request ? request.url : undefined;
  const safe = safeTarget(raw);
  span.setAttribute("http.target", safe.target);
  span.setAttribute("url.full", safe.target);
  if (safe.hadQuery) span.setAttribute("url.query", "[REDACTED]");
}

/**
 * Start tracing before framework/database modules are imported. Only bounded
 * HTTP and Fastify spans are enabled: GraphQL documents/resolvers and SQL are
 * deliberately excluded because they may carry tenant or personal data.
 */
export function bootstrapOpenTelemetry(
  options: OpenTelemetryBootstrapOptions,
): NodeSDK | null {
  const lifecycle = state();
  if (lifecycle.sdk || !options.tracesEndpoint) return lifecycle.sdk;
  const endpoint = new URL(options.tracesEndpoint);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
    throw new Error("The OTLP traces endpoint must use HTTPS outside localhost.");
  }
  const configured = getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-http": {
      redactedQueryParams: REDACTED_QUERY_PARAMS,
      requestHook: applyBoundedHttpSpanAttributes,
    },
    "@opentelemetry/instrumentation-graphql": { enabled: false },
  });
  const allowed = new Set([
    "@opentelemetry/instrumentation-http",
    "@opentelemetry/instrumentation-fastify",
  ]);
  lifecycle.sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      ...(options.serviceNamespace
        ? { "service.namespace": options.serviceNamespace }
        : {}),
    }),
    traceExporter: new OTLPTraceExporter({
      url: endpoint.toString(),
      ...(options.headers ? { headers: { ...options.headers } } : {}),
    }),
    instrumentations: configured.filter((item) => allowed.has(item.instrumentationName)),
  });
  lifecycle.sdk.start();
  return lifecycle.sdk;
}

export async function shutdownOpenTelemetry(): Promise<void> {
  const lifecycle = state();
  const active = lifecycle.sdk;
  lifecycle.sdk = null;
  await active?.shutdown();
}
