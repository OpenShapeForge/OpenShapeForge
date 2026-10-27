// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import Fastify from "fastify";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import accounts from "../../accounts/runtime.js";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests, buildServer } from "../generated-mcp-server.js";
import { createTransportSessions, requestNeedsInstructions } from "../transport-sessions.js";
import { createDerivedDefinitionResolution } from "../derived-definitions.js";
import { catalogDerivedTools } from "../catalog.js";
import { moduleTools } from "../../modules/mcp-hooks.js";

function fixture(name = "reports.summary") {
  const db = {} as never;
  const platform = new ModulePlatformRuntime(db);
  const session = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
    roles: ["Organization.All.ReadWrite"], groups: [], scope: "self" as const, credential: "trusted-context" as const };
  const allowedTenant = session.tenantId;
  let visible = true, providerListings = 0, calls = 0, interceptions = 0, decorations = 0;
  platform.registerOperationProviders([{ name: "unrelated", operationProviders: [{
    id: "unrelated.services", list: async () => { providerListings++; throw Error("Unrelated providers were enumerated"); },
    get: async () => undefined, execute: async () => ({ data: {}, operations: [] }),
  }] }]);
  const module: RuntimeModule = { name: "reports", mcp: {
    tools: async ctx => visible && ctx.session.tenantId === allowedTenant && ctx.session.roles.includes("Organization.All.ReadWrite")
      ? [{ name, inputSchema: { type: "object" } }] : [],
    callTool: async (_name, _args, ctx) => { calls++; return { content: [], structuredContent: { tenant: ctx.session.tenantId } }; },
    interceptToolCall: async (_call, next) => { interceptions++; return next(); },
    decorateTool: tool => { if (tool.name === name) decorations++; return tool; },
  } };
  const modules = [accounts, documents as unknown as RuntimeModule, versioning as unknown as RuntimeModule,
    { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }) } }, module];
  return { db, platform, session, modules, module, hide: () => { visible = false; },
    counts: () => ({ providerListings, calls, interceptions, decorations }) };
}

async function inMemory(f: ReturnType<typeof fixture>, run: (client: Client) => Promise<void>) {
  const server = __buildGeneratedMcpServerForTests({ ...f, modulePlatform: f.platform });
  const client = new Client({ name: "dispatch-proof", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try { await server.connect(st); await client.connect(ct); await run(client); }
  finally { f.platform.unregisterServer(server); await client.close(); await server.close(); }
}

test("namespaced module calls avoid unrelated provider enumeration and recheck availability", async () => {
  for (const name of ["reports.summary", "integrations.tasks"]) {
    const f = fixture(name);
    await inMemory(f, async client => {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ tenant: f.session.tenantId });
      expect(f.counts()).toEqual({ providerListings: 0, calls: 1, interceptions: 1, decorations: 1 });
      f.hide();
      expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
      expect(f.counts().calls).toBe(1);
      expect(f.counts().providerListings).toBe(0);
    });
  }
});

test("namespaced calls do not cross role or tenant boundaries", async () => {
  for (const boundary of ["role", "tenant"]) {
    const f = fixture();
    if (boundary === "role") f.session.roles = [];
    else f.session.tenantId = "33333333-3333-4333-8333-333333333333";
    await inMemory(f, async client => {
      const result = await client.callTool({ name: "reports.summary", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(f.counts().calls).toBe(0);
      expect(f.counts().providerListings).toBe(0);
    });
  }
});

test("unknown namespaced tools are not claimed and canonical names retain complete resolution", async () => {
  const f = fixture();
  await inMemory(f, async client => {
    expect((await client.callTool({ name: "unknown.summary", arguments: {} })).isError).toBe(true);
    expect(f.counts().providerListings).toBe(0);
    expect((await client.callTool({ name: "osf_search_operations", arguments: {} })).isError).toBe(true);
    expect(f.counts().providerListings).toBe(1);
    expect(f.counts().calls).toBe(0);
  });
});

test("platform authorization of a namespaced module does not enumerate provider Operations", async () => {
  const f = fixture();
  f.module.mcp!.authorize = async (_session, request) => request.subject.kind === "tool" && request.subject.name === "reports.summary"
    ? { allowed: true } : undefined;
  f.module.mcp!.callTool = async (_name, _args, ctx) => ({ content: [], structuredContent: {
    decision: await f.platform.services.mcp.authorize(ctx.session, { action: "call", subject: { kind: "tool", name: "reports.summary" } }),
  } });
  await inMemory(f, async client => {
    const result = await client.callTool({ name: "reports.summary", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ decision: { allowed: true } });
    expect(f.counts().providerListings).toBe(0);
  });
});

test("stored ownership checks use only names that the stored-key grammar can produce", async () => {
  let lookups = 0;
  const resolution = createDerivedDefinitionResolution({ session: fixture().session,
    db: { transaction() { lookups++; throw Error("stored lookup"); } }, tables: new Map(),
    operationToolProjection: { mode: "searchable", search: "osf_search_operations", execute: "osf_execute_operation" },
  } as never);
  catalogDerivedTools.push({ entity: "GuardFixture", table: "public.guard_fixture", roles: [], keyField: "key",
    descriptionField: "description", inputFieldsField: "inputFields" });
  try {
    await resolution.assertModuleToolNamesAvailable([{ source: "module", tool: { name: "reports.summary", inputSchema: { type: "object" } } }], "reports.summary");
    expect(await resolution.coreOwnsDerivedToolName("reports.summary")).toBe(false);
    expect(lookups).toBe(0);
    await expect(resolution.assertModuleToolNamesAvailable([{ source: "module", tool: { name: "reports_summary", inputSchema: { type: "object" } } }]))
      .rejects.toThrow("stored lookup");
    expect(lookups).toBe(1);
  } finally { catalogDerivedTools.pop(); }
});

test("duplicate module owners and renaming decorators still fail before execution", async () => {
  const f = fixture();
  f.modules.push({ name: "duplicate", mcp: { tools: f.module.mcp!.tools! } });
  await inMemory(f, async client => {
    const result = await client.callTool({ name: "reports.summary", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "INTERNAL_SERVER_ERROR" } });
    expect(f.counts().calls).toBe(0);
  });
  const renamed = fixture();
  renamed.modules.push({ name: "rename", mcp: { decorateTool: tool => ({ ...tool, name: "renamed.summary" }) } });
  await inMemory(renamed, async client => {
    expect((await client.callTool({ name: "reports.summary", arguments: {} })).isError).toBe(true);
    expect(renamed.counts().calls).toBe(0);
  });
});

test("modern discovery keeps instructions while tools/call skips presentation construction", async () => {
  const f = fixture(); const flags: Array<boolean | undefined> = [];
  const { handleMcpRequest } = createTransportSessions({
    options: { db: f.db, modules: f.modules, modulePlatform: f.platform },
    requireMcpSession: async () => ({ db: f.db, session: f.session, resource: "/mcp" }),
    buildServer: (...args) => { flags.push(args[12]); return buildServer(...args); },
  });
  const app = Fastify(); app.all("/mcp", handleMcpRequest);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "modern-dispatch-proof", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(address + "/mcp")));
    expect(client.getInstructions()?.length).toBeGreaterThan(0);
    expect(flags).toContain(true);
    expect((await client.callTool({ name: "reports.summary", arguments: {} })).isError).toBeFalsy();
    expect(flags.at(-1)).toBe(false);
    expect(f.counts().providerListings).toBe(0);
    expect(client.getInstructions()?.length).toBeGreaterThan(0);
  } finally { await client.close(); await app.close(); }
  for (const body of [undefined, null, [], {}, { method: "server/discover" }, { method: "initialize" }]) {
    expect(requestNeedsInstructions(body)).toBe(true);
  }
  expect(requestNeedsInstructions({ method: "tools/call" })).toBe(false);
});

