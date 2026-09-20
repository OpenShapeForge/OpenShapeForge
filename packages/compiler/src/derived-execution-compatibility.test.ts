// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { AuthoredDerivedExecution } from "./derived-execution.js";
import { buildMcpCatalog } from "./generate-mcp.js";
import type { PluginExecutionCompatibility } from "./plugins.js";
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
