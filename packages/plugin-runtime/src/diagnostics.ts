// SPDX-License-Identifier: BUSL-1.1
/** Shared diagnostic values; contains no host or analysis policy. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export type Outcome = "success" | "input_error" | "authorization_refusal" | "business_refusal" | "runtime_error" | "protocol_error" | "cancelled" | "unknown";
export type Correlation = {
  conversationId?: string;
  conversationSource?: "codex.threadId" | "openai.session";
  turnId?: string;
  sessionId?: string;
  transportSessionId?: string;
  windowId?: string;
  itemId?: string;
  callId?: string;
  toolUseId?: string;
  traceparent?: string;
  progressToken?: Json;
  model?: string;
  reasoningEffort?: string;
  turnStartedAt?: number;
};
export type UsageEvent = {
  /** Server-owned capture provenance; absent on pre-release, unverified captures. */
  captureVersion?: number;
  id: string;
  tenantId: string | null;
  actorId: string | null;
  environment: string;
  receivedAt: string;
  completedAt: string | null;
  method: string;
  toolName: string | null;
  operationId: string | null;
  component: string | null;
  external: boolean;
  parentId: string | null;
  systemOrigin: boolean;
  client: { name: string | null; version: string | null; protocol: string | null; capabilities: Json };
  metadata: ObjectValue;
  correlation: Correlation;
  arguments: Json;
  result: Json;
  outcome: Outcome;
  error: { code: string; message: string; paths: string[]; retryable?: boolean } | null;
  httpStatus: number | null;
  isError: boolean;
  durationMs: number | null;
  responseBytes: number;
  delivery: "prepared" | "sent" | "interrupted" | "unknown";
  contractHash: string | null;
  taskId: string | null;
  redactions: string[];
  truncated: string[];
};
export type ContractSnapshot = {
  hash: string;
  tenantId: string | null;
  capturedAt: string;
  content: Json;
};
import { createHash } from "node:crypto";

const credentialName = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|leaseToken|handoffToken)$/i;
const credentialValue = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]+=*|-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@)/i;
export type Captured = { value: Json; redactions: string[]; truncated: string[] };

