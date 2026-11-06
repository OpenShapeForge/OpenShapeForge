// SPDX-License-Identifier: BUSL-1.1
/**
 * External catalogs become discoverable to an ordinary stateful MCP client,
 * inside the requests that are allowed to discover them.
 *
 * The provider here is a synthetic stand-in for an external MCP gateway: its
 * snapshot is per-Relation, exactly as a personal upstream connection is, and
 * `refresh` is the only thing that reaches "upstream". No upstream exists;
 * this proves the lifetime and the authority of discovery, not an integration.
 */
import { emptyCatalogDatabase } from "../../db/__tests__/empty-catalog-db.js";
import { afterEach, expect, test } from "bun:test";
import Fastify from "fastify";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  RUNTIME_NATIVE_MCP_EFFECTS,
  RUNTIME_NATIVE_MCP_OUTPUT,
  type RuntimeOperationDefinition,
  type RuntimeOperationProvider,
} from "@openshapeforge/plugin-runtime";
import accountsRuntime from "../../accounts/runtime.js";
import documentsRuntime from "@openshapeforge/documents/runtime";
import versioningRuntime from "@openshapeforge/versioning/runtime";
import { actingRelationId } from "../../db/acting-relation.js";
import type { IdentityLinkState } from "../../auth/identity-link.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { buildServer } from "../generated-mcp-server.js";
import { createTransportSessions } from "../transport-sessions.js";
import { createExternalDiscovery } from "../external-discovery.js";
import { Server } from "@modelcontextprotocol/server";
import { spawn } from "node:child_process";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "99999999-9999-4999-8999-999999999999";
const personA = "22222222-2222-4222-8222-222222222222";
const personB = "77777777-7777-4777-8777-777777777777";
const relationA = "55555555-5555-4555-8555-555555555555";
const relationB = "66666666-6666-4666-8666-666666666666";
const connectionId = "33333333-3333-4333-8333-333333333333";

const link = (relationId: string): IdentityLinkState => ({
  identityId: "identity", issuer: "test", subject: "subject", status: "linked",
  relationId, displayName: null, relationType: "person",
  candidateRelationId: null, linkedBy: null, needsRoleAssignment: false, roles: [],
});

function identity(input: {
  tenantId?: string;
  userId?: string;
  relationId?: string | null;
  relationGroupIds?: readonly string[];
} = {}): TrustedSessionContext {
  const relationId = input.relationId === undefined ? relationA : input.relationId;
  return {
    tenantId: input.tenantId ?? tenantA,
    userId: input.userId ?? personA,
    roles: ["Organization.All.ReadWrite"],
    groups: [],
    relationGroupIds: input.relationGroupIds ?? [],
    scope: "self",
    credential: "trusted-context",
    relation: relationId === null ? null : link(relationId),
  };
}

function nativeTool(name: string): RuntimeOperationDefinition {
  return {
    id: `external.${name}`, intent: "invoke", name,
    description: `${name} as upstream describes it.`,
    input: { kind: "json-schema", schema: { type: "object", properties: {} } },
    output: RUNTIME_NATIVE_MCP_OUTPUT,
    effects: RUNTIME_NATIVE_MCP_EFFECTS,
    reliability: { idempotency: { mode: "none" } },
    nativeMcpTool: { name, connectionId },
  };
}

const answer = { content: [{ type: "text" as const, text: "ok" }] };

type Refresh = {
  tenantId: string | null;
  userId: string | null;
  relationId: string | null;
  groups: readonly string[];
};

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).reverse().map((close) => close()));
});

/**
 * One deployment with one external catalog provider, served over HTTP exactly
 * as the API serves it. `identities` is the per-request session resolution, so
 * a test can revoke a link or present another person between requests.
 */
