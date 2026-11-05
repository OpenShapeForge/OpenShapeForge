// SPDX-License-Identifier: BUSL-1.1
/**
 * The core half of an external MCP gateway: a session-scoped provider offers
 * discovered tools as themselves, through canonical execution. The provider
 * here is a synthetic fixture and no upstream exists; this proves the contract,
 * not an integration.
 */
import { emptyCatalogDatabase } from "../../db/__tests__/empty-catalog-db.js";
import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  RUNTIME_NATIVE_MCP_EFFECTS,
  RUNTIME_NATIVE_MCP_OUTPUT,
  type RuntimeOperationDefinition,
  type RuntimeOperationProvider,
} from "@openshapeforge/plugin-runtime";
import accountsRuntime from "../../accounts/runtime.js";
import documentsRuntime from "@openshapeforge/documents/runtime";
import versioningRuntime from "@openshapeforge/versioning/runtime";
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { ambientConnectionControls, assertConnectionControls } from "../connection-expectation.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const relation = "55555555-5555-4555-8555-555555555555";
const connectionId = "33333333-3333-4333-8333-333333333333";
const otherConnectionId = "44444444-4444-4444-8444-444444444444";
const person = {
  tenantId: tenant, userId: "22222222-2222-4222-8222-222222222222", relationId: relation,
  roles: ["Organization.All.ReadWrite"], groups: [], scope: "self", credential: "trusted-context",
};
const searchable = { mode: "searchable", search: "osf_search_operations", execute: "osf_execute_operation" } as const;
const inputSchema = { type: "object", properties: { key: { type: "string" } }, required: ["key"] };
const outputSchema = { type: "object", properties: { issue: { type: "string" } } };

function nativeTool(name: string, change: Partial<RuntimeOperationDefinition> = {}): RuntimeOperationDefinition {
  return {
    id: `external.${name}`, intent: "invoke", name, description: `${name} as upstream describes it.`,
    input: { kind: "json-schema", schema: inputSchema }, output: RUNTIME_NATIVE_MCP_OUTPUT,
    effects: RUNTIME_NATIVE_MCP_EFFECTS, reliability: { idempotency: { mode: "none" } },
    nativeMcpTool: {
      name, connectionId, title: "Upstream title", outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      meta: { "vendor/hint": 1, ui: { resourceUri: "ui://openshapeforge/configuration" } },
    },
    ...change,
  };
}

type Execute = RuntimeOperationProvider["execute"];

function provider(id: string, definitions: readonly RuntimeOperationDefinition[], execute: Execute): RuntimeOperationProvider {
  return {
    id,
    list: async () => definitions,
    get: async (_session, operationId) => definitions.find((definition) => definition.id === operationId),
    execute,
  };
}

const answers = (data: unknown): Execute => async () => ({ data, operations: [] });
// The fixture's tool declares an output schema, so a success carries a value for it.
const answered = { content: [{ type: "text" as const, text: "ok" }], structuredContent: { issue: "A-1" } };
const unreachable: Execute = async () => { throw new Error("The provider must not be reached."); };

