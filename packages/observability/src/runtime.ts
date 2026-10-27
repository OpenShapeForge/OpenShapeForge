// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { isOpenTelemetryEnabled } from "./otel.js";

export type RuntimeSpanName =
  | "mcp.request" | "auth.credential" | "auth.relation" | "auth.member" | "auth.address"
  | "operation.resolve" | "operation.execute" | "authorization.policy"
  | "database.acquire" | "database.session" | "external.headers";
export type RuntimeSpanFacts = { operationId?: string; provider?: "jira" | "hubspot" | "other" };

/** Fixed names and bounded facts only. Never export inputs, SQL, URLs or errors. */
export function withRuntimeSpan<T>(name: RuntimeSpanName, work: () => Promise<T>, facts: RuntimeSpanFacts = {}): Promise<T> {
  if (!isOpenTelemetryEnabled()) return work();
  const attributes: Record<string, string> = {};
  if (facts.operationId) {
    attributes["osf.operation.hash"] = createHash("sha256").update(facts.operationId).digest("hex").slice(0, 16);
    attributes["osf.operation.family"] = facts.operationId.startsWith("osf-integration.service.invoke:") ? "service" : /^[A-Z][A-Za-z0-9]+\.(list|get|create|update|delete)$/.test(facts.operationId) ? "entity" : "other";
  }
  if (facts.provider) attributes["osf.provider"] = facts.provider;
  return trace.getTracer("openshapeforge.runtime").startActiveSpan(name, { attributes }, async span => {
    try { return await work(); }
    catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
    finally { span.end(); }
  });
}

/** Driver-reported execution time excludes acquiring a pool connection. */
export function recordDatabaseQuery(durationMs: number, statement: string): void {
  if (!isOpenTelemetryEnabled() || !Number.isFinite(durationMs) || durationMs < 0) return;
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return;
  const verb = /^(select|insert|update|delete|begin|commit|rollback|savepoint|release)\b/i.exec(statement.trimStart())?.[1]?.toLowerCase() ?? "other";
  const areas = ["erp", "integration", "platform"].filter(area => new RegExp(`\\b${area}\\.`, "i").test(statement));
  span.addEvent("database.query", {
    "db.operation.name": verb,
    "osf.db.area": areas.length === 1 ? areas[0]! : "other",
    "osf.db.duration_ms": durationMs,
  });
}
