// SPDX-License-Identifier: BUSL-1.1
/**
 * The platform administrator MCP over the bound control Operations: the tool
 * list a session sees is decided by the Operations' roles, tool names come
 * from the MCP projection, an acknowledgement Operation carries its
 * `confirmed` field, and a call goes through the canonical runtime — its
 * refusals included.
 *
 * In-process over an in-memory transport, with a database that answers
 * every query with no rows, so the reads that need one answer "nothing" and
 * the ones that need Keycloak refuse by name.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import { controlSessionFor, type ControlSessionContext } from "../../control/control-session.js";
import type { ControlRuntime } from "../../control/runtime.js";
import { controlOperationContracts } from "../../control/__tests__/control-operation-fixtures.js";
import type { DB } from "../../generated/db/types.js";
import { PLATFORM_GUIDE, PLATFORM_SESSION_RESOURCE_URI } from "../../control/platform-tools.js";
import { __buildPlatformServerForTests } from "../control-mcp-server.js";

const administrator = {
  subject: "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
  issuer: "http://localhost:8181/realms/openshapeforge-control",
  username: "platform-admin",
  name: "Platform admin",
  email: "platform-admin@example.com",
  authorizedParty: "codex-platform",
  expiresAtMs: null,
};

const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (database) => new PostgresIntrospector(database),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const runtime: ControlRuntime = {
  config: { ok: false, missing: ["OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL"] },
  provider: undefined,
  operations: controlOperationContracts(),
};

async function connect(session: ControlSessionContext) {
  const server = __buildPlatformServerForTests({
    context: { db, control: runtime },
    session,
    operations: controlOperationContracts(),
    client: { name: "Claude Code", version: "2.1.0", capabilities: [] },
  });
  const client = new Client({ name: "control-mcp-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const contracts = controlOperationContracts();
const mcpName = (handler: string) => contracts.find((c) => c.handler === handler)!.transports.mcp.name!;
const rolesOf = (handler: string) => {
  const auth = contracts.find((c) => c.handler === handler)!.auth;
  return auth.mode === "control" ? auth.roles : [];
};

describe("the control MCP tool list", () => {
  test("a platform_admin-only session sees shared reads and administrator tools, with the confirmed field where declared", async () => {
    const { client, close } = await connect(controlSessionFor(administrator, ["platform_admin"]));
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
        contracts
          .filter((contract) => rolesOf(contract.handler).includes("platform_admin"))
          .map((contract) => contract.transports.mcp.name!)
          .sort(),
      );
      const retireCatalogEntry = listed.tools.find((tool) => tool.name === "retire_catalog_entry")!;
      expect(retireCatalogEntry.inputSchema.properties).toHaveProperty("confirmed");
      expect((retireCatalogEntry.inputSchema as { required?: string[] }).required).toEqual(["kind", "key"]);
      expect(listed.tools.map((tool) => tool.name)).not.toContain("update_tenant");
      expect(listed.tools.find((tool) => tool.name === "list_tenants")!.inputSchema.properties).not.toHaveProperty("confirmed");
      expect(listed.tools.find((tool) => tool.name === "retire_catalog_entry")!.annotations).toMatchObject({
        readOnlyHint: false, idempotentHint: false,
      });
      expect(listed.tools.find((tool) => tool.name === "get_reconciliation_report")!.annotations).toMatchObject({
        readOnlyHint: true, openWorldHint: true,
      });
    } finally {
      await close();
    }
  });

  test("a platform-operator-only session sees the tenant lifecycle and not the catalog", async () => {
    const { client, close } = await connect(controlSessionFor(administrator, ["platform-operator"]));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        contracts
          .filter((contract) => rolesOf(contract.handler).includes("platform-operator"))
          .map((contract) => contract.transports.mcp.name!)
          .sort(),
      );
      expect(names).toContain("create_tenant");
      expect(names).toContain("whoami");
      expect(names).not.toContain("list_catalog_entries");
      expect(names).not.toContain("publish_update_notice");
      expect(names).not.toContain("list_platform_audit");
    } finally {
      await close();
    }
  });
});

describe("calling a control tool", () => {
  test("goes through the canonical runtime: guide, whoami with the session's own counts, and the platform-session resource", async () => {
    const { client, close } = await connect(controlSessionFor(administrator, ["platform-operator"]));
    try {
      const guide = await client.callTool({ name: mcpName("platformGuide"), arguments: {} });
      expect(guide.isError).not.toBe(true);
      expect(guide.structuredContent).toEqual({ guide: PLATFORM_GUIDE });

      const listed = (await client.listTools()).tools.length;
      const who = await client.callTool({ name: "whoami", arguments: {} });
      expect(who.isError).not.toBe(true);
      expect(who.structuredContent).toMatchObject({
        role: "Platform operator",
        scope: "platform",
        tenants: 0,
        connectedVia: "Claude Code 2.1.0",
        access: { tools: listed, resources: 1 },
      });

      const resource = await client.readResource({ uri: PLATFORM_SESSION_RESOURCE_URI });
      const text = resource.contents[0] as { text: string };
      expect(JSON.parse(text.text)).toMatchObject({ scope: "platform", access: { tools: listed, resources: 1 } });
    } finally {
      await close();
    }
  });

  test("refuses an unknown or unauthorized tool as NOT_FOUND and answers declared refusals as tool results", async () => {
    const { client, close } = await connect(controlSessionFor(administrator, ["platform-operator"]));
    try {
      for (const name of ["finding_list", "list_catalog_entries"]) {
        const refused = await client.callTool({ name, arguments: {} });
        expect(refused.isError).toBe(true);
        expect(refused.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
        expect(JSON.stringify(refused)).not.toContain("publish_catalog_entry");
      }
      // Schema before anything else: an argument the Operation does not declare.
      const unknownArgument = await client.callTool({ name: "list_tenants", arguments: { tenantId: "x" } });
      expect(unknownArgument.isError).toBe(true);
      expect(unknownArgument.structuredContent).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
      // Acknowledgement before the handler.
      const unconfirmed = await client.callTool({ name: "update_tenant", arguments: { slug: "acme", status: "suspended" } });
      expect(unconfirmed.isError).toBe(true);
      expect(unconfirmed.structuredContent).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED" } });
      // Confirmed, the handler runs and refuses in the declared vocabulary with its own code kept.
      const unconfigured = await client.callTool({
        name: "update_tenant",
        arguments: { slug: "acme", status: "suspended", confirmed: true },
      });
      expect(unconfigured.isError).toBe(true);
      expect(unconfigured.structuredContent).toMatchObject({
        error: { code: "CONTROL_PLANE_NOT_CONFIGURED", detail: "CONTROL_PLANE_NOT_CONFIGURED" },
      });
      expect(JSON.stringify(unconfigured.structuredContent)).toContain("OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL");
    } finally {
      await close();
    }
  });
});
