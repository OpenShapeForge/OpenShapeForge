// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { projectPrompts, registerPromptHandlers } from "../prompts.js";
import { handleModernMcpRequest } from "../modern-http.js";

const publicPrompt = { name: "work.plan-day", title: "Plan my day", description: "Plan today's work.", text: "Review my tasks and propose a plan." };
const privatePrompt = { name: "sales.prepare-meeting", title: "Prepare a sales meeting", description: "Review accessible customer context.", text: "Prepare a customer meeting brief.", roles: ["Sales.Read"] };
const modules = [{ mcpPrompts: [publicPrompt] }, { mcpPrompts: [privatePrompt] }];

function serverFor(roles: string[]) {
  const server = new Server({ name: "prompt-test", version: "1" }, { capabilities: { prompts: {} } });
  registerPromptHandlers(server, projectPrompts(modules), roles);
  return server;
}

async function withClient(roles: string[], work: (client: Client) => Promise<void>) {
  const server = serverFor(roles);
  const client = new Client({ name: "prompt-reader", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await work(client);
  } finally { await client.close(); await server.close(); }
}

describe("static MCP prompts", () => {
  it("lists product metadata and returns a user message through the protocol", async () => {
    await withClient(["Sales.Read"], async (client) => {
      expect((await client.listPrompts()).prompts).toEqual([
        { name: "work.plan-day", title: "Plan my day", description: "Plan today's work." },
        { name: "sales.prepare-meeting", title: "Prepare a sales meeting", description: "Review accessible customer context." },
      ]);
      expect(await client.getPrompt({ name: "work.plan-day" })).toEqual({
        description: "Plan today's work.",
        messages: [{ role: "user", content: { type: "text", text: "Review my tasks and propose a plan." } }],
      });
    });
  });

  it("withholds restricted prompts from both listing and retrieval", async () => {
    await withClient([], async (client) => {
      expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["work.plan-day"]);
      await expect(client.getPrompt({ name: "sales.prepare-meeting" })).rejects.toThrow("Unknown prompt");
      await expect(client.getPrompt({ name: "unknown" })).rejects.toThrow("Unknown prompt");
    });
  });

  it("rejects arguments and stale cursors rather than silently ignoring input", async () => {
    await withClient([], async (client) => {
      await expect(client.getPrompt({ name: "work.plan-day", arguments: { date: "tomorrow" } })).rejects.toThrow("does not accept arguments");
      await expect(client.listPrompts({ cursor: "stale" })).rejects.toThrow("Unknown prompt cursor");
    });
  });

  it("rechecks role visibility on retrieval and listing in an existing session", async () => {
    const roles = ["Sales.Read"];
    await withClient(roles, async (client) => {
      expect((await client.listPrompts()).prompts).toHaveLength(2);
      roles.length = 0;
      expect((await client.listPrompts()).prompts).toHaveLength(1);
      await expect(client.getPrompt({ name: "sales.prepare-meeting" })).rejects.toThrow("Unknown prompt");
      roles.push("Sales.Read");
      expect((await client.getPrompt({ name: "sales.prepare-meeting" })).messages).toHaveLength(1);
    });
  });

  it("keeps hosts without contributions empty and rejects direct retrieval", async () => {
    const server = new Server({ name: "empty", version: "1" }, { capabilities: { prompts: {} } });
    registerPromptHandlers(server, projectPrompts([]), []);
    const client = new Client({ name: "empty-reader", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b); await client.connect(a);
      expect((await client.listPrompts()).prompts).toEqual([]);
      await expect(client.getPrompt({ name: "work.plan-day" })).rejects.toThrow("Unknown prompt");
    } finally { await client.close(); await server.close(); }
  });

  it("rejects conflicting ownership even when one contribution is hidden", () => {
    expect(() => projectPrompts([...modules, { mcpPrompts: [{ ...publicPrompt, roles: [] }] }])).toThrow("Duplicate MCP prompt");
    expect(() => projectPrompts([{ mcpPrompts: [{ ...publicPrompt, text: " " }] }])).toThrow("require");
    expect(() => projectPrompts([{ mcpPrompts: [{ ...publicPrompt, name: "../bad" }] }])).toThrow("require");
  });

  it("serves list/get over HTTP for both MCP protocol generations", async () => {
    const app = Fastify();
    app.all("/mcp", async (request, reply) => {
      const build = () => serverFor([]);
      if (await handleModernMcpRequest(request, reply, build)) return;
      const server = build();
      const transport = new NodeStreamableHTTPServerTransport({ enableJsonResponse: true });
      reply.raw.on("close", () => { void server.close(); void transport.close(); });
      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      for (const modern of [true, false]) {
        const client = new Client({ name: "prompt-http", version: "1" }, modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
          expect((await client.listPrompts()).prompts).toHaveLength(1);
          expect((await client.getPrompt({ name: "work.plan-day" })).messages[0]).toMatchObject({ role: "user", content: { text: publicPrompt.text } });
          await expect(client.getPrompt({ name: "sales.prepare-meeting" })).rejects.toThrow("Unknown prompt");
        } finally { await client.close(); }
      }
    } finally { await app.close(); }
  });
});
