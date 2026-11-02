// SPDX-License-Identifier: BUSL-1.1
import { emptyCatalogDatabase } from "../../db/__tests__/empty-catalog-db.js";
import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import accounts from "../../accounts/runtime.js";
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { catalog, tablesByName } from "../catalog.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";
import { toolsForSession } from "../session-projection.js";
import { schemaUsesArtifactUpload } from "../handoff-config.js";

test("MCP server construction does not project unrelated output schemas to discover upload support", async () => {
  const tool = catalog.tools.find(entry => entry.operationId === "Task.list")!;
  expect(tool).toBeDefined();
  const session = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
    roles: ["Tasks.All.Read"], groups: [], scope: "self" as const, credential: "bearer" as const };
  const visible = toolsForSession(session, tablesByName());
  expect(visible.some(entry => entry.tool === tool)).toBe(true);
  expect(visible.some(entry => schemaUsesArtifactUpload(entry.tool.inputSchema))).toBe(false);
  const descriptor = Object.getOwnPropertyDescriptor(tool, "outputSchema")!;
  let outputReads = 0;
  Object.defineProperty(tool, "outputSchema", { configurable: true, enumerable: true,
    get() { outputReads++; return descriptor.value; },
  });
  const db = emptyCatalogDatabase();
  const platform = new ModulePlatformRuntime(db);
  let server: ReturnType<typeof __buildGeneratedMcpServerForTests> | undefined;
  try {
    server = __buildGeneratedMcpServerForTests({ db, modulePlatform: platform,
      session,
      modules: [accounts, documents as unknown as RuntimeModule, versioning as unknown as RuntimeModule,
        { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }),
      // The entity now carries a second canonical Operation; a module that
      // supplies any handler must supply all of them.
      deliverToNotebook: () => { throw new Error("This test does not exercise Notebook.deliver."); } } },
        { name: "upload-fixture", artifactStorage: {} as never }],
    });
    expect(outputReads).toBe(0);
  } finally {
    Object.defineProperty(tool, "outputSchema", descriptor);
    if (server) { platform.unregisterServer(server); await server.close(); }
  }
});

test("an upload-capable session still receives the private upload tool through MCP", async () => {
  const db = emptyCatalogDatabase();
  const platform = new ModulePlatformRuntime(db);
  const server = __buildGeneratedMcpServerForTests({ db, modulePlatform: platform,
    session: { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
      roles: ["CaseFile.All.ReadWrite"], groups: [], scope: "self", credential: "bearer" },
    modules: [accounts, documents as unknown as RuntimeModule, versioning as unknown as RuntimeModule,
      { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }),
      // The entity now carries a second canonical Operation; a module that
      // supplies any handler must supply all of them.
      deliverToNotebook: () => { throw new Error("This test does not exercise Notebook.deliver."); } } },
      { name: "upload-fixture", artifactStorage: {} as never }],
  });
  const client = new Client({ name: "upload-projection-proof", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    expect((await client.listTools()).tools.some(tool => tool.name === "upload_document_file")).toBe(true);
  } finally {
    platform.unregisterServer(server); await client.close(); await server.close();
  }
});
