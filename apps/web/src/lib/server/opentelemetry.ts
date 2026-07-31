// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { randomBytes } from "node:crypto";
import {
  buildTraceparent,
  spanIdFromTraceparent,
  type TraceContext,
} from "@/lib/server/trace-context";

type AttributeValue = string | number | boolean | null | undefined;

type SpanKind =
  | "SPAN_KIND_INTERNAL"
  | "SPAN_KIND_SERVER"
  | "SPAN_KIND_CLIENT";

type PendingSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, AttributeValue>;
  status?: { code: "STATUS_CODE_ERROR"; message?: string };
};

const MAX_BATCH_SIZE = 32;
const MAX_QUEUE_SIZE = 1_024;
const FLUSH_INTERVAL_MS = 1_000;
const DROP_WARNING_INTERVAL = 100;

let queue: PendingSpan[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let droppedSpanCount = 0;

export function startWebTelemetrySpan(input: {
  name: string;
  trace: TraceContext;
  kind?: SpanKind;
  attributes?: Record<string, AttributeValue>;
}) {
  const traceId = input.trace.traceId;
  const spanId = randomBytes(8).toString("hex");
  const parentSpanId = spanIdFromTraceparent(input.trace.traceparent);
  const attributes = { ...(input.attributes ?? {}) };
  const startTimeUnixNano = nowUnixNano();
  let ended = false;
  let status: PendingSpan["status"];

  return {
    traceContext: (): TraceContext => ({
      traceId,
      traceparent: buildTraceparent(traceId, spanId),
    }),
    recordException(error: unknown) {
      const exceptionType = error instanceof Error ? error.name : "Error";
      status = {
        code: "STATUS_CODE_ERROR",
        message: exceptionType,
      };
      attributes["exception.type"] = exceptionType;
      attributes["exception.message.redacted"] = true;
    },
    end(extraAttributes: Record<string, AttributeValue> = {}) {
      if (ended) return;
      ended = true;
      for (const [key, value] of Object.entries(extraAttributes)) {
        attributes[key] = value;
      }
      enqueueSpan({
        traceId,
        spanId,
        ...(parentSpanId ? { parentSpanId } : {}),
        name: input.name,
        kind: input.kind ?? "SPAN_KIND_INTERNAL",
        startTimeUnixNano,
        endTimeUnixNano: nowUnixNano(),
        attributes,
        ...(status ? { status } : {}),
      });
    },
  };
}

export function exportCompletedWebTelemetrySpan(input: PendingSpan) {
  enqueueSpan(input);
}

function endpoint() {
  if (process.env.OTEL_TRACES_EXPORTER?.trim().toLowerCase() === "none") {
    return null;
  }
  const explicit = normalizedText(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  if (explicit) return explicit;
  const base = normalizedText(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  return base ? `${base.replace(/\/+$/, "")}/v1/traces` : null;
}

function serviceName() {
  return normalizedText(process.env.OTEL_SERVICE_NAME) ?? "openshapeforge-web";
}

function serviceNamespace() {
  return normalizedText(process.env.OTEL_SERVICE_NAMESPACE);
}

function normalizedText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function nowUnixNano() {
  return `${Date.now()}000000`;
}

function enqueueSpan(span: PendingSpan) {
  if (!endpoint()) return;
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
    droppedSpanCount += 1;
    if (droppedSpanCount === 1 || droppedSpanCount % DROP_WARNING_INTERVAL === 0) {
      console.warn(`[otel:web] dropped ${droppedSpanCount} span(s) because the export queue is full`);
    }
  }
  queue.push(span);
  if (queue.length >= MAX_BATCH_SIZE) {
    void flushQueue();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushQueue();
    }, FLUSH_INTERVAL_MS);
  }
}

export function __resetWebTelemetryForTests() {
  if (flushTimer) clearTimeout(flushTimer);
  queue = [];
  flushTimer = null;
  flushing = false;
  droppedSpanCount = 0;
}

export function __webTelemetryStateForTests() {
  return {
    queueLength: queue.length,
    droppedSpanCount,
    flushing,
  };
}

async function flushQueue() {
  const target = endpoint();
  if (flushing || !target || queue.length === 0) return;
  flushing = true;
  const spans = queue.splice(0, MAX_BATCH_SIZE);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildOtlpPayload(spans)),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      console.warn(`[otel:web] export failed with ${response.status}: ${await response.text()}`);
    }
  } catch (error) {
    console.warn("[otel:web] export failed", error instanceof Error ? error.message : error);
  } finally {
    flushing = false;
    if (queue.length > 0) {
      void flushQueue();
    }
  }
}

function buildOtlpPayload(spans: PendingSpan[]) {
  return {
    resourceSpans: [{
      resource: {
        attributes: otlpAttributes({
          "service.name": serviceName(),
          "service.namespace": serviceNamespace(),
        }),
      },
      scopeSpans: [{
        scope: { name: "openshapeforge.web.observability" },
        spans: spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: span.kind,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: otlpAttributes(span.attributes),
          ...(span.status ? { status: span.status } : {}),
        })),
      }],
    }],
  };
}

function otlpAttributes(attributes: Record<string, AttributeValue>) {
  return Object.entries(attributes).flatMap(([key, value]) => {
    if (value === null || value === undefined) return [];
    return [{ key, value: otlpValue(value) }];
  });
}

function otlpValue(value: string | number | boolean) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}
