// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import accountsRuntime from "../../accounts/runtime.js";
import documentsRuntime from "@openshapeforge/documents/runtime";
import versioningRuntime from "@openshapeforge/versioning/runtime";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";
import { catalog } from "../catalog.js";
import { getEntityOperationContracts } from "../../operations/entity/index.js";

const tenant = "11111111-1111-4111-8111-111111111111";
function providerDefinition(index: number): RuntimeOperationDefinition {
  return {
    id: `example.service.${String(index).padStart(4, "0")}`, intent: "invoke",
    key: `example_service_${index}`, name: `Example service ${index}`, description: "Organization-authored API service.",
    input: { kind: "json-schema", schema: { type: "object", properties: { value: { type: "string" } } } },
    output: { kind: "json-schema", schema: { type: "object" } },
    effects: { data: "read", external: "read" }, reliability: { idempotency: { mode: "natural" } },
  };
}
async function fixture(count: number, roles: string[], run: (client: Client) => Promise<void>, tenantId = tenant) {
  const db = {} as never;
  const platform = new ModulePlatformRuntime(db);
  const definitions = Array.from({ length: count }, (_, index) => providerDefinition(index));
  const visible = (session: { tenantId?: string | null; roles: readonly string[] }) => session.tenantId === tenant && session.roles.includes("Organization.All.ReadWrite");
  platform.registerOperationProviders([{ name: "example", operationProviders: [{
    id: "example.services",
    list: async (session) => visible(session) ? definitions : [],
    get: async (session, id) => visible(session) ? definitions.find((definition) => definition.id === id) : undefined,
    execute: async (context, request) => ({ data: { tenantId: context.session.tenantId, value: request.input?.value }, operations: [] }),
  }] }]);
  const server = __buildGeneratedMcpServerForTests({ db, modulePlatform: platform,
    session: { tenantId, userId: "22222222-2222-4222-8222-222222222222", roles, groups: [], scope: "self", credential: "trusted-context" } as never,
    modules: [accountsRuntime, documentsRuntime as never, versioningRuntime as never, { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }) } }],
    operationToolProjection: { mode: "searchable", search: "osf_search_operations", execute: "osf_execute_operation" },
  });
  const client = new Client({ name: "service-management", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try { await server.connect(serverTransport); await client.connect(clientTransport); await run(client); }
  finally { platform.unregisterServer(server); await client.close(); await server.close(); }
}
const data = (result: Awaited<ReturnType<Client["callTool"]>>) => { if(result.isError) throw new Error(JSON.stringify(result.structuredContent)); return result.structuredContent as { operations: { operation: { id: string }; inputSchema: Record<string, unknown> }[]; nextCursor?: string }; };

describe("complete searchable MCP session", () => {
  test("catalog stays fixed with 500 services, every service is discoverable and executable", async () => {
    let baseline: string[] = [];
    await fixture(0, ["Organization.All.ReadWrite"], async (client) => { baseline = (await client.listTools()).tools.map((tool) => tool.name); });
    await fixture(500, ["Organization.All.ReadWrite"], async (client) => {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(baseline);
      expect(baseline).toContain("osf_search_operations"); expect(baseline).toContain("osf_execute_operation");
      const ids: string[] = []; let cursor: string | undefined;
      do {
        const page = data(await client.callTool({ name: "osf_search_operations", arguments: { query: "example.service.", limit: 20, ...(cursor ? { cursor } : {}) } }));
        ids.push(...page.operations.map((operation) => operation.operation.id)); cursor = page.nextCursor;
      } while (cursor);
      expect(ids).toHaveLength(500); expect(new Set(ids).size).toBe(500);
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: ids.at(-1), input: { value: "last service" } } });
      expect(result.isError).toBeFalsy(); expect(result.structuredContent).toMatchObject({ data: { tenantId: tenant, value: "last service" } });
    });
  });
  test("entity CRUD is discoverable with its exact schema and uses the existing MCP validator", async () => {
    const operation = getEntityOperationContracts().find((candidate) => candidate.intent === "get" && catalog.tools.some((tool) => tool.operationId === candidate.id))!;
    expect(operation).toBeDefined();
    await fixture(0, [...operation.authorization.roles], async (client) => {
      const page = data(await client.callTool({ name: "osf_search_operations", arguments: { query: operation.id } }));
      expect(page.operations.map((candidate) => candidate.operation.id)).toContain(operation.id);
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: operation.id, input: { id: "invalid-uuid" } } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result.structuredContent)).not.toContain("NOT_FOUND");
      expect(JSON.stringify(result.structuredContent)).toMatch(/VALIDATION|BAD_USER_INPUT/);
    });
  });
  test("a CRUD Operation is found by its canonical name in another language", async () => {
    const create = getEntityOperationContracts().find((candidate) => candidate.id === "Relation.create")!;
    expect(JSON.stringify(create.name)).toContain("aanmaken");
    await fixture(0, ["Relations.All.ReadWrite"], async (client) => {
      const ids: string[] = []; let cursor: string | undefined;
      do {
        const page = data(await client.callTool({ name: "osf_search_operations", arguments: { query: "aanmaken", limit: 20, ...(cursor ? { cursor } : {}) } }));
        ids.push(...page.operations.map((candidate) => candidate.operation.id)); cursor = page.nextCursor;
      } while (cursor);
      expect(ids).toContain("Relation.create");
    });
  });

  test("ordinary sessions cannot discover or invoke administrator CRUD", async () => {
    const operation = getEntityOperationContracts().find((candidate) => candidate.intent === "create" && catalog.tools.some((tool) => tool.operationId === candidate.id))!;
    await fixture(0, [], async (client) => {
      expect(data(await client.callTool({ name: "osf_search_operations", arguments: { query: operation.id } })).operations).toEqual([]);
      expect((await client.callTool({ name: "osf_execute_operation", arguments: { operationId: operation.id, input: {} } })).structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
    });
  });
  for (const [label, roles, tenantId] of [["role", [], tenant], ["tenant", ["Organization.All.ReadWrite"], "33333333-3333-4333-8333-333333333333"]] as const) {
    test(`denies provider discovery and execution across the ${label} boundary`, async () => {
      await fixture(500, [...roles], async (client) => {
        expect(data(await client.callTool({ name: "osf_search_operations", arguments: { query: "example.service." } })).operations).toEqual([]);
        const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: providerDefinition(499).id, input: {} } });
        expect(result.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
      }, tenantId);
    });
  }
});