async function session(
  input: {
    providers: readonly RuntimeOperationProvider[];
    identity?: Record<string, unknown>;
    modules?: readonly RuntimeModule[];
    dedicated?: boolean;
  },
  run: (client: Client) => Promise<void>,
) {
  const db = emptyCatalogDatabase();
  const platform = new ModulePlatformRuntime(db);
  platform.registerOperationProviders([{ name: "external", operationProviders: [...input.providers] }]);
  const server = __buildGeneratedMcpServerForTests({
    db, modulePlatform: platform, session: (input.identity ?? person) as never,
    modules: [accountsRuntime, documentsRuntime as never, versioningRuntime as never, { name: "notebook", operationHandlers: {
      importNotebook: async () => ({ value: undefined }),
      deliverToNotebook: () => { throw new Error("This test does not exercise Notebook.deliver."); },
    } }, ...(input.modules ?? [])],
    operationToolProjection: input.dedicated ? { ...searchable, mode: "dedicated" } : searchable,
  });
  const client = new Client({ name: "native-tools", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try { await server.connect(serverTransport); await client.connect(clientTransport); await run(client); }
  finally { platform.unregisterServer(server); await client.close(); await server.close(); }
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name);

describe("a discovered tool is offered as itself", () => {
  for (const dedicated of [false, true]) {
    test(`in the ${dedicated ? "dedicated" : "searchable"} projection`, async () => {
      await session({ providers: [provider("external.tools", [nativeTool("getJiraIssue")], unreachable)], dedicated }, async (client) => {
        const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "getJiraIssue");
        expect(tool).toBeDefined();
        expect(tool!.title).toBe("Upstream title");
        expect(tool!.description).toBe("getJiraIssue as upstream describes it.");
        expect(tool!.inputSchema).toEqual(inputSchema as never);
        // Upstream's hints, unchanged: not derived from core's conservative effects.
        expect(tool!.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
        expect((tool!.outputSchema as unknown as { anyOf: unknown[] }).anyOf[0]).toMatchObject(outputSchema);
        // Nothing upstream may point at one of this server's own apps.
        expect(tool!._meta).toEqual({ "vendor/hint": 1 });
      });
    });
  }

  test("a new tool needs no approval: the next listing has it", async () => {
    const definitions = [nativeTool("first")];
    const source: RuntimeOperationProvider = { ...provider("external.tools", [], answers(answered)),
      list: async () => definitions,
      get: async (_session, id) => definitions.find((definition) => definition.id === id) };
    await session({ providers: [source] }, async (client) => {
      expect(await toolNames(client)).not.toContain("second");
      definitions.push(nativeTool("second"));
      expect(await toolNames(client)).toContain("second");
      expect((await client.callTool({ name: "second", arguments: {} })).isError).toBeFalsy();
    });
  });

  test("the session decides who sees it, and a call re-reads that", async () => {
    const owned = nativeTool("personalTool");
    const mine = (identity: { userId?: unknown }) => identity.userId === person.userId;
    const source: RuntimeOperationProvider = {
      id: "external.tools",
      list: async (identity) => mine(identity) ? [owned] : [],
      get: async (identity, id) => mine(identity) && id === owned.id ? owned : undefined,
      execute: unreachable,
    };
    const colleague = { ...person, userId: "66666666-6666-4666-8666-666666666666", relationId: "77777777-7777-4777-8777-777777777777" };
    await session({ providers: [source], identity: colleague }, async (client) => {
      expect(await toolNames(client)).not.toContain("personalTool");
      const denied = await client.callTool({ name: "personalTool", arguments: {} });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
      const generic = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: owned.id, input: {} } });
      expect(generic.isError).toBe(true);
    });
  });
});

describe("a native call answers the upstream result", () => {
  const result = {
    content: [{ type: "text" as const, text: "A-1" }, { type: "image" as const, data: "AAAA", mimeType: "image/png" }],
    structuredContent: { issue: "A-1" },
    _meta: { "upstream/trace": "t-1", configurationUrl: "https://upstream.example/form/token" },
  };

  test("content, structured content and metadata arrive unchanged", async () => {
    let received: unknown;
    const execute: Execute = async (_context, request) => { received = request.input; return { data: result, operations: [] }; };
    await session({ providers: [provider("external.tools", [nativeTool("getJiraIssue")], execute)] }, async (client) => {
      const answer = await client.callTool({ name: "getJiraIssue", arguments: { key: "A-1" } });
      expect(received).toEqual({ key: "A-1" });
      expect(answer.isError).toBeFalsy();
      expect(answer.content).toEqual(result.content);
      expect(answer.structuredContent).toEqual(result.structuredContent);
      expect(answer._meta).toEqual(result._meta);
    });
  });

  test("an upstream isError stays a tool error with its own content", async () => {
    const failure = { content: [{ type: "text" as const, text: "No such issue." }], isError: true };
    await session({ providers: [provider("external.tools", [nativeTool("getJiraIssue")], answers(failure))] }, async (client) => {
      const answer = await client.callTool({ name: "getJiraIssue", arguments: { key: "A-2" } });
      expect(answer.isError).toBe(true);
      expect(answer.content).toEqual(failure.content);
      expect(answer.structuredContent).toBeUndefined();
    });
  });

  test("the generic executor keeps the whole result and its error", async () => {
    const failure = { content: [{ type: "text" as const, text: "No such issue." }], isError: true };
    const definition = nativeTool("getJiraIssue");
    await session({ providers: [provider("external.tools", [definition], answers(failure))] }, async (client) => {
      const answer = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: definition.id, input: { key: "A-2" } } });
      expect(answer.isError).toBe(true);
      expect(answer.structuredContent).toMatchObject({ data: failure, operations: [] });
    });
  });

  test("an unreadable answer is a failure nobody may retry blindly", async () => {
    await session({ providers: [provider("external.tools", [nativeTool("getJiraIssue")], answers({ issue: "A-1" }))] }, async (client) => {
      const answer = await client.callTool({ name: "getJiraIssue", arguments: { key: "A-1" } });
      expect(answer.isError).toBe(true);
      expect(answer.structuredContent).toMatchObject({ error: { code: "NATIVE_TOOL_RESULT_INVALID", retryable: false } });
    });
  });
});

