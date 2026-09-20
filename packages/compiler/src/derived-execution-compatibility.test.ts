// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { AuthoredDerivedExecution } from "./derived-execution.js";
import { advertisedToolSizes, buildMcpCatalog, selectOperationToolProjection } from "./generate-mcp.js";
import type { CompiledPluginOperation, PluginExecutionCompatibility } from "./plugins.js";
import {
  catalogInputs,
  executionBase,
  ownerInput,
} from "./derived-execution.fixtures.js";

describe("buildMcpCatalog execution compatibility", () => {
  const compatibility = (
    execution: AuthoredDerivedExecution,
  ): PluginExecutionCompatibility => ({
    version: 1,
    records: [
      {
        providerId: "demo.service",
        entity: "Service",
        keyField: "key",
        descriptionField: "description",
        inputFieldsField: "inputFields",
        versionField: "version",
        execution,
      },
    ],
  });

  it("projects a relation binding source from a plugin execution compatibility record", () => {
    const owner = ownerInput({
      ...executionBase,
      bindingsRelation: "capabilityBindings",
    });
    owner.contract.mcp = {
      toolPrefix: "service",
      tools: "dedicated",
      operations: {
        list: false,
        get: true,
        create: false,
        update: false,
        delete: false,
      },
    };
    const catalog = buildMcpCatalog(
      catalogInputs(owner),
      "test",
      {},
      [],
      [{ plugin: "demo", contribution: compatibility({
        ...executionBase,
        bindingsRelation: "capabilityBindings",
      }) }],
    );
    expect(catalog.derivedTools[0]?.execution).toEqual({
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
    });
  });

  const serviceOwner = () => {
    const owner = ownerInput({ ...executionBase, bindingsRelation: "capabilityBindings" });
    owner.contract.mcp = {
      toolPrefix: "service",
      tools: "dedicated",
      operations: { list: false, get: true, create: false, update: false, delete: false },
    };
    return owner;
  };
  const withAudience = (audience?: string[]) => {
    const contribution = compatibility({ ...executionBase, bindingsRelation: "capabilityBindings" });
    if (audience) contribution.records![0]!.audience = audience;
    return [{ plugin: "demo", contribution }];
  };

  it("gives the derived tools the definition entity's read roles when no audience is named", () => {
    const owner = serviceOwner();
    const readRoles = owner.contract.entityOperations.get!.authorization.roles;
    expect(readRoles.length).toBeGreaterThan(0);
    const catalog = buildMcpCatalog(catalogInputs(owner), "test", {}, [], withAudience(), undefined, [], new Set(readRoles));
    expect(catalog.derivedTools[0]?.roles).toEqual([...readRoles]);
  });

  it("gives the derived tools the record's audience when one is named, beyond the read roles", () => {
    // Users who may call the tools without reading the definitions: the
    // audience is wider than the entity's read roles, which stay as they are.
    const catalog = buildMcpCatalog(
      catalogInputs(serviceOwner()),
      "test",
      {},
      [],
      withAudience(["integration_user", "integration_admin"]),
      undefined,
      [],
      new Set(["integration_user", "integration_admin", "Integrations.All.Read"]),
    );
    expect(catalog.derivedTools[0]?.roles).toEqual(["integration_user", "integration_admin"]);
  });

  it("fails closed on an authored audience when the build has no realm role set", () => {
    expect(() =>
      buildMcpCatalog(catalogInputs(serviceOwner()), "test", {}, [], withAudience(["integration_user"])),
    ).toThrow(/declares an audience, but this build has no realm role set to validate it against/);
    // Nothing to validate: the role set may be omitted.
    expect(() => buildMcpCatalog(catalogInputs(serviceOwner()), "test", {}, [], withAudience())).not.toThrow();
  });

  it("refuses an audience role the realm does not declare, and an empty audience", () => {
    expect(() =>
      buildMcpCatalog(
        catalogInputs(serviceOwner()),
        "test",
        {},
        [],
        withAudience(["integration_user", "integration_ghost"]),
        undefined,
        [],
        new Set(["integration_user", "integration_admin"]),
      ),
    ).toThrow(/record "Service" audience names "integration_ghost", which the realm does not declare/);
    expect(() =>
      buildMcpCatalog(catalogInputs(serviceOwner()), "test", {}, [], withAudience([]), undefined, [], new Set()),
    ).toThrow(/declares an empty audience/);
  });

  it("registers the connect and dry-run Operations as bridges under their public tool names", () => {
    // The plugin's canonical Operation is implemented by the core tool of
    // the same public name: the listing offers connect_service and
    // dry_run_service to the audience, and the Operation runtime finds the
    // bridge under the Operation key — not an osf_internal_* name.
    const helper = (key: string, name: string): CompiledPluginOperation => ({
      key,
      id: key,
      intent: "invoke",
      plugin: "demo",
      title: name,
      description: `${name}.`,
      handler: name,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      errors: [],
      auth: { mode: "session", roles: ["integration_admin"] },
      tenancy: { mode: "required" },
      idempotency: { mode: "none" },
      effects: { data: "read", external: "read" },
      transports: {
        rest: { method: "POST", path: `/api/demo/${name}`, response: { status: 200, kind: "json" } },
        mcp: { enabled: true, name },
        graphql: { enabled: false, reason: "Not exposed in this fixture." },
        typescript: { enabled: false, reason: "Not exposed in this fixture." },
      },
    });
    const contribution = compatibility({ ...executionBase, bindingsRelation: "capabilityBindings" });
    contribution.records![0]!.connectOperation = "demo.service.connect";
    contribution.records![0]!.dryRunOperation = "demo.service.dry-run";
    const catalog = buildMcpCatalog(
      catalogInputs(serviceOwner()),
      "test",
      {},
      [helper("demo.service.connect", "connect_service"), helper("demo.service.dry-run", "dry_run_service")],
      [{ plugin: "demo", contribution }],
    );
    expect(catalog.derivedTools[0]?.connect?.name).toBe("connect_service");
    expect(catalog.derivedTools[0]?.dryRun?.name).toBe("dry_run_service");
    expect(catalog.executionCompatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ plugin: "demo", operation: "demo.service.connect", toolName: "connect_service" }),
      expect.objectContaining({ plugin: "demo", operation: "demo.service.dry-run", toolName: "dry_run_service" }),
    ]));
    expect(catalog.executionCompatibility.filter((entry) => entry.operation === "demo.service.dry-run")).toHaveLength(1);

    // The byte budget counts the helpers the runtime lists: in the searchable
    // projection under their public names; in the dedicated projection the
    // Operation tools of the same names are counted instead, once.
    const searchable = advertisedToolSizes({
      tools: catalog.tools,
      entities: catalog.entities,
      operationTools: catalog.operationTools,
      projection: "searchable",
      derivedTools: catalog.derivedTools,
    }).map((size) => size.name);
    expect(searchable).toContain("connect_service");
    expect(searchable).toContain("dry_run_service");
    const dedicated = advertisedToolSizes({
      tools: catalog.tools,
      entities: catalog.entities,
      operationTools: catalog.operationTools,
      projection: "dedicated",
      derivedTools: catalog.derivedTools,
    }).map((size) => size.name);
    expect(dedicated.filter((name) => name === "connect_service")).toHaveLength(1);
    expect(dedicated.filter((name) => name === "dry_run_service")).toHaveLength(1);
  });

  it("counts compatibility helpers once against the dedicated tool cap", () => {
    // Two helpers plus their two Operations: 2 dedicated-style tools and 0
    // further Operations, so a cap of 2 still lists everything dedicated,
    // a cap of 1 is refused on the helpers alone.
    expect(selectOperationToolProjection(2, 0, 2)).toBe("dedicated");
    expect(() => selectOperationToolProjection(2, 0, 1)).toThrow(/over the 1 limit/);
  });

  it("refuses leftover bindingsField on execution compatibility", () => {
    const owner = ownerInput({
      ...executionBase,
      bindingsRelation: "capabilityBindings",
    });
    owner.contract.mcp = {
      toolPrefix: "service",
      tools: "dedicated",
      operations: {
        list: false,
        get: true,
        create: false,
        update: false,
        delete: false,
      },
    };
    expect(() =>
      buildMcpCatalog(
        catalogInputs(owner),
        "test",
        {},
        [],
        [{
          plugin: "demo",
          contribution: compatibility({
            ...executionBase,
            bindingsField: "key",
            bindingsRelation: "capabilityBindings",
          } as AuthoredDerivedExecution),
        }],
      ),
    ).toThrow(
      /Plugin "demo" execution compatibility on entity "Service" no longer accepts bindingsField/,
    );
  });
});