function deployment() {
  const db = emptyCatalogDatabase();
  const platform = new ModulePlatformRuntime(db);
  /** Which upstreams each Relation has a connection to, as the provider sees it. */
  const connections = new Map<string, Set<string>>();
  const discovered: { owner: string; tenantId: string; name: string }[] = [];
  const refreshes: Refresh[] = [];
  const retained: TrustedSessionContext[] = [];
  const notified: (string | null)[] = [];
  let listings = 0;
  let failure: string | null = null;
  let barrier: ((session: TrustedSessionContext, signal: AbortSignal) => Promise<void>) | undefined;

  const visible = (session: { tenantId: string | null; relation?: unknown }) => {
    const relationId = actingRelationId(session);
    return relationId === null
      ? []
      : discovered.filter(
          (entry) => entry.tenantId === session.tenantId && entry.owner === relationId,
        );
  };
  const list: RuntimeOperationProvider["list"] = async (session) => {
    listings += 1;
    return visible(session).map((entry) => nativeTool(entry.name));
  };
  const provider: RuntimeOperationProvider = {
    id: "external.mcp",
    failureIsolation: "external-catalog",
    refresh: async (session, signal) => {
      expect(signal.aborted).toBe(false);
      const relationId = actingRelationId(session);
      refreshes.push({
        tenantId: session.tenantId, userId: session.userId, relationId,
        groups: [...(session.relationGroupIds ?? [])],
      });
      retained.push(session as TrustedSessionContext);
      if (failure) throw new Error(failure);
      await barrier?.(session as TrustedSessionContext, signal);
      const tenantId = session.tenantId;
      // Nobody is acting: there is no personal upstream to discover, and the
      // snapshot of whoever IS linked must not be touched.
      if (!relationId || !tenantId) return false;
      const want = [...(connections.get(relationId) ?? [])].map((key) => `${key}_search`);
      const have = discovered.filter((entry) => entry.owner === relationId).map((entry) => entry.name);
      if (want.length === have.length && want.every((name) => have.includes(name))) return false;
      for (const entry of [...discovered]) {
        if (entry.owner === relationId) discovered.splice(discovered.indexOf(entry), 1);
      }
      for (const name of want) discovered.push({ owner: relationId, tenantId, name });
      return true;
    },
    list,
    get: async (session, operationId) =>
      (await list(session)).find((definition) => definition.id === operationId),
    execute: async () => ({ data: answer, operations: [] }),
  };
  platform.registerOperationProviders([{ name: "external", operationProviders: [provider] }]);

  const modules: readonly RuntimeModule[] = [
    accountsRuntime,
    documentsRuntime as unknown as RuntimeModule,
    versioningRuntime as unknown as RuntimeModule,
    { name: "notebook", operationHandlers: {
      importNotebook: async () => ({ value: undefined }),
      deliverToNotebook: () => { throw new Error("This test does not exercise Notebook.deliver."); },
    } },
  ];
  const identities = new Map<string, () => TrustedSessionContext>([["a", () => identity()]]);
  const { handleMcpRequest } = createTransportSessions({
    options: { db, modules, modulePlatform: platform },
    requireMcpSession: async (request) => {
      const key = String(request.headers["x-test-identity"] ?? "a");
      const resolve = identities.get(key);
      if (!resolve) throw new Error(`Unknown test identity ${key}.`);
      return { db, session: resolve(), resource: "/mcp" };
    },
    // A changed catalog notifies the session through the server the platform
    // holds; observe it there rather than through SSE stream timing.
    buildServer: (...args) => {
      const server = buildServer(...args);
      const send = server.sendToolListChanged.bind(server);
      server.sendToolListChanged = async () => {
        notified.push(args[1].userId);
        return send();
      };
      return server;
    },
  });
  const app = Fastify();
  app.all("/mcp", handleMcpRequest);
  closers.push(() => app.close());

  let address: Promise<string> | undefined;
  const listen = () => (address ??= app.listen({ host: "127.0.0.1", port: 0 }));
  const pending = (key: string, modern = false) => {
    const client = new Client({ name: "live-discovery-proof", version: "1" }, modern
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : {});
    closers.push(() => client.close());
    return {
      client,
      connect: async () => {
        const url = new URL(`${await listen()}/mcp`);
        await client.connect(new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { "x-test-identity": key } },
        }));
      },
    };
  };

  return {
    db, platform, modules, identities, connections, refreshes, retained, notified, pending, listen,
    setBarrier: (work: typeof barrier) => { barrier = work; },
    counts: () => ({ refreshes: refreshes.length, listings }),
    fail: (reason: string | null) => { failure = reason; },
    /** Hold every discovery until `arrivals` of them are inside the provider. */
    hold: (arrivals: number) => {
      const gate = Promise.withResolvers<void>();
      let seen = 0;
      barrier = async () => {
        seen += 1;
        if (seen >= arrivals) gate.resolve();
        await gate.promise;
      };
    },
    release: () => { barrier = undefined; },
    connect: async (key = "a") => {
      const session = pending(key);
      await session.connect();
      return session.client;
    },
  };
}

