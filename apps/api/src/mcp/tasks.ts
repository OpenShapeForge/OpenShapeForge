// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
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
}) {
  const read = async (row: TaskBinding) => {
    const provider = input.providers.get(row.owner_kind);
    if (!provider) throw unavailable();
    // Every poll asks the canonical owner with CURRENT authority, even for a terminal result.
    const snapshot = await provider.read(input.context, { kind: row.owner_kind, ref: row.owner_ref });
    const base = { taskId: row.id, status: snapshot.status, createdAt: new Date(row.created_at).toISOString(),
      lastUpdatedAt: new Date(Math.max(new Date(row.created_at).getTime(), new Date(snapshot.updatedAt).getTime())).toISOString(), ttlMs: new Date(row.expires_at).getTime() - new Date(row.created_at).getTime(),
      pollIntervalMs: 1000, ...(snapshot.statusMessage ? { statusMessage: snapshot.statusMessage } : {}) };
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
      if (!supportsTasks(meta) || result.isError || !reference || !input.providers.has(reference.kind)) return result;
      try {
        const row = await input.store.retain(reference);
        const state = await read(row);
        // A process already finished during start needs no background task.
        if (state.status === "completed") return state.result!;
        if (state.status === "cancelled") return result;
        return { resultType: "task", ...state };
      } catch {
        // The canonical start has already committed. Never report it as a failed
        // start, which could invite a duplicate; the ordinary envelope is durable.
        return { ...result, content: [...result.content, { type: "text" as const,
          text: "The execution was accepted, but background tracking is unavailable. Follow the returned execution reference using its existing operations." }] };
      }
    },
    register(server: Server) {
      server.setRequestHandler("tasks/get", { params: TaskParams }, async params => ({
        resultType: "complete", ...await read(await lookup(params.taskId)),
      }));
      server.setRequestHandler("tasks/cancel", { params: TaskParams }, async params => {
        const row = await lookup(params.taskId);
        await read(row);
        const provider = input.providers.get(row.owner_kind)!;
        if (!provider.cancel) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "This execution does not support cancellation.");
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
  // Self-reported clientInfo is never authority. Bind to verified issuer, actor,
  // credential class and OAuth authorized party, but not a transient MCP session.
  const authorityHash = createHash("sha256").update(JSON.stringify([
    scope.session.issuer ?? null, scope.session.credential, scope.session.oauthClientId ?? null,
    scope.session.appPrincipal ?? null,
  ])).digest("hex");
  return createTasks({ store: createTaskStore(scope.db, scope.session, authorityHash), providers,
    context: { execute: request => scope.modulePlatform!.services.operations.execute(scope.moduleSession, request) } });
}
