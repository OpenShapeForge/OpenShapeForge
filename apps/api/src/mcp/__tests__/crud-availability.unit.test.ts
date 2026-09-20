// SPDX-License-Identifier: BUSL-1.1
/**
 * Listing, osf_describe and the call path share one availability rule
 * (crudToolAvailable). The case that told them apart: a delete of an owned
 * child, which the collection policy refuses for every caller. The listing
 * withheld it while the call still resolved it and died later with
 * RELATION_COLLECTION_MUTATION_UNSUPPORTED. Here a fake owner makes Address
 * (generic) and Relation (dedicated) owned children, on the real catalogue
 * and manifest, and both the resolution and the real call answer as for an
 * unknown tool. Runs without a database.
 */
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import documentsPluginRuntime from "@openshapeforge/documents/runtime";
import versioningPluginRuntime from "@openshapeforge/versioning/runtime";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { getGeneratedCrudTables } from "../../operations/entity/index.js";
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";
import { resolveCrudTool } from "../generic-tool-projection.js";
import { crudToolsNamed } from "../catalog.js";
import { crudToolAvailable } from "../session-projection.js";

const session = (...roles: string[]) =>
  ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    roles,
    groups: [],
    scope: "self",
    credential: "trusted-context",
  }) as never;

/** The real tables plus one fake owner that makes `target` an owned child. */
function tablesOwning(target: string) {
  const tables = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
  tables.set("erp.fake_owners", {
    name: "erp.fake_owners",
    columns: [{ name: "id", type: "uuid" }],
    source: {
      graphql: {
        typeName: "FakeOwner",
        relationships: [
          { fieldKey: "children", resolve: "hasMany", target, foreignKey: "owner_id", ownership: "owned" },
        ],
      },
    },
  } as never);
  return tables;
}

const RELATIONS = ["Relations.All.ReadWrite", "Relations.All.Delete"];
const FINANCE = ["Finance.All.ReadWrite"];

/** The real tables with Quote's line collection required to hold at least one line. */
function tablesWithRequiredLines() {
  const tables = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
  const quotes = tables.get("erp.quotes")!;
  tables.set("erp.quotes", {
    ...quotes,
    source: {
      ...quotes.source,
      graphql: {
        ...quotes.source!.graphql,
        relationships: quotes.source!.graphql!.relationships!.map((relationship) =>
          relationship.fieldKey === "quoteLines"
            ? { ...relationship, ownership: "owned", cardinality: { min: 1 } }
            : relationship,
        ),
      },
    },
  } as never);
  return tables;
}

/** The real tables with the line's owner key (quote_id) required and owned. */
function tablesWithRequiredOwnerKey() {
  const tables = tablesWithRequiredLines();
  const lines = tables.get("erp.quote_lines")!;
  tables.set("erp.quote_lines", {
    ...lines,
    columns: lines.columns.map((column) => (column.name === "quote_id" ? { ...column, required: true } : column)),
  } as never);
  return tables;
}

