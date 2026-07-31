// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { randomBytes } from "node:crypto";

export const TRACE_ID_HEADER = "x-openshapeforge-trace-id";
export const TRACEPARENT_HEADER = "traceparent";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/i;
const TRACEPARENT_PATTERN =
  /^[\da-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[\da-f]{2}$/i;

export type TraceContext = {
  traceId: string;
  traceparent: string;
};

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function normalizeTraceId(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || !TRACE_ID_PATTERN.test(trimmed) || /^0+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function traceIdFromTraceparent(value: string | null | undefined): string | null {
  const match = value?.trim().match(TRACEPARENT_PATTERN);
  return normalizeTraceId(match?.[1]);
}

export function spanIdFromTraceparent(value: string | null | undefined): string | null {
  const match = value?.trim().match(TRACEPARENT_PATTERN);
  const spanId = match?.[2]?.toLowerCase();
  return spanId && SPAN_ID_PATTERN.test(spanId) && !/^0+$/.test(spanId)
    ? spanId
    : null;
}

export function buildTraceparent(traceId: string, spanId = generateSpanId()): string {
  const normalizedTraceId = normalizeTraceId(traceId) ?? generateTraceId();
  const normalizedSpanId = SPAN_ID_PATTERN.test(spanId) && !/^0+$/.test(spanId)
    ? spanId.toLowerCase()
    : generateSpanId();
  return `00-${normalizedTraceId}-${normalizedSpanId}-01`;
}

export function readTraceContext(headers?: Headers): TraceContext {
  const existingTraceparent = headers?.get(TRACEPARENT_HEADER);
  const traceId =
    traceIdFromTraceparent(existingTraceparent) ??
    normalizeTraceId(headers?.get(TRACE_ID_HEADER)) ??
    generateTraceId();
  const hasValidTraceparent = existingTraceparent?.match(TRACEPARENT_PATTERN);
  return {
    traceId,
    traceparent: hasValidTraceparent
      ? (existingTraceparent ?? "").toLowerCase()
      : "",
  };
}

export function applyTraceHeaders(headers: Headers, trace: TraceContext): void {
  headers.set(TRACE_ID_HEADER, trace.traceId);
  headers.set(TRACEPARENT_HEADER, trace.traceparent || buildTraceparent(trace.traceId));
}
