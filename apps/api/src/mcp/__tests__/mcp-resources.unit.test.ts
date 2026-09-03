// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for MCP resource visibility — the one rule that exists only
 * on the resource surface: a catalogue resource is advertised to a session
 * exactly when that session holds the entity's read role, mirroring how the
 * tool listing omits unauthorized tools rather than erroring. The read
 * handlers themselves go through the shared CRUD core, whose authorization
 * and redaction behaviour the GraphQL and REST suites already prove.
 *
 * Runs without a database, so it holds the line even while no shipped entity
 * authors an `mcp.resource` block.
 */
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import rawCatalog from "../../generated/mcp/tools.json" with { type: "json" };
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import {
  __buildGeneratedMcpServerForTests,
  __resourcesForSessionForTests as resourcesForSession,
} from "../generated-mcp-server.js";

const READ = "Widgets.All.Read";

const session = (...roles: string[]) =>
  ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    roles,
    groups: [],
    scope: "self",
  }) as never;

const table = {
  name: "erp.widgets",
  columns: [],
  source: {
    crud: { operations: { list: true, get: true, create: true, update: true, delete: true } },
    authorization: { roles: { read: [READ], create: [], update: [], delete: [] } },
  },
} as never;

const resource = {
  uri: "app://widgets",
  name: "Widgets",
  description: "Read the widget catalogue.",
  templateUri: "app://widgets/{id}",
  templateName: "Specific Widget",
  templateDescription: "Read one widget by id.",
  entity: "Widget",
  table: "erp.widgets",
};

const tables = new Map([["erp.widgets", table]]);

describe("resourcesForSession", () => {
  it("advertises a resource to a session holding the entity read role", () => {
    expect(resourcesForSession(session(READ), tables as never, [resource])).toEqual([resource]);
  });

  it("omits the resource for a session without the read role", () => {
    expect(resourcesForSession(session("Other.Role"), tables as never, [resource])).toEqual([]);
    expect(resourcesForSession(session(), tables as never, [resource])).toEqual([]);
  });

  it("omits a resource whose table is missing from the manifest", () => {
    expect(resourcesForSession(session(READ), new Map() as never, [resource])).toEqual([]);
  });

  it("routes module-owned handle authorization through the platform service", async () => {
    const db = {} as OpenShapeForgeDatabase;
    const platform = new ModulePlatformRuntime(db);
    const handle = "app://artifacts/item-1";
    const check = "app://authorization/check";
    let moduleAuthorizationCalls = 0;
    const module: RuntimeModule = {
      name: "artifacts",
      mcp: {
        resources: async () => [
          { uri: check, name: "authorization-check" },
          { uri: handle, name: "artifact" },
        ],
        readResource: async (uri, ctx) => {
          const authorize = (subject: Parameters<
            typeof platform.services.mcp.authorize
          >[1]["subject"]) => platform.services.mcp.authorize(
            ctx.session,
            { action: subject.kind === "tool" ? "call" : "read", subject },
          );
          return {
            contents: [{
              uri,
              text: JSON.stringify({
                owned: await authorize({ kind: "resource-handle", uri: handle }),
                coreTool: await authorize({
                  kind: "tool",
                  name: "contact_detail_list",
                }),
                coreResource: await authorize({
                  kind: "resource-handle",
                  uri: "osf://schema/entities/contact-detail",
                }),
                coreRow: await authorize({
                  kind: "entity-row",
                  entity: "ContactDetail",
                  id: "33333333-3333-4333-8333-333333333333",
                }),
              }),
            }],
          };
        },
        authorize: async () => {
          moduleAuthorizationCalls += 1;
          return { allowed: true, fieldAllowlist: ["title", "id"] };
        },
      },
    };
    const server = __buildGeneratedMcpServerForTests({
      db,
      session: session(READ),
      modules: [{
        name: "workflow",
        operationHandlers: {
          startWebhook: async () => ({ value: undefined }),
        },
      }, module],
      modulePlatform: platform,
      tables: new Map(),
    });
    const client = new Client(
      { name: "module-authorization-test", version: "1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.readResource({ uri: check });
      const content = result.contents[0];
      expect(content && "text" in content ? JSON.parse(content.text) : undefined)
        .toEqual({
          owned: { allowed: true, fieldAllowlist: ["id", "title"] },
          coreTool: { allowed: false, code: "NOT_FOUND" },
          coreResource: { allowed: false, code: "NOT_FOUND" },
          coreRow: { allowed: false, code: "NOT_FOUND" },
        });
      expect(moduleAuthorizationCalls).toBe(1);
    } finally {
      platform.unregisterServer(server);
      await client.close();
      await server.close();
    }
  });

  it("reserves hidden core resource URIs against module shadowing", async () => {
    const db = {} as OpenShapeForgeDatabase;
    const platform = new ModulePlatformRuntime(db);
    const coreUri = "osf://schema/entities/contact-detail";
    const module: RuntimeModule = {
      name: "collision",
      mcp: {
        resources: async () => [{ uri: coreUri, name: "shadow" }],
        readResource: async (uri) => ({
          contents: [{ uri, text: "module-shadow" }],
        }),
      },
    };
    const server = __buildGeneratedMcpServerForTests({
      db,
      session: session("Other.Role"),
      modules: [{
        name: "workflow",
        operationHandlers: {
          startWebhook: async () => ({ value: undefined }),
        },
      }, module],
      modulePlatform: platform,
      tables: new Map(),
    });
    const client = new Client(
      { name: "module-resource-collision-test", version: "1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await expect(client.listResources()).rejects.toThrow(
        /contributed more than once/,
      );
      await expect(client.readResource({ uri: coreUri })).rejects.toThrow(
        /contributed more than once/,
      );
    } finally {
      platform.unregisterServer(server);
      await client.close();
      await server.close();
    }
  });

  it("reserves hidden core resource templates against module shadowing", async () => {
    const db = {} as OpenShapeForgeDatabase;
    const platform = new ModulePlatformRuntime(db);
    const templateUri = "app://core-items/{id}";
    const catalogResources = (rawCatalog as unknown as {
      resources: Array<Record<string, string>>;
    }).resources;
    const coreResource = {
      uri: "app://core-items",
      name: "core-items",
      description: "Core items.",
      templateUri,
      templateName: "core-item",
      templateDescription: "One core item.",
      entity: "Widget",
      table: "erp.widgets",
    };
    catalogResources.push(coreResource);
    const module: RuntimeModule = {
      name: "collision",
      mcp: {
        resourceTemplates: async () => [{
          uriTemplate: templateUri,
          name: "shadow",
        }],
        readResource: async (uri) => ({
          contents: [{ uri, text: "module-shadow" }],
        }),
      },
    };
    const server = __buildGeneratedMcpServerForTests({
      db,
      session: session("Other.Role"),
      modules: [{
        name: "workflow",
        operationHandlers: {
          startWebhook: async () => ({ value: undefined }),
        },
      }, module],
      modulePlatform: platform,
      tables: new Map(),
    });
    const client = new Client(
      { name: "module-template-collision-test", version: "1" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await expect(client.listResourceTemplates()).rejects.toThrow(
        /contributed more than once/,
      );
      await expect(client.readResource({ uri: "app://core-items/item-1" }))
        .rejects.toThrow(/contributed more than once/);
    } finally {
      platform.unregisterServer(server);
      await client.close();
      await server.close();
      expect(catalogResources.pop()).toBe(coreResource);
    }
  });
});
