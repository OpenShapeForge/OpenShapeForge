// SPDX-License-Identifier: BUSL-1.1
import { operationErrorOf } from "@openshapeforge/operations";
import { taskAuthorityHash } from "./task-authority.js";
import { ProtocolError, ProtocolErrorCode, type CallToolResult, type CallToolRequest, type Server } from "@modelcontextprotocol/server";
import type { RuntimeExecutionContext, RuntimeExecutionProvider } from "@openshapeforge/plugin-runtime";
import type { ServerScope } from "./server-scope.js";
import { executionReferenceOf } from "./execution-reference.js";
import { runtimeOperationToolResult } from "./tool-results.js";
import { createTaskStore, type TaskBinding, type TaskStore } from "./task-store.js";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const protocolKey = "io.modelcontextprotocol/protocolVersion";
const unavailable = () => new ProtocolError(ProtocolErrorCode.InvalidParams, "Task not found or no longer available.");
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function supportsTasks(meta: unknown): boolean {
  const value = record(meta);
  return value?.[protocolKey] === "2026-07-28" &&
    record(record(record(value[capabilitiesKey])?.extensions)?.[TASKS_EXTENSION]) !== undefined;
}
/**
 * Protocol revision 2026-07-28 requires every tools/call result to name its
 * kind; a client of that revision refuses a result without it. Earlier
 * revisions have no such field, so their results stay exactly as they were.
 */
export function completeToolResult<T extends object>(result: T, meta: unknown): T | (T & { resultType: "complete" }) {
  if (record(meta)?.[protocolKey] !== "2026-07-28" || "resultType" in result) return result;
  return { resultType: "complete", ...result };
}
export function executionProviders(modules: readonly { executionProviders?: readonly RuntimeExecutionProvider[] }[]) {
  const providers = new Map<string, RuntimeExecutionProvider>();
  for (const module of modules) for (const provider of module.executionProviders ?? []) {
    if (!provider.kind.trim() || providers.has(provider.kind)) throw new Error(`Duplicate or empty execution provider: ${provider.kind}`);
    providers.set(provider.kind, provider);
  }
  return providers;
}
type TaskParamsValue = Record<string, unknown> & { taskId: string };
function schema<T>(validate: (value: unknown) => { value: T } | { issues: { message: string }[] }): {
  "~standard": { version: 1; vendor: string; types?: { input: unknown; output: T }; validate: typeof validate }
} { return { "~standard": { version: 1, vendor: "openshapeforge", validate } }; }

export const taskAwareToolParams = schema<CallToolRequest["params"]>(value => {
  const p = record(value);
  if (!p || typeof p.name !== "string" || (p.arguments !== undefined && !record(p.arguments)) || (p._meta !== undefined && !record(p._meta)))
    return { issues: [{ message: "A tool name and object arguments are required." }] };
  return { value: p as CallToolRequest["params"] };
});
const TaskParams = schema<TaskParamsValue>(value => {
  const p = record(value);
  return p && typeof p.taskId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.taskId)
    ? { value: p as TaskParamsValue } : { issues: [{ message: "A valid taskId is required." }] };
});