const toolNames = async (client: Client) =>
  (await client.listTools()).tools.map((tool) => tool.name);

test("a stateful session's own first listing already has its discovered personal tools", async () => {
  const fixture = deployment();
  fixture.connections.set(relationA, new Set(["jira"]));
  const client = await fixture.connect();

  // No stateless pre-call and no second connect: one initialize was enough.
  expect(await toolNames(client)).toContain("jira_search");
  expect(fixture.counts().refreshes).toBe(1);
  expect(fixture.refreshes[0]).toEqual({
    tenantId: tenantA, userId: personA, relationId: relationA, groups: [],
  });
});

test("a modern client's discovery handshake populates its first listing", async () => {
  const fixture = deployment();
  fixture.connections.set(relationA, new Set(["jira"]));
  const session = fixture.pending("a", true);
  await session.connect();
  expect(session.client.getProtocolEra()).toBe("modern");
  expect(await toolNames(session.client)).toContain("jira_search");
  expect(fixture.refreshes).toHaveLength(1);
  expect(fixture.refreshes[0]?.relationId).toBe(relationA);
});

test("discovery by a new session also informs an existing session", async () => {
  const fixture = deployment();
  const existing = await fixture.connect();
  expect(await toolNames(existing)).not.toContain("jira_search");
  fixture.connections.set(relationA, new Set(["jira"]));
  const priorNotices = fixture.notified.length;
  await fixture.connect();
  expect(fixture.notified.slice(priorNotices)).toContain(personA);
  expect(await toolNames(existing)).toContain("jira_search");
});

test("tools/list reaches no upstream, however often it is asked", async () => {
  const fixture = deployment();
  fixture.connections.set(relationA, new Set(["jira"]));
  const client = await fixture.connect();
  const before = fixture.counts().refreshes;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(await toolNames(client)).toContain("jira_search");
  }
  expect(fixture.counts().refreshes).toBe(before);
  expect(fixture.counts().listings).toBeGreaterThan(0);
});

test("discovery is this person's, in this tenant, and never another's", async () => {
  const fixture = deployment();
  fixture.identities.set("b", () => identity({
    tenantId: tenantB, userId: personB, relationId: relationB,
  }));
  fixture.connections.set(relationA, new Set(["jira"]));
  fixture.connections.set(relationB, new Set(["github"]));

  const mine = await fixture.connect("a");
  const theirs = await fixture.connect("b");

  expect(await toolNames(mine)).toContain("jira_search");
  expect(await toolNames(mine)).not.toContain("github_search");
  expect(await toolNames(theirs)).toContain("github_search");
  expect(await toolNames(theirs)).not.toContain("jira_search");
  expect(fixture.refreshes.map((entry) => entry.relationId).sort()).toEqual(
    [relationA, relationB].sort(),
  );
}, 15_000);

test("an unlinked Relation discovers nothing and is shown nothing", async () => {
  const fixture = deployment();
  fixture.connections.set(relationA, new Set(["jira"]));
  const client = await fixture.connect();
  expect(await toolNames(client)).toContain("jira_search");

  // An administrator unlinks the identity; the next request resolves that.
  fixture.identities.set("a", () => identity({ relationId: null }));
  expect(await toolNames(client)).not.toContain("jira_search");

  const before = fixture.counts().refreshes;
  const denied = await client.callTool({ name: "jira_search", arguments: {} });
  expect(denied.isError).toBe(true);
  // The call still discovered — and found nobody acting, so it discovered
  // nothing rather than rediscovering the link this session no longer has.
  expect(fixture.counts().refreshes).toBe(before + 1);
  expect(fixture.refreshes.at(-1)?.relationId).toBeNull();

  fixture.identities.set("a", () => identity());
  expect(await toolNames(client)).toContain("jira_search");
}, 15_000);