describe("a native call stays a canonical execution", () => {
  test("its credentials are bound to the tool's Connection", async () => {
    const boundary = (id: string, context: Parameters<Execute>[0]) => {
      try {
        assertConnectionControls({
          controls: ambientConnectionControls(),
          session: context.session as never,
          connectionTable: "integration.connections",
          connection: { id, ownerUserId: relation },
        });
        return "opened";
      } catch { return "refused"; }
    };
    let outcomes: string[] = [];
    const execute: Execute = async (context) => {
      outcomes = [boundary(connectionId, context), boundary(otherConnectionId, context)];
      return { data: answered, operations: [] };
    };
    await session({ providers: [provider("external.tools", [nativeTool("getJiraIssue")], execute)] }, async (client) => {
      expect((await client.callTool({ name: "getJiraIssue", arguments: {} })).isError).toBeFalsy();
      expect(outcomes).toEqual(["opened", "refused"]);
    });
  });

  test("a module interceptor sees the call as an Operation and can stop it", async () => {
    const seen: string[] = [];
    const policy: RuntimeModule = { name: "policy", mcp: { interceptToolCall: async (call, next) => {
      if (call.name !== "getJiraIssue") return next();
      seen.push(call.source);
      throw new Error("Refused by policy.");
    } } };
    await session({ providers: [provider("external.tools", [nativeTool("getJiraIssue")], unreachable)], modules: [policy] }, async (client) => {
      expect((await client.callTool({ name: "getJiraIssue", arguments: {} })).isError).toBe(true);
      expect(seen).toEqual(["operation"]);
    });
  });
});

describe("a broken source costs only its own tools", () => {
  const healthy = () => provider("external.healthy", [nativeTool("healthyTool")], answers(answered));

  test("an ordinary provider still propagates its failure", async () => {
    const broken: RuntimeOperationProvider = {
      id: "ordinary.broken",
      list: async () => { throw new Error("ordinary provider failed"); },
      get: async () => undefined,
      execute: unreachable,
    };
    await session({ providers: [broken] }, async (client) => {
      await expect(client.listTools()).rejects.toThrow();
    });
  });

  test("a failing provider leaves the session and its other tools working", async () => {
    const broken: RuntimeOperationProvider = {
      id: "external.broken", failureIsolation: "external-catalog",
      list: async () => { throw new Error("snapshot store unavailable"); },
      get: async () => { throw new Error("snapshot store unavailable"); },
      execute: unreachable,
    };
    let baseline: string[] = [];
    await session({ providers: [] }, async (client) => { baseline = await toolNames(client); });
    await session({ providers: [broken, healthy()] }, async (client) => {
      expect((await toolNames(client)).filter((name) => name !== "healthyTool")).toEqual(baseline);
      expect((await client.callTool({ name: "healthyTool", arguments: {} })).isError).toBeFalsy();
    });
  });

  test("a stalled provider is left out once its read times out", async () => {
    const stalled: RuntimeOperationProvider = {
      id: "external.stalled", failureIsolation: "external-catalog",
      list: () => new Promise(() => undefined),
      get: async () => undefined,
      execute: unreachable,
    };
    await session({ providers: [stalled, healthy()] }, async (client) => {
      expect(await toolNames(client)).toContain("healthyTool");
    });
  }, 15_000);

  test("a bad definition is refused alone, and core effects cannot be overclaimed", async () => {
    const bad = [
      nativeTool("readOnlyClaim", { effects: { data: "read", external: "read" } }),
      nativeTool("idempotencyClaim", { reliability: { idempotency: { mode: "natural" } } }),
      nativeTool("secureInputClaim", { interaction: {} }),
      nativeTool("noConnection", { nativeMcpTool: { name: "noConnection", connectionId: "personal" } }),
      nativeTool("dotted", { nativeMcpTool: { name: "module.tool", connectionId } }),
    ];
    await session({ providers: [provider("external.tools", [...bad, nativeTool("goodTool")], unreachable)] }, async (client) => {
      const names = await toolNames(client);
      expect(names).toContain("goodTool");
      for (const definition of bad) expect(names).not.toContain(definition.nativeMcpTool!.name);
      const denied = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: bad[0]!.id, input: {} } });
      expect(denied.isError).toBe(true);
    });
  });

  test("a colliding name never shadows core and never picks between accounts", async () => {
    const definitions = [
      nativeTool("whoami"),
      nativeTool("osf_search_operations"),
      nativeTool("first", { nativeMcpTool: { name: "sharedName", connectionId } }),
      nativeTool("second", { nativeMcpTool: { name: "sharedName", connectionId: otherConnectionId } }),
      nativeTool("goodTool"),
    ];
    await session({ providers: [provider("external.tools", definitions, unreachable)] }, async (client) => {
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("goodTool");
      expect(names).not.toContain("sharedName");
      expect(names.filter((name) => name === "whoami")).toHaveLength(1);
      expect(tools.find((tool) => tool.name === "whoami")?.title).not.toBe("Upstream title");
      expect(names.filter((name) => name === "osf_search_operations")).toHaveLength(1);
      expect((await client.callTool({ name: "sharedName", arguments: {} })).isError).toBe(true);
    });
  });
});