test("exact module projections avoid discovery work and still recheck current availability", async () => {
  for (const name of ["reports.summary", "integrations.tasks"]) {
    const f = fixture(name);
    let listings = 0, lookups = 0;
    const project = f.module.mcp!.tools!;
    f.module.mcp!.tools = async () => { listings++; throw Error("Discovery-only work was reached"); };
    f.module.mcp!.getTool = async (requested, ctx) => {
      lookups++;
      return (await project(ctx)).find(tool => tool.name === requested);
    };
    await inMemory(f, async client => {
      expect((await client.callTool({ name, arguments: {} })).isError).toBeFalsy();
      expect(listings).toBe(0);
      expect(lookups).toBe(1);
      expect(f.counts()).toEqual({ providerListings: 0, calls: 1, interceptions: 1, decorations: 1 });
      f.hide();
      expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
      expect(lookups).toBe(2);
      expect(f.counts().calls).toBe(1);
    });
  }
});

test("exact projections fail closed for a different name and ambiguous ownership", async () => {
  for (const failure of ["different-name", "duplicate-owner"]) {
    const f = fixture();
    f.module.mcp!.getTool = async () => ({ name: failure === "different-name" ? "other.summary" : "reports.summary", inputSchema: {type:"object"} });
    if (failure === "duplicate-owner") f.modules.push({ name: "duplicate", mcp: {
      getTool: async () => ({ name: "reports.summary", inputSchema: {type:"object"} }),
    } });
    await inMemory(f, async client => {
      expect((await client.callTool({name:"reports.summary",arguments:{}})).isError).toBe(true);
      expect(f.counts().calls).toBe(0);
    });
  }
});

test("exact projections preserve live role and tenant filtering", async () => {
  for (const boundary of ["role", "tenant"]) {
    const f = fixture(), project = f.module.mcp!.tools!;
    f.module.mcp!.getTool = async (name, ctx) =>
      (await project(ctx)).find(tool => tool.name === name);
    f.module.mcp!.tools = async () => { throw Error("Unexpected full listing"); };
    if (boundary === "role") f.session.roles = [];
    else f.session.tenantId = "33333333-3333-4333-8333-333333333333";
    await inMemory(f, async client => {
      expect((await client.callTool({ name: "reports.summary", arguments: {} })).isError).toBe(true);
      expect(f.counts().calls).toBe(0);
    });
  }
});

test("full discovery keeps its projection while authorization uses exact live lookup", async () => {
  const f = fixture(), project = f.module.mcp!.tools!;
  let listings = 0, lookups = 0;
  f.module.mcp!.tools = async ctx => { listings++; return project(ctx); };
  f.module.mcp!.getTool = async (name, ctx) => {
    lookups++;
    return (await project(ctx)).find(tool => tool.name === name);
  };
  const all = await moduleTools([f.module], {
    db: f.db, session: f.session, clientCapabilities: { elicitation: false, mcpApp: false },
  });
  expect(all.map(entry => entry.tool.name)).toEqual(["reports.summary"]);
  expect(listings).toBe(1);
  expect(lookups).toBe(0);
  f.module.mcp!.authorize = async () => ({ allowed: true });
  f.module.mcp!.callTool = async (_name, _args, ctx) => ({ content: [], structuredContent: {
    decision: await f.platform.services.mcp.authorize(ctx.session, {
      action: "call", subject: { kind: "tool", name: "reports.summary" },
    }),
  } });
  await inMemory(f, async client => {
    const result = await client.callTool({ name: "reports.summary", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ decision: { allowed: true } });
  });
  expect(listings).toBe(1);
  expect(lookups).toBeGreaterThan(0);
});