test("concurrent initializes each discover as themselves", async () => {
  const fixture = deployment();
  fixture.identities.set("b", () => identity({ userId: personB, relationId: relationB }));
  fixture.connections.set(relationA, new Set(["jira"]));
  fixture.connections.set(relationB, new Set(["github"]));
  const mine = fixture.pending("a");
  const theirs = fixture.pending("b");

  // Neither discovery may finish before the other has started, so the two run
  // with their principals genuinely overlapping.
  fixture.hold(2);
  await Promise.all([mine.connect(), theirs.connect()]);
  fixture.release();

  expect(fixture.refreshes).toHaveLength(2);
  const byRelation = new Map(fixture.refreshes.map((entry) => [entry.relationId, entry]));
  expect(byRelation.get(relationA)?.userId).toBe(personA);
  expect(byRelation.get(relationB)?.userId).toBe(personB);
  expect(await toolNames(mine.client)).toContain("jira_search");
  expect(await toolNames(mine.client)).not.toContain("github_search");
  expect(await toolNames(theirs.client)).toContain("github_search");
  expect(await toolNames(theirs.client)).not.toContain("jira_search");
}, 15_000);

test("a connection added in-session refreshes the catalog and tells the session", async () => {
  const fixture = deployment();
  fixture.identities.set("b", () => identity({
    tenantId: tenantB, userId: personB, relationId: relationB,
  }));
  fixture.connections.set(relationA, new Set(["jira"]));
  const mine = await fixture.connect("a");
  const theirs = await fixture.connect("b");
  const priorNotices = fixture.notified.length;

  fixture.connections.set(relationA, new Set(["jira", "github"]));
  const called = await mine.callTool({ name: "jira_search", arguments: {} });
  expect(called.isError).toBeFalsy();

  expect(await toolNames(mine)).toContain("github_search");
  // The change reached this tenant's live session, once, and no other's.
  expect(fixture.notified.slice(priorNotices)).toEqual([personA]);
  expect(await toolNames(theirs)).not.toContain("github_search");
}, 15_000);

test("overlapping requests each refresh after an earlier snapshot", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let version = 1;
  const seen: number[] = [];
  const platform = { refreshExternalCatalogs: async () => {
    const observed = version;
    seen.push(observed);
    if (seen.length === 1) { firstStarted.resolve(); await releaseFirst.promise; }
    return true;
  } } as unknown as ModulePlatformRuntime;
  const server = new Server({ name: "queued-refresh", version: "1" }, { capabilities: { tools: {} } });
  const discovery = createExternalDiscovery({ server, session: identity(), modulePlatform: platform });
  const first = discovery.discover();
  await firstStarted.promise;
  version = 2;
  const second = discovery.discover();
  releaseFirst.resolve();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(seen).toEqual([1, 2]);
  await server.close();
});

test("a cancelled request waiting for another refresh never gains authority", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const platform = { refreshExternalCatalogs: async () => {
    calls++;
    started.resolve();
    await release.promise;
    return true;
  } } as unknown as ModulePlatformRuntime;
  const server = new Server({ name: "cancelled-refresh", version: "1" }, { capabilities: { tools: {} } });
  const discovery = createExternalDiscovery({ server, session: identity(), modulePlatform: platform });
  const first = discovery.discover();
  await started.promise;
  const controller = new AbortController();
  const second = discovery.discover({ signal: controller.signal });
  controller.abort();
  expect(await second).toBe(false);
  release.resolve();
  expect(await first).toBe(true);
  expect(calls).toBe(1);
  await server.close();
});

