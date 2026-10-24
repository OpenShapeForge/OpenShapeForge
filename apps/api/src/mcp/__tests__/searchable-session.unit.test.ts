// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import accountsRuntime from "../../accounts/runtime.js";
import documentsRuntime from "@openshapeforge/documents/runtime";
import versioningRuntime from "@openshapeforge/versioning/runtime";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";
import { coreOwnsStaticToolName } from "../session-projection.js";
import { catalog } from "../catalog.js";
import { getEntityOperationContracts } from "../../operations/entity/index.js";

const tenant = "11111111-1111-4111-8111-111111111111";
/** How often a provider was asked for its Operations since the last reset. */
let providerListings = 0;
function providerDefinition(index: number): RuntimeOperationDefinition {
  return {
    id: `example.service.${String(index).padStart(4, "0")}`, intent: "invoke",
    key: `example_service_${index}`, name: `Example service ${index}`, description: "Organization-authored API service.",
    input: { kind: "json-schema", schema: { type: "object", properties: { value: { type: "string" } } } },
    output: { kind: "json-schema", schema: { type: "object" } },
    effects: { data: "read", external: "read" }, reliability: { idempotency: { mode: "natural" } },
  };
}
async function fixture(count: number, roles: string[], run: (client: Client) => Promise<void>, tenantId = tenant, secure = false) {
  const db = {} as never;
  const platform = new ModulePlatformRuntime(db);
  const definitions = Array.from({ length: count }, (_, index) => providerDefinition(index));
  if (secure) definitions[0] = { ...definitions[0]!, interaction: { secureInput: { type: "secureInput", sourceEntity: "Adapter", sourceField: "adapterId", definitionsField: "fields", into: "configurationValues" } } } as RuntimeOperationDefinition;
  const visible = (session: { tenantId?: string | null; roles: readonly string[] }) => session.tenantId === tenant && session.roles.includes("Organization.All.ReadWrite");
  platform.registerOperationProviders([{ name: "example", operationProviders: [{
    id: "example.services",
    list: async (session) => { providerListings += 1; return visible(session) ? definitions : []; },
    get: async (session, id) => visible(session) ? definitions.find((definition) => definition.id === id) : undefined,
    execute: async (context, request) => ({ data: { tenantId: context.session.tenantId, value: request.input?.value }, operations: [] }),
  }] }]);
  const server = __buildGeneratedMcpServerForTests({ db, modulePlatform: platform,
    session: { tenantId, userId: "22222222-2222-4222-8222-222222222222", roles, groups: [], scope: "self", credential: "trusted-context" } as never,
    modules: [accountsRuntime, documentsRuntime as never, versioningRuntime as never, { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }) } }],
    operationToolProjection: { mode: "searchable", search: "osf_search_operations", execute: "osf_execute_operation" },
  });
  const client = new Client({ name: "service-management", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
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
      expect((await client.listTools()).tools.find((tool) => tool.name === "osf_execute_operation")?._meta?.ui).toBeUndefined();
      expect(baseline).not.toContain("osf_execute_operation_secure");
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
  test("a search or an execution enumerates the providers once for its catalog", async () => {
    // Resolving the called tool name lists the session's tools, providers
    // included, for every tool call; that is one enumeration. The search or
    // execution itself takes one snapshot of the Operations and their
    // provider ids, never a second provider listing beside it.
    await fixture(3, ["Organization.All.ReadWrite"], async (client) => {
      providerListings = 0;
      const page = data(await client.callTool({ name: "osf_search_operations", arguments: { query: "example.service.", limit: 2 } }));
      expect(page.operations).toHaveLength(2);
      expect(providerListings).toBe(2);
      providerListings = 0;
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: providerDefinition(2).id, input: { value: "x" } } });
      expect(result.isError).toBeFalsy();
      expect(providerListings).toBe(2);
    });
  });
  test("entity CRUD is discoverable with its exact schema and uses the existing MCP validator", async () => {
    const operation = getEntityOperationContracts().find((candidate) => candidate.intent === "get" && catalog.tools.some((tool) => tool.operationId === candidate.id))!;
    expect(operation).toBeDefined();
    await fixture(0, [...operation.authorization.roles], async (client) => {
      const page = data(await client.callTool({ name: "osf_search_operations", arguments: { operationId: operation.id } }));
      // The lookup answers that Operation alone, with the schema the executor validates.
      expect(page.operations.map((candidate) => candidate.operation.id)).toEqual([operation.id]);
      expect(page.operations[0]!.inputSchema).toMatchObject({ type: "object" });
      expect((await client.listTools()).tools.some((tool) => tool.name === "osf_execute_operation_secure")).toBe(false);
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: operation.id, input: { id: "invalid-uuid" } } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result.structuredContent)).not.toContain("NOT_FOUND");
      expect(JSON.stringify(result.structuredContent)).toMatch(/VALIDATION|BAD_USER_INPUT/);
    });
  });
  test("a dedicated generated tool name answers its canonical Operation's contract", async () => {
    const tool = catalog.tools.find((candidate) => !candidate.name.startsWith("osf_") &&
      catalog.tools.filter((other) => other.name === candidate.name).length === 1 &&
      getEntityOperationContracts().some((contract) => contract.id === candidate.operationId))!;
    expect(tool).toBeDefined();
    const contract = getEntityOperationContracts().find((candidate) => candidate.id === tool.operationId)!;
    await fixture(0, [...contract.authorization.roles], async (client) => {
      const page = data(await client.callTool({ name: "osf_search_operations", arguments: { operationId: tool.name } }));
      expect(page.operations.map((candidate) => candidate.operation.id)).toEqual([tool.operationId]);
      expect(page.operations[0]!.inputSchema).toMatchObject({ type: "object" });
    });
    await fixture(0, [], async (client) => {
      expect(data(await client.callTool({ name: "osf_search_operations", arguments: { operationId: tool.name } })).operations).toEqual([]);
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

  test("only the secure route advertises an app and rejects ordinary Operations before execution", async () => {
    const previous = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
    process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://api.example.test";
    try {
      await fixture(2, ["Organization.All.ReadWrite"], async (client) => {
        const tools = (await client.listTools()).tools;
        expect(tools.find((tool) => tool.name === "osf_execute_operation")?._meta?.ui).toBeUndefined();
        const secureTool = tools.find((tool) => tool.name === "osf_execute_operation_secure");
        expect(secureTool?._meta?.ui).toEqual({ resourceUri: "ui://openshapeforge/configuration" });
        expect(secureTool!.inputSchema.properties?.operationId).toMatchObject({ type: "string", minLength: 1 });
        const invoke = (name: string, index: number) => client.callTool({ name, arguments: { operationId: providerDefinition(index).id, input: { value: "ordinary input" } } });
        expect((await invoke("osf_execute_operation", 0)).structuredContent).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
        expect((await invoke(secureTool!.name, 1)).structuredContent).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
        expect((await invoke(secureTool!.name, 0)).structuredContent).toMatchObject({ data: { value: "ordinary input" } });
        expect((await invoke("osf_execute_operation", 1)).structuredContent).toMatchObject({ data: { value: "ordinary input" } });
      }, tenant, true);
    } finally {
      if (previous === undefined) delete process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
      else process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = previous;
    }
  });

  test("the secure executor name is reserved against plugin and derived tools", () => {
    expect(coreOwnsStaticToolName("osf_execute_operation_secure", { mode: "searchable", search: "osf_search_operations", execute: "osf_execute_operation" })).toBe(true);
    expect(coreOwnsStaticToolName("custom_execute_secure", { mode: "searchable", search: "custom_search", execute: "custom_execute" })).toBe(true);
  });

  test("secure route is not offered outside its role and tenant", async () => {
    for (const [roles, tenantId] of [[[], tenant], [["Organization.All.ReadWrite"], "33333333-3333-4333-8333-333333333333"]] as const) {
      await fixture(1, [...roles], async (client) => {
        expect((await client.listTools()).tools.some((tool) => tool.name === "osf_execute_operation_secure")).toBe(false);
        const result = await client.callTool({ name: "osf_execute_operation_secure", arguments: { operationId: providerDefinition(0).id, input: {} } });
        expect(result.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
      }, tenantId, true);
    }
  });

  test("ordinary sessions cannot discover or invoke administrator CRUD", async () => {
    const operation = getEntityOperationContracts().find((candidate) => candidate.intent === "create" && catalog.tools.some((tool) => tool.operationId === candidate.id))!;
    await fixture(0, [], async (client) => {
      expect(data(await client.callTool({ name: "osf_search_operations", arguments: { query: operation.id } })).operations).toEqual([]);
      expect(data(await client.callTool({ name: "osf_search_operations", arguments: { operationId: operation.id } })).operations).toEqual([]);
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
