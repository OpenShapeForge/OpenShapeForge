// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import Fastify from "fastify";
import { Server, type Tool } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { searchableOperationToolDefinitions } from "@openshapeforge/operations";
import { toolWithFailureOutputSchema } from "../tool-output-schema.js";

test("strict legacy client accepts a workflow execution from the advertised generic executor over HTTP", async () => {
  const tool = toolWithFailureOutputSchema(searchableOperationToolDefinitions({ search: "search", execute: "execute" })[1]! as Tool);
  const envelope = { data: { status: "waiting" }, operations: [], execution: { kind: "workflow", ref: "example-run" } };
  const app = Fastify();
  app.post("/mcp", async (request, reply) => {
    const server = new Server({ name: "execution-schema-test", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: [tool] }));
    server.setRequestHandler("tools/call", async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(envelope) }], structuredContent: envelope,
    }));
    const transport = new NodeStreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.raw.on("close", () => { void server.close(); void transport.close(); });
    reply.hijack(); await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "strict-execution-output", version: "1" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`));
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    await client.listTools();
    expect((await client.callTool({ name: "execute", arguments: { operationId: "example.start", input: {} } })).structuredContent).toEqual(envelope);
  } finally { await client.close(); await app.close(); }
});
