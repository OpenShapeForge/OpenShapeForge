// SPDX-License-Identifier: BUSL-1.1
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ClientRequest, IncomingMessage } from "node:http";

export type OpenTelemetryBootstrapOptions = {
  /** Omit to keep tracing disabled rather than exporting to an implicit host. */
  tracesEndpoint?: string;
  serviceName: string;
  serviceNamespace?: string;
  headers?: Record<string, string>;
  /** Primarily for hosts with a custom exporter and exported-span tests. */
  traceExporter?: SpanExporter;
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

/** Overwrite transport attributes that may carry IDs, addresses, or secrets. */
export function applyBoundedHttpSpanAttributes(
  span: { setAttribute(name: string, value: string | number): unknown },
  _request: ClientRequest | IncomingMessage,
): void {
  for (const attribute of [
    "http.target",
    "http.url",
    "url.full",
    "url.path",
    "url.query",
    "http.user_agent",
    "http.client_ip",
    "user_agent.original",
    "client.address",
    "net.peer.ip",
    "net.peer.name",
    "network.peer.address",
  ]) {
    span.setAttribute(attribute, "[REDACTED]");
  }
  span.setAttribute("net.peer.port", 0);
  span.setAttribute("client.port", 0);
  span.setAttribute("network.peer.port", 0);
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
  if (lifecycle.sdk || (!options.tracesEndpoint && !options.traceExporter)) {
    return lifecycle.sdk;
  }
  let traceExporter = options.traceExporter;
  if (!traceExporter && options.tracesEndpoint) {
    const endpoint = new URL(options.tracesEndpoint);
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
      throw new Error("The OTLP traces endpoint must use HTTPS outside localhost.");
    }
    traceExporter = new OTLPTraceExporter({
      url: endpoint.toString(),
      ...(options.headers ? { headers: { ...options.headers } } : {}),
    });
  }
  if (!traceExporter) throw new Error("Tracing requires an endpoint or exporter.");
  lifecycle.sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      ...(options.serviceNamespace
        ? { "service.namespace": options.serviceNamespace }
        : {}),
    }),
    traceExporter,
    instrumentations: [
      new HttpInstrumentation({
        redactedQueryParams: REDACTED_QUERY_PARAMS,
        requestHook: applyBoundedHttpSpanAttributes,
      }),
      new FastifyInstrumentation(),
    ],
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
