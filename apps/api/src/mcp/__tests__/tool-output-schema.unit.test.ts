// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { editLeaseToolsForOperationIds } from "../edit-lease-tools.js";
import accountsRuntime from "../../accounts/runtime.js";
import documentsRuntime from "@openshapeforge/documents/runtime";
import versioningRuntime from "@openshapeforge/versioning/runtime";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";
import { handleModernMcpRequest } from "../modern-http.js";
import { toolWithFailureOutputSchema } from "../tool-output-schema.js";
import type { Tool } from "@modelcontextprotocol/server";

function legacySchema(schema: NonNullable<Tool["outputSchema"]>) {
  const { $schema, ...rest } = schema;
  return { ...rest, ...(typeof $schema === "string" ? { $schema } : {}) };
}

const session = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", roles: ["Organization.All.ReadWrite"], groups: [], scope: "self", credential: "trusted-context" } as never;
function build() {
  const db = {} as never;
  const platform = new ModulePlatformRuntime(db);
  const server = __buildGeneratedMcpServerForTests({ db, session, modulePlatform: platform,
    modules: [accountsRuntime, documentsRuntime as never, versioningRuntime as never, { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }) } }],
    operationToolProjection: { mode: "searchable", search: "osf_search_operations", execute: "osf_execute_operation" },
  });
  return { server, platform };
}
const refusal = { name: "osf_execute_operation", arguments: { operationId: "missing.operation", input: {} } };
const search = { name: "osf_search_operations", arguments: { query: "missing.operation" } };

describe("MCP wire output schemas", () => {
  test("strict legacy SDK accepts actual canonical refusal and search success after repeated listing over HTTP", async () => {
    const app = Fastify();
    app.post("/mcp", async (request, reply) => {
      const { server, platform } = build();
      const transport = new NodeStreamableHTTPServerTransport({ enableJsonResponse: true });
      reply.raw.on("close", () => { platform.unregisterServer(server); void server.close(); void transport.close(); });
      reply.hijack(); await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new LegacyClient({ name: "strict-output-regression", version: "1" });
    try {
      // SDK 1.x's own transport exposes optional sessionId as string|undefined.
      const transport = new LegacyTransport(new URL(`${address}/mcp`));
      await client.connect(transport as Parameters<LegacyClient["connect"]>[0]);
      await client.listTools(); await client.listTools();
      const result = await client.callTool(refusal);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "NOT_FOUND", retryable: false } });
      expect((await client.callTool(search)).isError).toBeFalsy();
    } finally { await client.close(); await app.close(); }
  });

  test("modern SDK preserves actual refusal and success over HTTP", async () => {
    const app = Fastify();
    app.all("/mcp", async (request, reply) => {
      if (await handleModernMcpRequest(request, reply, () => build().server)) return;
      throw new Error("Modern protocol fixture expected");
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "modern-output-regression", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)));
      expect(client.getProtocolEra()).toBe("modern");
      await client.listTools(); await client.listTools();
      expect((await client.callTool(refusal)).structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect((await client.callTool(search)).isError).toBeFalsy();
    } finally { await client.close(); await app.close(); }
  });

  test("keeps strict success, local refs, lease $defs and SDK validator refresh", () => {
    const validator = new AjvJsonSchemaValidator();
    const tool = { name: "referenced", inputSchema: { type: "object" }, outputSchema: {
      type: "object", required: ["value"], additionalProperties: false,
      properties: { value: { $ref: "#/$defs/Value" } }, $defs: { Value: { type: "integer" } },
    } } as Tool;
    const projected = toolWithFailureOutputSchema(tool);
    for (let n = 0; n < 2; n++) {
      const check = validator.getValidator(legacySchema(projected.outputSchema!));
      expect(check({ value: 3 }).valid).toBe(true);
      expect(check({ value: "3" }).valid).toBe(false);
      expect(check({ value: 3, extra: true }).valid).toBe(false);
      expect(check({ error: { code: "NOT_FOUND", message: "Absent", retryable: false } }).valid).toBe(true);
      expect(check({ error: { code: "NOT_FOUND", message: "Absent", retryable: "false" } }).valid).toBe(false);
      expect(check({ error: { code: "NOT_FOUND", message: "Absent", retryable: false }, extra: true }).valid).toBe(false);
    }
    expect(tool.outputSchema).not.toHaveProperty("anyOf");
    for (const lease of editLeaseToolsForOperationIds(["Example.update"])) {
      const check = validator.getValidator(legacySchema(toolWithFailureOutputSchema(lease as Tool).outputSchema!));
      expect(check({ error: { code: "FORBIDDEN", message: "Denied", retryable: false } }).valid).toBe(true);
    }
    for (const schema of [
      { type: "object", properties: { value: { type: "integer" }, copy: { $ref: "#/properties/value" } }, required: ["copy"] },
      { $id: "urn:existing:success", type: "object", properties: { value: { $ref: "#/$defs/Value" } }, required: ["value"], $defs: { Value: { type: "integer" } } },
      { type: "object", properties: { value: { type: "integer" }, child: { $ref: "#" } }, required: ["value"] },
      { type: "object", properties: { value: { $id: "urn:embedded:value", type: "integer" }, copy: { $ref: "urn:embedded:value" } }, required: ["copy"] },
    ]) {
      const projected = toolWithFailureOutputSchema({ name: "refs", inputSchema: { type: "object" }, outputSchema: schema } as Tool);
      const check = new AjvJsonSchemaValidator().getValidator(legacySchema(projected.outputSchema!));
      expect(check({ value: 1, copy: 2, child: { value: 3 } }).valid).toBe(true);
      expect(check({ value: "bad", copy: "bad", child: { value: "bad" } }).valid).toBe(false);
    }
    const literal = { type: "object", properties: { value: { const: { $ref: "#/literal", $id: "literal" } } } };
    const literalProjection = toolWithFailureOutputSchema({ name: "literal", inputSchema: { type: "object" }, outputSchema: literal } as Tool);
    expect((literalProjection.outputSchema!.anyOf as unknown[])[0]).toMatchObject(literal);
    const absent = { name: "untyped", inputSchema: { type: "object" } } as Tool;
    expect(toolWithFailureOutputSchema(absent)).toBe(absent);
  });
});
