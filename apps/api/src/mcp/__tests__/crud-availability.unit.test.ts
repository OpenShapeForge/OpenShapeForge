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
import accountsRuntime from "../../accounts/runtime.js";
import { describe, expect, it } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
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
    modules: [accountsRuntime,
      documentsPluginRuntime as unknown as RuntimeModule,
      versioningPluginRuntime as unknown as RuntimeModule,
      { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }) } },
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

async function operationIds(client: Client): Promise<string[]> {
  const ids: string[] = []; let cursor: string | undefined;
  do {
    const result = await client.callTool({ name: "osf_search_operations", arguments: { limit: 20, ...(cursor ? { cursor } : {}) } });
    expect(result.isError).toBeFalsy();
    const page = result.structuredContent as { operations: { operation: { id: string } }[]; nextCursor?: string };
    ids.push(...page.operations.map(row => row.operation.id)); cursor = page.nextCursor;
  } while (cursor);
  return ids;
}
const operationId = (entity: string, intent: string) =>
  crudToolsNamed(intent === 'delete' && entity === 'Relation' ? 'relation_delete' : `osf_${intent}`).find(tool => tool.entity === entity)!.operationId;

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

  it("withholds and refuses an owned child delete through canonical discovery and execution", async () => {
    for (const entity of ["Relation", "Address"]) {
      await withServer([...RELATIONS, ...FINANCE], tablesOwning(entity), async client => {
        const id = operationId(entity, "delete"), ids = await operationIds(client);
        expect(ids).not.toContain(id);
        expect(ids).toContain(operationId("Address", "list"));
        const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: id, input: { id: "33333333-3333-4333-8333-333333333333" } } });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
      });
    }
  });
  it("withholds impossible creates but retains readable and independently creatable Operations", async () => {
    const quote = operationId("Quote", "create"), line = operationId("QuoteLine", "create");
    await withServer(FINANCE, tablesWithRequiredLines(), async client => {
      const ids = await operationIds(client);
      expect(ids).not.toContain(quote); expect(ids).toContain(line); expect(ids).toContain(operationId("Quote", "list"));
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: quote, input: { quoteNumber: "Q-1" } } });
      expect(result.isError).toBe(true); expect(result.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
    });
    const emptyCreates = tablesWithRequiredOwnerKey();
    for (const [key, table] of emptyCreates) {
      if (["Budget", "BudgetLine"].includes(table.source?.authoringEntityName ?? "")) {
        emptyCreates.set(key, { ...table, source: { ...table.source!, crud: { ...table.source!.crud!, operations: { ...table.source!.crud!.operations, create: false } } } });
      }
    }
    await withServer(FINANCE, emptyCreates, async client => {
      const ids = await operationIds(client);
      expect(ids).not.toContain(quote); expect(ids).not.toContain(line); expect(ids).toContain(operationId("QuoteLine", "list"));
      const result = await client.callTool({ name: "osf_execute_operation", arguments: { operationId: line, input: { lineNumber: 1 } } });
      expect(result.isError).toBe(true); expect(result.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
    });
    await withServer(FINANCE, new Map(getGeneratedCrudTables().map(table => [table.name, table])), async client => {
      expect(await operationIds(client)).toEqual(expect.arrayContaining([quote, line]));
    });
  });
});
