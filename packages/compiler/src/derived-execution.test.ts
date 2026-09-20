// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { resolveDerivedExecution } from "./derived-execution.js";
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

describe("resolveDerivedExecution", () => {
  it("projects JSON bindingsField unchanged besides resolved tables", () => {
    const owner = ownerInput(
      { ...executionBase, bindingsField: "steps" },
      [],
    );
    expect(
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        { ...executionBase, bindingsField: "steps" },
        "derivedTools.execution",
      ),
    ).toEqual({
      bindingsField: "steps",
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

  it("resolves bindingsRelation to the owned collection's target, table and parent FK", () => {
    const owner = ownerInput({ ...executionBase, bindingsRelation: "capabilityBindings" });
    expect(
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        { ...executionBase, bindingsRelation: "capabilityBindings" },
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

  it("refuses both bindingsField and bindingsRelation, naming the entity", () => {
    const owner = ownerInput({
      ...executionBase,
      bindingsField: "steps",
      bindingsRelation: "capabilityBindings",
    });
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        {
          ...executionBase,
          bindingsField: "steps",
          bindingsRelation: "capabilityBindings",
        },
        "derivedTools.execution",
      ),
    ).toThrow(
      /derivedTools.execution on entity "Service" needs exactly one of bindingsRelation \(owned collection\) or bindingsField/,
    );
  });

  it("refuses neither bindingsField nor bindingsRelation, naming the entity", () => {
    const owner = ownerInput(executionBase);
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        executionBase,
        "derivedTools.execution",
      ),
    ).toThrow(
      /derivedTools.execution on entity "Service" needs exactly one of bindingsRelation \(owned collection\) or bindingsField/,
    );
  });

  it("refuses a bindingsRelation whose target is missing a required field", () => {
    const owner = ownerInput({
      ...executionBase,
      bindingsRelation: "capabilityBindings",
    });
    const withoutWhen = BINDING_FIELDS.filter((entry) => entry.key !== "when");
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner, withoutWhen),
        owner,
        { ...executionBase, bindingsRelation: "capabilityBindings" },
        "derivedTools.execution",
      ),
    ).toThrow(
      /derivedTools.execution on entity "Service": binding row is missing required field "when"/,
    );
  });

  it("refuses a bindingsRelation that is not an owned hasMany collection", () => {
    const owner = ownerInput(
      { ...executionBase, bindingsRelation: "capabilityBindings" },
      [{ ...ownedBindings, ownership: "reference" }],
    );
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        { ...executionBase, bindingsRelation: "capabilityBindings" },
        "derivedTools.execution",
      ),
    ).toThrow(
      /bindingsRelation "capabilityBindings" on entity "Service" does not name an owned hasMany collection/,
    );
  });

  it("refuses a scalar bindingsField", () => {
    const owner = ownerInput(
      { ...executionBase, bindingsField: "key" },
      [],
    );
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner),
        owner,
        { ...executionBase, bindingsField: "key" },
        "derivedTools.execution",
      ),
    ).toThrow(
      /bindingsField "key" on entity "Service" does not name an object collection/,
    );
  });

  it("refuses a binding order that is not a required integer", () => {
    const owner = ownerInput({
      ...executionBase,
      bindingsRelation: "capabilityBindings",
    });
    const fields = BINDING_FIELDS.map((entry) =>
      entry.key === "order" ? field({ key: "order" }) : entry,
    );
    expect(() =>
      resolveDerivedExecution(
        catalogInputs(owner, fields),
        owner,
        { ...executionBase, bindingsRelation: "capabilityBindings" },
        "derivedTools.execution",
      ),
    ).toThrow(/binding field "order" must be integer/);
  });

  it("refuses an operationRef that is not a belongsTo relationship with a foreign key", () => {
    const owner = ownerInput({
      ...executionBase,
      bindingsRelation: "capabilityBindings",
    });
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
        { ...executionBase, bindingsRelation: "capabilityBindings" },
        "derivedTools.execution",
      ),
    ).toThrow(
      /binding field "capabilityId" must be a belongsTo relationship to "Capability"/,
    );
  });
});
