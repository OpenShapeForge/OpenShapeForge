// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import accounts from "../../accounts/runtime.js";
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { catalog } from "../catalog.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";

test("MCP server construction does not project unrelated output schemas to discover upload support", async () => {
  const tool = catalog.tools.find(entry => entry.operationId === "Task.list")!;
  expect(tool).toBeDefined();
  const descriptor = Object.getOwnPropertyDescriptor(tool, "outputSchema")!;
  let outputReads = 0;
  Object.defineProperty(tool, "outputSchema", { configurable: true, enumerable: true,
    get() { outputReads++; return descriptor.value; },
  });
  const db = {} as OpenShapeForgeDatabase;
  const platform = new ModulePlatformRuntime(db);
  let server: ReturnType<typeof __buildGeneratedMcpServerForTests> | undefined;
  try {
    server = __buildGeneratedMcpServerForTests({ db, modulePlatform: platform,
      session: { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
        roles: ["Tasks.All.Read"], groups: [], scope: "self", credential: "bearer" },
      modules: [accounts, documents as unknown as RuntimeModule, versioning as unknown as RuntimeModule,
        { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }) } },
        { name: "upload-fixture", artifactStorage: {} as never }],
    });
    expect(outputReads).toBe(0);
  } finally {
    Object.defineProperty(tool, "outputSchema", descriptor);
    if (server) { platform.unregisterServer(server); await server.close(); }
  }
});
