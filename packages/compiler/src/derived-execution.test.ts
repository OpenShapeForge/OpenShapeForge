// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { resolveDerivedExecution, type AuthoredDerivedExecution } from "./derived-execution.js";
import {
  BINDING_FIELDS,
  catalogInput,
  catalogInputs,
  contract,
  executionBase,
  field,
  ownedBindings,
  ownerInput,
  related,
} from "./derived-execution.fixtures.js";

const relationExecution = {
  ...executionBase,
  bindingsRelation: "capabilityBindings",
};

describe("resolveDerivedExecution", () => {
  it("resolves bindingsRelation to the owned collection's target, table and parent FK", () => {
    const owner = ownerInput(relationExecution);
    expect(
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        relationExecution,
        "derivedTools.execution",
      ),
    ).toEqual({
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

  it("refuses leftover bindingsField, naming the entity", () => {
    const owner = ownerInput({
      ...relationExecution,
      bindingsField: "steps",
    } as typeof relationExecution);
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        {
          ...relationExecution,
          bindingsField: "steps",
        } as typeof relationExecution,
        "derivedTools.execution",
      ),
    ).toThrow(
      /derivedTools.execution on entity "Service" no longer accepts bindingsField/,
    );
  });

  it("refuses a missing bindingsRelation, naming the entity", () => {
    const owner = ownerInput(executionBase as AuthoredDerivedExecution);
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        executionBase as AuthoredDerivedExecution,
        "derivedTools.execution",
      ),
    ).toThrow(
      /derivedTools.execution on entity "Service" needs bindingsRelation \(owned collection\)/,
    );
  });

  it("refuses a bindingsRelation whose target is missing a required field", () => {
    const owner = ownerInput(relationExecution);
    const withoutWhen = BINDING_FIELDS.filter((entry) => entry.key !== "when");
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner, withoutWhen),
        owner,
        relationExecution,
        "derivedTools.execution",
      ),
    ).toThrow(
      /derivedTools.execution on entity "Service": binding row is missing required field "when"/,
    );
  });

  it("refuses a bindingsRelation that is not an owned hasMany collection", () => {
    const owner = ownerInput(relationExecution, [
      { ...ownedBindings, ownership: "reference" },
    ]);
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        relationExecution,
        "derivedTools.execution",
      ),
    ).toThrow(
      /bindingsRelation "capabilityBindings" on entity "Service" does not name an owned hasMany collection/,
    );
  });

  it("refuses a binding order that is not a required integer", () => {
    const owner = ownerInput(relationExecution);
    const fields = BINDING_FIELDS.map((entry) =>
      entry.key === "order" ? field({ key: "order" }) : entry,
    );
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner, fields),
        owner,
        relationExecution,
        "derivedTools.execution",
      ),
    ).toThrow(/binding field "order" must be integer/);
  });

  it("refuses an operationRef that is not a belongsTo relationship with a foreign key", () => {
    const owner = ownerInput(relationExecution);
    const fields = BINDING_FIELDS.map((entry) =>
      entry.key === "capabilityId" ? field({ key: "capabilityId" }) : entry,
    );
    expect(() =>
      resolveDerivedExecution(
        [
          owner,
          catalogInput(
            contract({
              name: "ServiceCapabilityBinding",
              fields,
              relationships: [],
            }),
            "integration.service_capability_bindings",
          ),
          related("Capability", "integration.capabilities", [
            field({ key: "name" }),
            field({ key: "adapterId" }),
          ]),
          related("Adapter", "integration.adapters"),
          related("Connection", "integration.connections", [
            field({ key: "adapterId" }),
            field({ key: "values" }),
          ]),
        ],
        owner,
        relationExecution,
        "derivedTools.execution",
      ),
    ).toThrow(
      /binding field "capabilityId" must be a belongsTo relationship to "Capability"/,
    );
  });

  it("refuses a parentRef that is not a belongsTo to the owner with a foreign key", () => {
    const owner = ownerInput(relationExecution);
    const fields = BINDING_FIELDS.map((entry) =>
      entry.key === "serviceId" ? field({ key: "serviceId" }) : entry,
    );
    expect(() =>
      resolveDerivedExecution(
        [
          owner,
          catalogInput(
            contract({
              name: "ServiceCapabilityBinding",
              fields,
              relationships: [],
            }),
            "integration.service_capability_bindings",
          ),
          related("Capability", "integration.capabilities", [
            field({ key: "name" }),
            field({ key: "adapterId" }),
          ]),
          related("Adapter", "integration.adapters"),
          related("Connection", "integration.connections", [
            field({ key: "adapterId" }),
            field({ key: "values" }),
          ]),
        ],
        owner,
        relationExecution,
        "derivedTools.execution",
      ),
    ).toThrow(
      /binding field "serviceId" must be a belongsTo relationship to "Service"/,
    );
  });
});
