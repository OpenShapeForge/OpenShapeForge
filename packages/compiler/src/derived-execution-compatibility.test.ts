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
