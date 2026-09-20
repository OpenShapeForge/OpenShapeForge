// SPDX-License-Identifier: BUSL-1.1
/**
 * The helpers of a derived tool a plugin registers through execution
 * compatibility (connect, dry run) are listed under their public names for
 * the audience, and the plugin's own Operation for the dry run reaches the
 * same handler through the host-operation bridge — the two things the
 * integration host lost when the helpers got public names: the listing
 * skipped compatibility entries, and the bridge no longer knew the key.
 * Runs on the compiled catalogue with one entry added, without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import documentsPluginRuntime from "@openshapeforge/documents/runtime";
import versioningPluginRuntime from "@openshapeforge/versioning/runtime";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { RuntimeModule } from "../../modules/contract.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { __registerExecutionCompatibilityForTests, __withDerivedToolEntriesForTests } from "../catalog.js";
import { __buildGeneratedMcpServerForTests } from "../generated-mcp-server.js";
import { runtimeHostOperationExecutors } from "../tool-results.js";
import { isOperationFailure, type OperationResult } from "@openshapeforge/operations";

const errorOf = (outcome: OperationResult<unknown>) => (isOperationFailure(outcome) ? outcome.error : undefined);

const AUDIENCE = ["integration_user", "integration_admin"];
const execution = {
  bindingsRelation: "capabilityBindings",
  bindingsEntity: "ServiceCapabilityBinding",
  bindingsTable: "integration.service_capability_bindings",
  parentRef: "serviceId",
  operationRef: "capabilityId",
  operationEntity: "Capability",
  operationTable: "integration.capabilities",
  providerRef: "adapterId",
  providerEntity: "Adapter",
  providerTable: "integration.adapters",
  connectionEntity: "Connection",
  connectionTable: "integration.connections",
  connectionProviderRef: "adapterId",
  connectionValuesField: "values",
};
/** A plugin's Service entry: the tools go to the audience, connect and dry run to administrators. */
const entry = {
  entity: "Service",
  table: "integration.services",
  roles: AUDIENCE,
  keyField: "key",
  descriptionField: "description",
  inputFieldsField: "inputFields",
  versionField: "version",
  connect: { name: "connect_service", description: "Sign in at the provider.", roles: ["integration_admin"] },
  dryRun: { name: "dry_run_service", description: "Compose the requests.", roles: ["integration_admin"] },
  execution,
  compatibility: {
    plugin: "osf-integration",
    providerId: "osf-integration",
    connectOperation: "osf-integration.service.connect",
    dryRunOperation: "osf-integration.service.dry-run",
  },
} as never;
/**
 * A second entry whose dry-run helper carries the public name of a plugin
 * Operation the reference catalogue lists (notebook_import, handler loaded
 * by the test modules): a call under that name must reach the helper, not
 * the Operation handler that would only bridge back.
 */
const colliding = {
  ...(entry as object),
  entity: "OtherService",
  table: "integration.other_services",
  roles: ["Organization.All.ReadWrite"],
  connect: undefined,
  dryRun: { name: "notebook_import", description: "Compose.", roles: ["Organization.All.ReadWrite"] },
  compatibility: { plugin: "osf-integration", providerId: "other", dryRunOperation: "notebook.import" },
} as never;
const bridge = {
  plugin: "osf-integration",
  operation: "osf-integration.service.dry-run",
  toolName: "dry_run_service",
  auth: { mode: "session" as const, roles: ["integration_admin"] },
};

const session = (...roles: string[]) =>
  ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    roles,
    groups: [],
    scope: "self",
    credential: "trusted-context",
  }) as never;

const restore: (() => void)[] = [];
beforeAll(() => {
  restore.push(__withDerivedToolEntriesForTests([entry, colliding]));
  restore.push(__registerExecutionCompatibilityForTests(bridge));
});
afterAll(() => {
  for (const undo of restore.splice(0)) undo();
});

async function withServer<T>(roles: string[], run: (client: Client, server: ReturnType<typeof __buildGeneratedMcpServerForTests>) => Promise<T>): Promise<T> {
  const db = {} as OpenShapeForgeDatabase;
  const platform = new ModulePlatformRuntime(db);
  const server = __buildGeneratedMcpServerForTests({
    db,
    session: session(...roles),
    modules: [
      documentsPluginRuntime as unknown as RuntimeModule,
      versioningPluginRuntime as unknown as RuntimeModule,
      { name: "notebook", operationHandlers: { importNotebook: async () => ({ value: undefined }) } },
    ],
    modulePlatform: platform,
    operationToolProjection: { mode: "searchable", search: "osf_search_operations", execute: "osf_execute_operation" },
  });
  const client = new Client({ name: "compatibility-helpers-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client, server);
  } finally {
    platform.unregisterServer(server);
    await client.close();
    await server.close();
  }
}

describe("execution compatibility helpers", () => {
  it("lists connect and dry run under their public names to the audience that holds their roles", async () => {
    await withServer(["integration_admin"], async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("connect_service");
      expect(names).toContain("dry_run_service");
      expect(names.filter((name) => name === "dry_run_service")).toHaveLength(1);
    });
    // In the audience, but without the roles of the connect and dry-run
    // Operations: the tools' user, not the organization's administrator.
    await withServer(["integration_user"], async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("connect_service");
      expect(names).not.toContain("dry_run_service");
      for (const name of ["connect_service", "dry_run_service"]) {
        const result = await client.callTool({ name, arguments: { tool: "x" } });
        expect(result.isError).toBe(true);
        expect(String((result.content as { text?: string }[])[0]?.text)).toMatch(/^NOT_FOUND/);
      }
    });
    await withServer(["Relations.All.Read"], async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("connect_service");
      expect(names).not.toContain("dry_run_service");
    });
  });

  it("dispatches a helper whose public name is also a listed Operation's to the helper", async () => {
    await withServer(["Organization.All.ReadWrite"], async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.filter((name) => name === "notebook_import")).toHaveLength(1);
      const result = await client.callTool({ name: "notebook_import", arguments: {} });
      // The dry-run helper's own validation, not the notebook handler's answer.
      expect(result.isError).toBe(true);
      expect(String((result.content as { text?: string }[])[0]?.text)).toMatch(/^VALIDATION: Argument "tool" is required/);
    });
  });

  it("reaches the dry-run handler through the host-operation bridge under the Operation key", async () => {
    await withServer(["integration_admin"], async (_client, server) => {
      const execute = runtimeHostOperationExecutors.get(server)!;
      const outcome = await execute(
        { operation: "osf-integration.service.dry-run", input: {} },
        "request-1",
        undefined,
        undefined,
      );
      // Dispatched to dry_run_service: its own validation answers, not the
      // bridge's "host Operation is unavailable".
      expect(errorOf(outcome)?.code).toBe("VALIDATION");
      expect(errorOf(outcome)?.message).toContain('"tool" is required');
    });
    await withServer(["integration_user"], async (_client, server) => {
      const outcome = await runtimeHostOperationExecutors.get(server)!(
        { operation: "osf-integration.service.dry-run", input: {} },
        "request-2",
        undefined,
        undefined,
      );
      expect(errorOf(outcome)?.code).toBe("OPERATION_NOT_FOUND");
    });
  });
});
