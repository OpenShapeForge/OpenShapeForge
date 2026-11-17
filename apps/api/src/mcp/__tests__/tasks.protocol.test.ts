// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Server } from "@modelcontextprotocol/server";
import { handleModernMcpRequest } from "../modern-http.js";
import { completeToolResult, createTasks, executionProviders, supportsTasks, taskAwareToolParams, TASKS_EXTENSION } from "../tasks.js";
import { withExecutionReference } from "../execution-reference.js";
import type { TaskBinding, TaskStore } from "../task-store.js";
import type { RuntimeExecutionProvider } from "@openshapeforge/plugin-runtime";

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "tasks-protocol-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION]: {} } } };
const rows = new Map<string, TaskBinding>();
const store: TaskStore = {
  async retain(reference) {
    const prior = [...rows.values()].find(row => row.owner_kind === reference.kind && row.owner_ref === reference.ref);
    if (prior) return prior;
    const row = { id: randomUUID(), owner_kind: reference.kind, owner_ref: reference.ref,
      created_at: new Date(), expires_at: new Date(Date.now() + 60000) };
    rows.set(row.id, row); return row;
  },
  async get(id) { return rows.get(id); },
};
let done = false, denied = false, reads = 0, cancels = 0;
const provider: RuntimeExecutionProvider = {
  kind: "example-job",
  async read() {
    reads++;
    if (denied) throw new Error("Current access refused");
    return { status: done ? "completed" : "working", updatedAt: new Date().toISOString(),
      result: { data: { answer: done ? 42 : null }, operations: [] } };
  },
  async cancel() { cancels++; },
};
const app = Fastify(); let address = "";
beforeAll(async () => {
  app.post("/mcp", async (req, reply) => {
    await handleModernMcpRequest(req, reply, () => {
      const server = new Server({ name: "tasks-test", version: "1" }, { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } } });
      const tasks = createTasks({ store, providers: executionProviders([{ executionProviders: [provider] }]), context: { execute: async () => { throw new Error("unused"); } } });
      tasks.register(server);
      server.setRequestHandler("tools/call", { params: taskAwareToolParams }, async (params, ctx) => {
        const result = { content: [{ type: "text" as const, text: "accepted" }] };
        if (params.name === "start") withExecutionReference(result, { kind: "example-job", ref: String(params.arguments?.ref ?? "run-1") });
        if (params.name === "native") Object.assign(result, { structuredContent: { execution: { kind: "example-job", ref: "forged" } } });
        return tasks.project(result, ctx.mcpReq.envelope);
      });
      return server;
    });
  });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => { await app.close(); });
async function call(method: string, params: Record<string, unknown>, capabilities: object = meta) {
  const response = await fetch(`${address}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : typeof params.taskId === "string" ? { "Mcp-Name": params.taskId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { ...params, _meta: capabilities } }) });
  return await response.json() as { result?: Record<string, any>; error?: { code: number; message: string } };
}

function expectEmptyAck(response: {error?:unknown;result?:Record<string,unknown>}){
  expect(response.error).toBeUndefined();
  const {_meta,...ack}=response.result??{};
  expect(ack).toEqual({resultType:'complete'});
}

describe("MCP Tasks extension over actual HTTP", () => {
  test("returns a handle, serves another call, polls through new Server instances and returns the final original envelope", async () => {
    const first = await call("tools/call", { name: "start", arguments: { ref: "run-a" } });
    expect(first.error).toBeUndefined(); expect(first.result).toMatchObject({ resultType: "task", status: "working" });
    const id = first.result!.taskId;
    expect((await call("tools/call", { name: "fast" })).result!.content[0].text).toBe("accepted");
    expect((await call("tasks/get", { taskId: id })).result).toMatchObject({ status: "working" });
    const retry = await call("tools/call", { name: "start", arguments: { ref: "run-a" } });
    expect(retry.result!.taskId).toBe(id);
    done = true;
    const final = await call("tasks/get", { taskId: id });
    expect(final.result).toMatchObject({ resultType: "complete", status: "completed", result: { structuredContent: { data: { answer: 42 } } } });
    expectEmptyAck(await call("tasks/cancel", {taskId:id})); expect(cancels).toBe(0);
    const before = reads; denied = true;
    expect((await call("tasks/get", { taskId: id })).error).toBeDefined();
    expect(reads).toBe(before + 1); denied = false; done = false;
  });
  test("requires Tasks on the tool request itself and never trusts upstream execution-shaped JSON", async () => {
    const plainMeta = { ...meta, "io.modelcontextprotocol/clientCapabilities": {} };
    expect((await call("tools/call", { name: "start" }, plainMeta)).result!.content).toBeDefined();
    expect((await call("tools/call", { name: "native" })).result!.resultType).toBe("complete");
    expect((await call("tools/call", { name: "start" }, plainMeta)).result!.resultType).toBe("complete");
    expect(completeToolResult({ content: [] }, { ...meta, "io.modelcontextprotocol/protocolVersion": "2025-11-25" })).toEqual({ content: [] });
    expect(completeToolResult({ content: [] }, { ...meta, "io.modelcontextprotocol/protocolVersion": "2027-01-15" })).toEqual({ resultType: "complete", content: [] });
    expect(completeToolResult({ resultType: "task", content: [] }, meta)).toEqual({ resultType: "task", content: [] });
    expect(supportsTasks({ ...meta, "io.modelcontextprotocol/protocolVersion": "2025-11-25" })).toBe(false);
  });
  test("cancels through the owner, refuses unknown handles and unissued input", async () => {
    const first = await call("tools/call", { name: "start", arguments: { ref: "run-cancel" } });
    const id = first.result!.taskId;
    expectEmptyAck(await call("tasks/cancel", {taskId:id})); expect(cancels).toBe(1);
    expect((await call("tasks/get", { taskId: randomUUID() })).error!.code).toBe(-32602);
    expect((await call("tasks/get", { taskId: "not-a-uuid" })).error).toBeDefined();
    expect((await call("tasks/update", { taskId: id, inputResponses: { forged: { approved: true } } })).error).toBeDefined();
    expectEmptyAck(await call("tasks/update", {taskId:id}));
  });
  test("rejects ambiguous owner registration", () => {
    expect(() => executionProviders([{ executionProviders: [provider, provider] }])).toThrow("Duplicate");
  });
});