test("a disconnected stateful call loses discovery authority", async () => {
  const fixture = deployment();
  fixture.connections.set(relationA, new Set(["jira"]));
  const url = `${await fixture.listen()}/mcp`;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(url, { method: "POST", headers, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "disconnect-proof", version: "1" } },
  }) });
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await init.text();
  const started = Promise.withResolvers<void>();
  const checked = Promise.withResolvers<boolean>();
  fixture.setBarrier(async (session, signal) => {
    started.resolve();
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    await new Promise<void>(resolve => setImmediate(resolve));
    try { await fixture.platform.services.db.withSession(session, async () => undefined); checked.resolve(false); }
    catch { checked.resolve(true); }
  });
  const script = `const http = require('node:http'); const request = http.request(process.argv[1], { method: 'POST', headers: JSON.parse(process.argv[2]) }); request.on('error', () => {}); request.end(process.argv[3]);`;
  const call = spawn(process.execPath, ["-e", script, url, JSON.stringify({ ...headers, "mcp-session-id": sessionId!, "mcp-protocol-version": "2025-03-26" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jira_search", arguments: {} } })], { stdio: "ignore" });
  await started.promise;
  call.kill();
  expect(await Promise.race([checked.promise, new Promise(resolve => setTimeout(() => resolve(false), 2_000))])).toBe(true);
}, 15_000);

test("a failing upstream costs the session nothing it already had", async () => {
  const fixture = deployment();
  fixture.connections.set(relationA, new Set(["jira"]));
  const client = await fixture.connect();
  expect(await toolNames(client)).toContain("jira_search");
  const priorNotices = fixture.notified.length;

  fixture.fail("upstream is unreachable");
  fixture.connections.set(relationA, new Set(["jira", "github"]));
  const called = await client.callTool({ name: "jira_search", arguments: {} });

  expect(called.isError).toBeFalsy();
  expect(await toolNames(client)).toContain("jira_search");
  expect(await toolNames(client)).not.toContain("github_search");
  expect(fixture.notified).toHaveLength(priorNotices);
});

test("the capability a discovery ran on is refused once the request is over", async () => {
  const fixture = deployment();
  fixture.connections.set(relationA, new Set(["jira"]));
  const client = await fixture.connect();
  expect((await client.callTool({ name: "jira_search", arguments: {} })).isError).toBeFalsy();

  const late = fixture.retained.at(-1)!;
  const services = fixture.platform.services;
  // Wrapped so a refusal counts whether it is thrown or rejected.
  const attempt = (work: () => unknown) => (async () => work())();
  await expect(attempt(() => services.db.withSession(late, async () => undefined)))
    .rejects.toThrow("Module database work requires a live verified session.");
  await expect(attempt(() => services.secrets.resolveConnectionValues(late, { connectionId })))
    .rejects.toThrow("Module connection resolution requires a live verified session.");
  await expect(attempt(() => services.egress.request(late, {} as never, {
    url: "https://upstream.example/", method: "POST",
  } as never))).rejects.toThrow("Module egress requires a live verified session.");
});

test("the stateless single-shot path discovers on a call and never on a listing", async () => {
  const fixture = deployment();
  fixture.connections.set(relationA, new Set(["jira"]));
  // Seed the snapshot the way a live session would have, so the stateless
  // request has something to list without discovering first.
  await fixture.platform.refreshExternalCatalogs(identity(), { budgetMs: 1_000, notify: false });
  const seeded = fixture.counts().refreshes;

  const server = buildServer(
    fixture.db, identity(), fixture.modules, fixture.platform, undefined, undefined, false,
  );
  const client = new Client({ name: "stateless-proof", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // Building the server reached no upstream, and neither does the listing.
    expect(fixture.counts().refreshes).toBe(seeded);
    expect(await toolNames(client)).toContain("jira_search");
    expect(fixture.counts().refreshes).toBe(seeded);

    expect((await client.callTool({ name: "jira_search", arguments: {} })).isError).toBeFalsy();
    expect(fixture.counts().refreshes).toBe(seeded + 1);
    // A single-shot server is not a live session: nothing is notified on it.
    expect(fixture.notified).toEqual([]);
  } finally {
    fixture.platform.unregisterServer(server);
    await client.close();
    await server.close();
  }
});