async function withServer<T>(roles: string[], tables: Map<string, unknown>, run: (client: Client) => Promise<T>): Promise<T> {
  const db = {} as OpenShapeForgeDatabase;
  const platform = new ModulePlatformRuntime(db);
  const server = __buildGeneratedMcpServerForTests({
    db,
    session: session(...roles),
    modules: [
      documentsPluginRuntime as unknown as RuntimeModule,
      versioningPluginRuntime as unknown as RuntimeModule,
      { name: "workflow", operationHandlers: { startWebhook: async () => ({ value: undefined }) } },
    ],
    modulePlatform: platform,
    tables: tables as never,
  });
  const client = new Client({ name: "availability-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client);
  } finally {
    platform.unregisterServer(server);
    await client.close();
    await server.close();
  }
}

const entityEnum = (tools: { name: string; inputSchema: unknown }[], name: string): string[] | undefined =>
  (tools.find((tool) => tool.name === name)?.inputSchema as { properties?: { entity?: { enum?: string[] } } } | undefined)
    ?.properties?.entity?.enum;

describe("one availability rule for listing, describe and call", () => {
  it("resolves neither the generic nor the dedicated delete of an owned child", () => {
    const owned = tablesOwning("Address");
    const address = crudToolsNamed("osf_delete").find((tool) => tool.entity === "Address")!;
    expect(crudToolAvailable(address, session(...RELATIONS), owned)).toBe(false);
    const resolution = () => resolveCrudTool("osf_delete", { entity: "Address" }, session(...RELATIONS), owned);
    // Other generic entities may still be deletable; Address is not among them.
    try {
      expect(resolution()).toBeUndefined();
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/"Address" is not one of the entities/);
    }
    const relation = crudToolsNamed("relation_delete")[0]!;
    expect(crudToolAvailable(relation, session(...RELATIONS), tablesOwning("Relation"))).toBe(false);
    // Unchanged tables: both are available to the same session.
    const real = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
    expect(crudToolAvailable(address, session(...RELATIONS), real)).toBe(true);
    expect(crudToolAvailable(relation, session(...RELATIONS), real)).toBe(true);
  });

  it("answers the real call as for an unknown tool, on the dedicated and the generic name", async () => {
    for (const [name, args, target] of [
      ["relation_delete", { id: "33333333-3333-4333-8333-333333333333", expectedVersion: "x" }, "Relation"],
      ["osf_delete", { entity: "Address", id: "33333333-3333-4333-8333-333333333333" }, "Address"],
    ] as const) {
      // Finance roles keep other generic entities deletable, so osf_delete
      // stays listed and its entity enum is what shows Address withheld.
      await withServer([...RELATIONS, ...FINANCE], tablesOwning(target), async (client) => {
        const { tools } = await client.listTools();
        if (name === "relation_delete") {
          expect(tools.map((tool) => tool.name)).not.toContain("relation_delete");
        } else {
          // osf_delete stays listed for the other generic entities; its
          // entity enum no longer offers Address.
          const deletable = entityEnum(tools, "osf_delete");
          expect(deletable).toBeDefined();
          expect(deletable).not.toContain("Address");
          expect(entityEnum(tools, "osf_list")).toContain("Address");
        }
        const result = await client.callTool({ name, arguments: { ...args } });
        expect(result.isError).toBe(true);
        const text = String((result.content as { text?: string }[])[0]?.text);
        // The dedicated name is unknown; the generic name is known and refuses
        // the entity by naming the ones it can address — Address not among them.
        expect(text).toMatch(
          name === "relation_delete"
            ? /^NOT_FOUND/
            : /^BAD_USER_INPUT: "Address" is not one of the entities "osf_delete" can address in this session: Quote, QuoteLine\./,
        );
        expect(text).not.toContain("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
      });
    }
  });

  it("withholds and refuses a create the collection policy would refuse, through the real server", async () => {
    // Quote's lines must hold at least one line: the owner's generic create
    // cannot satisfy that atomically, so osf_create no longer offers Quote.
    await withServer(FINANCE, tablesWithRequiredLines(), async (client) => {
      const { tools } = await client.listTools();
      expect(entityEnum(tools, "osf_create")).not.toContain("Quote");
      expect(entityEnum(tools, "osf_create")).toContain("QuoteLine");
      expect(entityEnum(tools, "osf_list")).toContain("Quote");
      const result = await client.callTool({ name: "osf_create", arguments: { entity: "Quote", quoteNumber: "Q-1" } });
      expect(result.isError).toBe(true);
      expect(String((result.content as { text?: string }[])[0]?.text)).toMatch(
        /^BAD_USER_INPUT: "Quote" is not one of the entities "osf_create" can address in this session: QuoteLine\./,
      );
    });
    // The line's owner key is required and managed by the owner: the child's
    // generic create cannot set it, so osf_create no longer offers QuoteLine.
    await withServer(FINANCE, tablesWithRequiredOwnerKey(), async (client) => {
      const { tools } = await client.listTools();
      // Quote's create is withheld as above too, so osf_create has no entity
      // left for this session and is not listed at all.
      expect(entityEnum(tools, "osf_create") ?? []).not.toContain("QuoteLine");
      expect(entityEnum(tools, "osf_list")).toContain("QuoteLine");
      const result = await client.callTool({ name: "osf_create", arguments: { entity: "QuoteLine", lineNumber: 1 } });
      expect(result.isError).toBe(true);
      expect(String((result.content as { text?: string }[])[0]?.text)).toMatch(/^NOT_FOUND/);
    });
    // On the unchanged manifest both creates are offered.
    await withServer(FINANCE, new Map(getGeneratedCrudTables().map((table) => [table.name, table])), async (client) => {
      const { tools } = await client.listTools();
      expect(entityEnum(tools, "osf_create")).toEqual(expect.arrayContaining(["Quote", "QuoteLine"]));
    });
  });
});
