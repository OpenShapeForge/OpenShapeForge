// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { buildEntityOperations } from "./authoring/compiler/entity-operations.js";
import type {
  CompiledEntityContract,
  CompiledField,
  CompiledRelationship,
} from "./authoring/types.js";
import {
  EXECUTION_BINDING_ROW_FIELDS,
  resolveDerivedExecution,
  type AuthoredDerivedExecution,
  type DerivedExecutionCatalogInput,
} from "./derived-execution.js";
import { buildMcpCatalog, type McpCatalogInput } from "./generate-mcp.js";
import type { PluginExecutionCompatibility } from "./plugins.js";

const field = (
  overrides: Partial<CompiledField> & { key: string },
): CompiledField =>
  ({
    baseType: "string",
    osfType: overrides.baseType ?? "string",
    cardinality: "single",
    required: false,
    label: { en: overrides.key },
    render: { component: "Input" },
    ...overrides,
  }) as CompiledField;

const contract = (overrides: {
  name: string;
  fields?: CompiledField[];
  relationships?: CompiledRelationship[];
  mcp?: CompiledEntityContract["mcp"];
}): CompiledEntityContract => {
  const compiled = {
    authoringVersion: 3 as const,
    contractVersion: 2,
    kind: "compiledEntityContract" as const,
    entity: {
      id: `demo.${overrides.name}`,
      name: overrides.name,
      module: "demo",
      title: overrides.name,
      domains: ["demo"],
    },
    storage: {
      table: overrides.name.toLowerCase(),
      columns: (overrides.fields ?? [field({ key: "name" })]).map((entry) => ({
        field: entry.key,
        column: entry.key,
        type: "text" as const,
        nullable: !entry.required,
        storageClass: "core" as const,
      })),
    },
    model: {
      fields: overrides.fields ?? [field({ key: "name" })],
      relationships: overrides.relationships ?? [],
    },
    crud: {
      operations: {
        list: true,
        get: true,
        create: true,
        update: true,
        delete: true,
      },
    },
    graphql: {} as never,
    mcp: overrides.mcp,
    authorization: {
      entitySlug: overrides.name.toLowerCase(),
      roles: { read: ["viewer"], create: [], update: [], delete: [] },
      compositeRoles: [],
      fieldAuthorizations: [],
      profileAuthorizations: {},
    },
    views: {},
    profiles: {},
    entityOperations: {},
  } as unknown as CompiledEntityContract;
  compiled.entityOperations = buildEntityOperations(compiled);
  return compiled;
};

const catalogInput = (
  compiled: CompiledEntityContract,
  table: string,
): DerivedExecutionCatalogInput & McpCatalogInput => ({
  slug: compiled.entity.name.toLowerCase(),
  contract: compiled,
  table,
});

const BINDING_FIELDS = [
  field({ key: "serviceId" }),
  field({ key: "capabilityId" }),
  ...EXECUTION_BINDING_ROW_FIELDS.map((key) => field({ key })),
];

const related = (name: string, table: string, fields?: CompiledField[]) =>
  catalogInput(contract({ name, fields: fields ?? [field({ key: "name" })] }), table);

const executionBase: AuthoredDerivedExecution = {
  operationRef: "capabilityId",
  operationEntity: "Capability",
  providerRef: "adapterId",
  providerEntity: "Adapter",
  connectionEntity: "Connection",
  connectionProviderRef: "adapterId",
  connectionValuesField: "values",
};

const ownedBindings: CompiledRelationship = {
  key: "capabilityBindings",
  kind: "hasMany",
  target: "ServiceCapabilityBinding",
  ownership: "owned",
  inverse: "serviceId",
  foreignKey: "service_id",
};

function ownerInput(
  execution: AuthoredDerivedExecution,
  relationships: CompiledRelationship[] = [ownedBindings],
  extraFields: CompiledField[] = [],
): McpCatalogInput {
  return catalogInput(
    contract({
      name: "Service",
      fields: [
        field({ key: "key" }),
        field({ key: "name" }),
        field({ key: "description" }),
        field({ key: "inputFields", baseType: "object", cardinality: "collection" }),
        field({ key: "version", baseType: "integer" }),
        ...extraFields,
      ],
      relationships,
      mcp: {
        toolPrefix: "service",
        tools: "dedicated",
        operations: {
          list: false,
          get: true,
          create: false,
          update: false,
          delete: false,
        },
        derivedTools: {
          roles: ["viewer"],
          keyField: "key",
          descriptionField: "description",
          inputFieldsField: "inputFields",
          versionField: "version",
          execution,
        },
      },
    }),
    "integration.services",
  );
}

function catalogInputs(owner: McpCatalogInput, bindingFields = BINDING_FIELDS) {
  return [
    owner,
    catalogInput(
      contract({
        name: "ServiceCapabilityBinding",
        fields: bindingFields,
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
  ];
}

describe("resolveDerivedExecution", () => {
  it("projects JSON bindingsField unchanged besides resolved tables", () => {
    const owner = ownerInput(
      { ...executionBase, bindingsField: "steps" },
      [],
      [field({ key: "steps", baseType: "object", cardinality: "collection" })],
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
      /derivedTools.execution on entity "Service": binding entity "ServiceCapabilityBinding" is missing required field "when"/,
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
});

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
    expect(catalog.derivedTools[0]?.execution?.bindingsField).toBeUndefined();
  });

  it("refuses execution compatibility that names both sources", () => {
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
          }),
        }],
      ),
    ).toThrow(
      /Plugin "demo" execution compatibility on entity "Service" needs exactly one of bindingsRelation \(owned collection\) or bindingsField/,
    );
  });
});
