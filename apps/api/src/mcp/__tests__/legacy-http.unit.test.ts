// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Server } from "@modelcontextprotocol/server";
import { FastifyStreamableHTTPServerTransport } from "../legacy-http.js";

test("the legacy Fastify adapter handles parsed bodies, keeps sessions and rejects an unknown session", async () => {
  const app = Fastify();
  const server = new Server({ name: "transport-fixture", version: "1" }, { capabilities: { tools: {} } });
  const transport = new FastifyStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  await server.connect(transport);
  app.post("/mcp", async (request, reply) => {
    reply.hijack();
    await transport.handleNodeRequest(request.raw, reply.raw, request.body);
  });
  const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  try {
    const initialized = await app.inject({ method: "POST", url: "/mcp", headers, payload: {
      jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "legacy-fixture", version: "1" },
      },
    } });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json().result.protocolVersion).toBe("2025-03-26");
    const session = initialized.headers["mcp-session-id"];
    expect(typeof session).toBe("string");
    const listed = await app.inject({ method: "POST", url: "/mcp",
      headers: { ...headers, "mcp-session-id": session!, "mcp-protocol-version": "2025-03-26" },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().result.tools).toEqual([]);
    const refused = await app.inject({ method: "POST", url: "/mcp",
      headers: { ...headers, "mcp-session-id": randomUUID(), "mcp-protocol-version": "2025-03-26" },
      payload: { jsonrpc: "2.0", id: 3, method: "tools/list" },
    });
    expect(refused.statusCode).toBe(404);
    // Hono's extra drain used to fail asynchronously after a parsed inject body.
    await new Promise((resolve) => setTimeout(resolve, 600));
  } finally { await app.close(); await transport.close(); await server.close(); }
});