/** Ordinary values, including unknown keys, survive. Confidential paths come from the contract. */
export function capture(value: unknown, options: { confidentialPaths?: readonly string[]; secretValues?: readonly string[]; maxBytes?: number; maxDepth?: number; schemaDocument?: boolean } = {}): Captured {
  const redactions: string[] = [], truncated: string[] = [];
  const privatePaths = new Set(options.confidentialPaths ?? []);
  let remaining = options.maxBytes ?? 8 * 1024 * 1024;
  const seen = new WeakSet<object>();
  const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
  function visit(input: unknown, path: string, depth: number): Json {
    if (privatePaths.has(path)) { redactions.push(path); return { redacted: true, type: input === null ? "null" : Array.isArray(input) ? "array" : typeof input }; }
    if (depth > (options.maxDepth ?? 64) || remaining <= 0) { truncated.push(path); return { truncated: true }; }
    if (input === undefined) return { undefined: true };
    if (input === null || typeof input === "boolean") { remaining -= 5; return input; }
    if (typeof input === "number") { remaining -= 24; return Number.isFinite(input) ? input : { nonFinite: String(input) }; }
    if (typeof input === "string") {
      // MCP often mirrors structured payloads into JSON text blocks. Apply the
      // same secret rules there, otherwise a redacted field survives its text copy.
      if (/^\s*[\[{]/.test(input)) {
        try {
          const parsed: unknown = JSON.parse(input);
          const beforeRedactions=redactions.length,beforeTruncated=truncated.length;
          const cleaned=visit(parsed,`${path}/$json`,depth+1);
          return beforeRedactions===redactions.length&&beforeTruncated===truncated.length?input:JSON.stringify(cleaned);
        } catch { /* Ordinary non-JSON text follows the same value rules below. */ }
      }
      if (credentialValue.test(input) || options.secretValues?.some(secret => secret.length > 0 && input.includes(secret))) { redactions.push(path); return { redacted: true, type: "string" }; }
      const bytes = Buffer.byteLength(input);
      if (bytes > remaining) { truncated.push(path); remaining = 0; return { truncated: true, originalBytes: bytes }; }
      remaining -= bytes; return input;
    }
    if (typeof input !== "object") return { unsupportedType: typeof input };
    if (seen.has(input)) { truncated.push(path); return { circular: true }; }
    seen.add(input);
    if (Array.isArray(input)) {
      const output: Json[] = [];
      for (let index = 0; index < input.length; index++) {
        if (remaining <= 0) { truncated.push(path); output.push({ truncatedItems: input.length - index }); break; }
        output.push(visit(input[index], `${path}/${index}`, depth + 1));
      }
      seen.delete(input); return output;
    }
    const output: ObjectValue = Object.create(null);
    for (const [key, entry] of Object.entries(input)) {
      const child = `${path}/${pointer(key)}`;
      remaining -= Buffer.byteLength(key) + 4;
      if (remaining <= 0) { truncated.push(path); output["$captureTruncated"] = true; break; }
      if (!options.schemaDocument && credentialName.test(key)) { redactions.push(child); output[key] = { redacted: true, type: entry === null ? "null" : typeof entry }; }
      else output[key] = visit(entry, child, depth + 1);
    }
    seen.delete(input); return output;
  }
  return { value: visit(value, "", 0), redactions, truncated };
}

/** Stable object ordering makes snapshots and argument fingerprints reproducible. */
export function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}
export const fingerprint = (value: Json): string => createHash("sha256").update(canonical(value)).digest("hex");


export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

/** Preserve the original envelope separately: normalization is an index, not a replacement. */
export function normalizeMetadata(metadata: ObjectValue, transportSessionId?: string): Correlation {
  const turn = object(metadata["x-codex-turn-metadata"]);
  const conversation = text(metadata.threadId) ?? text(turn?.thread_id);
  const openai = text(metadata["openai/session"]);
  const normalized: Correlation = {};
  if (conversation) { normalized.conversationId = conversation; normalized.conversationSource = "codex.threadId"; }
  else if (openai) { normalized.conversationId = openai; normalized.conversationSource = "openai.session"; }
  const strings: [keyof Correlation, unknown][] = [
    ["turnId", turn?.turn_id], ["sessionId", metadata.sessionId ?? turn?.session_id],
    ["windowId", metadata.windowId], ["itemId", metadata.itemId], ["callId", metadata.callId],
    ["toolUseId", metadata["claudecode/toolUseId"]], ["traceparent", metadata.traceparent],
    ["model", turn?.model], ["reasoningEffort", turn?.reasoning_effort],
    ["transportSessionId", transportSessionId],
  ];
  for (const [key, value] of strings) if (text(value)) Object.assign(normalized, { [key]: value });
  if (typeof turn?.turn_started_at_unix_ms === "number" && Number.isFinite(turn.turn_started_at_unix_ms)) normalized.turnStartedAt = turn.turn_started_at_unix_ms;
  if (metadata.progressToken !== undefined) normalized.progressToken = metadata.progressToken as Json;
  return normalized;
}

/** Never join tenants, actors, environments or client surfaces through a client-asserted ID. */
export function conversationKey(event: {
  tenantId: string | null; actorId: string | null; environment: string;
  client: { name: string | null }; correlation: Correlation;
}): string | null {
  const { conversationId, conversationSource } = event.correlation;
  return event.tenantId && event.actorId && conversationId && conversationSource
    ? JSON.stringify([event.environment, event.tenantId, event.actorId, event.client.name, conversationSource, conversationId]) : null;
}

export type RuntimeMcpDiagnosticBatch = {
  readonly receipt: string;
  readonly events: readonly UsageEvent[];
  readonly snapshots: readonly ContractSnapshot[];
  readonly health: { collectorId: string; since: string; dropped: number; writeFailures: number; expiredUnprocessed: number };
};
/** Live tenant-scoped access to the core's short-lived diagnostic journal. */
export type RuntimeMcpDiagnosticServices<Session> = {
  read(session: Session, options?: { limit?: number }): Promise<RuntimeMcpDiagnosticBatch>;
  acknowledge(session: Session, receipt: string): Promise<void>;
};
