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
      const db = {} as OpenShapeForgeDatabase;
      const platform = new ModulePlatformRuntime(db);
      const server = __buildGeneratedMcpServerForTests({
        db,
        session: session(...RELATIONS),
        modules: [
          documentsPluginRuntime as unknown as RuntimeModule,
          versioningPluginRuntime as unknown as RuntimeModule,
          { name: "workflow", operationHandlers: { startWebhook: async () => ({ value: undefined }) } },
        ],
        modulePlatform: platform,
        tables: tablesOwning(target),
      });
      const client = new Client({ name: "availability-test", version: "1" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).not.toContain(name === "relation_delete" ? "relation_delete" : "never");
        const result = await client.callTool({ name, arguments: { ...args } });
        expect(result.isError).toBe(true);
        const text = String((result.content as { text?: string }[])[0]?.text);
        expect(text).toContain("NOT_FOUND");
        expect(text).not.toContain("RELATION_COLLECTION_MUTATION_UNSUPPORTED");
      } finally {
        platform.unregisterServer(server);
        await client.close();
        await server.close();
      }
    }
  });
});
