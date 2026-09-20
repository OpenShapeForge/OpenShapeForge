// SPDX-License-Identifier: BUSL-1.1
/**
 * osf_describe through the real server: listed, callable through tools/call,
 * and authorized through the module authorization path — the one that
 * classifies a name by its source and answered NOT_FOUND for a tool it had
 * just listed while the name was not classified as a core tool. The e2e
 * helper reads schemas through tools/call only, which is why it did not see
 * that path. Runs on the compiled catalogue and manifest, without a database.
 */
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import documentsPluginRuntime from "@openshapeforge/documents/runtime";
import versioningPluginRuntime from "@openshapeforge/versioning/runtime";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import rawCatalog from "../../generated/mcp/tools.json" with { type: "json" };
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";

const catalog = rawCatalog as unknown as { entities: { entity: string; tools?: string }[] };
const generic = catalog.entities.some((entity) => entity.tools === "generic" && entity.entity === "Address");

const session = (...roles: string[]) =>
  ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    roles,
    groups: [],
    scope: "self",
    credential: "trusted-context",
  }) as never;

async function withServer<T>(
  roles: string[],
  run: (client: Client, platform: ModulePlatformRuntime) => Promise<T>,
  module?: RuntimeModule,
): Promise<T> {
  const db = {} as OpenShapeForgeDatabase;
  const platform = new ModulePlatformRuntime(db);
  const server = __buildGeneratedMcpServerForTests({
    db,
    session: session(...roles),
    modules: [
      documentsPluginRuntime as unknown as RuntimeModule,
      versioningPluginRuntime as unknown as RuntimeModule,
      { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }) } },
      ...(module ? [module] : []),
    ],
    modulePlatform: platform,
  });
  const client = new Client({ name: "describe-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client, platform);
  } finally {
    platform.unregisterServer(server);
    await client.close();
    await server.close();
  }
}

describe.skipIf(!generic)("osf_describe through the real dispatch path", () => {
  it("is listed and answers the exact per-entity schema through tools/call", async () => {
    await withServer(["Relations.All.ReadWrite"], async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("osf_describe");
      const result = await client.callTool({
        name: "osf_describe",
        arguments: { entity: "Address", operation: "create" },
      });
      expect(result.isError).toBeFalsy();
      const data = (result.structuredContent as { data: { operations: Record<string, { inputSchema: { properties: Record<string, unknown> } }> } }).data;
      expect(Object.keys(data.operations)).toEqual(["create"]);
      expect(Object.keys(data.operations.create!.inputSchema.properties).length).toBeGreaterThan(3);
    });
  });

  it("is authorized for a module as a core tool, not looked up as a stored derived definition", async () => {
    const check = "app://authorization/describe";
    const ref: { current?: ModulePlatformRuntime } = {};
    const module: RuntimeModule = {
      name: "describe-probe",
      mcp: {
        resources: async () => [{ uri: check, name: "describe-check" }],
        readResource: async (uri, ctx) => ({
          contents: [{
            uri,
            text: JSON.stringify(
              await ref.current!.services.mcp.authorize(ctx.session, {
                action: "call",
                subject: { kind: "tool", name: "osf_describe" },
              }),
            ),
          }],
        }),
      },
    };
    // No database behind this server: a lookup of a stored derived
    // definition — the path the name took while classified "derived" —
    // would fail here instead of answering.
    await withServer(["Relations.All.ReadWrite"], async (client, platform) => {
      ref.current = platform;
      const result = await client.readResource({ uri: check });
      const content = result.contents[0];
      expect(content && "text" in content ? JSON.parse(content.text) : undefined).toEqual({ allowed: true });
    }, module);
  });
});