export function createTasks(input: {
  store: TaskStore; providers: ReadonlyMap<string, RuntimeExecutionProvider>; context: RuntimeExecutionContext;
  onUnavailable?: (code: string) => void;
}) {
  const snapshotFor = async (kind: string, ref: string) => {
    const provider = input.providers.get(kind);
    if (!provider) throw unavailable();
    const snapshot = await provider.read(input.context, { kind, ref });
    if (!Number.isFinite(Date.parse(snapshot.updatedAt))) throw new ProtocolError(ProtocolErrorCode.InternalError, "Execution owner returned an invalid timestamp.");
    return snapshot;
  };
  const read = async (row: TaskBinding) => {
    // Every poll asks the canonical owner with CURRENT authority, even for a terminal result.
    const snapshot = await snapshotFor(row.owner_kind, row.owner_ref);
    const base = { taskId: row.id, status: snapshot.status, createdAt: new Date(row.created_at).toISOString(),
      lastUpdatedAt: new Date(Math.max(new Date(row.created_at).getTime(), new Date(snapshot.updatedAt).getTime())).toISOString(), ttlMs: new Date(row.expires_at).getTime() - new Date(row.created_at).getTime(),
      pollIntervalMs: 5000, ...(snapshot.statusMessage ? { statusMessage: snapshot.statusMessage } : {}) };
    return { ...base, ...(snapshot.status === "completed" ? {
      result: { ...runtimeOperationToolResult(snapshot.result), ...(snapshot.isError ? { isError: true } : {}) },
    } : {}) };
  };
  const lookup = async (id: string) => {
    const row = await input.store.get(id);
    if (!row) throw unavailable();
    return row;
  };
  return {
    async project(result: CallToolResult, meta: unknown) {
      const reference = executionReferenceOf(result);
      if (!supportsTasks(meta) || result.isError || !reference || !input.providers.has(reference.kind)) {
        // A canonical execution remains a normal result when this projection
        // cannot track it. Keep the reason inspectable without logging data.
        if (reference || record(result.structuredContent)?.execution) input.onUnavailable?.(
          !reference ? "EXECUTION_REFERENCE_MISSING" : !supportsTasks(meta) ? "TASK_CAPABILITY_ABSENT" : "EXECUTION_PROVIDER_UNAVAILABLE");
        return completeToolResult(result, meta);
      }
      try {
        // Prove follow access BEFORE retaining a handle. A record-action user
        // may start a process without holding a general workflow-read role.
        const snapshot = await snapshotFor(reference.kind, reference.ref);
        // Start acceptance is distinct from the eventual outcome. Keep its
        // exact original envelope, including on an immediately failed run.
        if (snapshot.status !== "working") return completeToolResult(result, meta);
        const row = await input.store.retain(reference);
        return { resultType: "task", taskId: row.id, status: snapshot.status,
          createdAt: new Date(row.created_at).toISOString(),
          lastUpdatedAt: new Date(Math.max(new Date(row.created_at).getTime(), Date.parse(snapshot.updatedAt))).toISOString(),
          ttlMs: new Date(row.expires_at).getTime() - new Date(row.created_at).getTime(), pollIntervalMs: 5000,
          ...(snapshot.statusMessage ? { statusMessage: snapshot.statusMessage } : {}) };
      } catch (cause) {
        const code = operationErrorOf(cause)?.code;
        input.onUnavailable?.(code && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "TRACKING_UNAVAILABLE");
        // The canonical start has already committed. Never report it as a failed
        // start, which could invite a duplicate; the ordinary envelope is durable.
        return completeToolResult({ ...result, content: [...result.content, { type: "text" as const,
          text: "The execution was accepted, but background tracking is unavailable. Follow the returned execution reference using its existing operations." }] }, meta);
      }
    },
    register(server: Server) {
      server.setRequestHandler("tasks/get", { params: TaskParams }, async params => ({
        resultType: "complete", ...await read(await lookup(params.taskId)),
      }));
      server.setRequestHandler("tasks/cancel", { params: TaskParams }, async params => {
        const row = await lookup(params.taskId);
        const current = await read(row);
        const provider = input.providers.get(row.owner_kind)!;
        // Protocol cancellation is cooperative. Terminal work is a no-op;
        // an owner with no cancellation operation acknowledges without stopping.
        if (current.status === "working" && provider.cancel)
          await provider.cancel(input.context, { kind: row.owner_kind, ref: row.owner_ref });
        return { resultType: "complete" };
      });
      // Human input remains on the owner's existing canonical interaction offers.
      server.setRequestHandler("tasks/update", { params: TaskParams }, async (params, ctx) => {
        await read(await lookup(params.taskId));
        if (Object.keys(ctx.mcpReq.inputResponses ?? record(params.inputResponses) ?? {}).length > 0 || (ctx.mcpReq.droppedInputResponseKeys?.length ?? 0) > 0)
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, "No pending task input requests; use the execution's canonical interaction offers.");
        return { resultType: "complete" };
      });
    },
  };
}

export function tasksForScope(scope: ServerScope) {
  const providers = executionProviders(scope.runtimeModules);
  if (!providers.size || !scope.modulePlatform || !scope.session.tenantId || !scope.session.userId) return undefined;
  const authorityHash = taskAuthorityHash(scope.session);
  if (!authorityHash) return undefined;
  return createTasks({ store: createTaskStore(scope.db, scope.session, authorityHash), providers,
    onUnavailable: code => console.warn(JSON.stringify({ event: "mcp.task_tracking_unavailable", code })),
    context: { locale: scope.locale.tag, execute: request => scope.modulePlatform!.services.operations.execute(scope.moduleSession, request) } });
}
