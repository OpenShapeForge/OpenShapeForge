// SPDX-License-Identifier: BUSL-1.1
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";

export type OpenTelemetryBootstrapOptions = {
  /** Omit to keep tracing disabled rather than exporting to an implicit host. */
  tracesEndpoint?: string;
  serviceName: string;
  serviceNamespace?: string;
  headers?: Record<string, string>;
};

let sdk: NodeSDK | null = null;

/**
 * Start instrumentation before framework/database modules are imported.
 * Idempotence protects watch mode; the host owns endpoint and service policy.
 */
export function bootstrapOpenTelemetry(
  options: OpenTelemetryBootstrapOptions,
): NodeSDK | null {
  if (sdk || !options.tracesEndpoint) return sdk;
  const endpoint = new URL(options.tracesEndpoint);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
    throw new Error("The OTLP traces endpoint must use HTTPS outside localhost.");
  }
  sdk = new NodeSDK({
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
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  return sdk;
}

export async function shutdownOpenTelemetry(): Promise<void> {
  const active = sdk;
  sdk = null;
  await active?.shutdown();
}
