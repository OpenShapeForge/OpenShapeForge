// SPDX-License-Identifier: BUSL-1.1
import { buildEntityOperations } from "./authoring/compiler/entity-operations.js";
import type {
  CompiledEntityContract,
  CompiledField,
  CompiledRelationship,
} from "./authoring/types.js";
import type {
  AuthoredDerivedExecution,
  DerivedExecutionCatalogInput,
} from "./derived-execution.js";
import type { McpCatalogInput } from "./generate-mcp.js";

export const field = (
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

export const contract = (overrides: {
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

export const catalogInput = (
  compiled: CompiledEntityContract,
  table: string,
): DerivedExecutionCatalogInput & McpCatalogInput => ({
  slug: compiled.entity.name.toLowerCase(),
  contract: compiled,
  table,
});

export const BINDING_FIELDS = [
  field({
    key: "serviceId",
    osfType: "Service",
    relationship: {
      kind: "belongsTo",
      target: "Service",
      foreignKey: "service_id",
    },
  }),
  field({
    key: "capabilityId",
    osfType: "Capability",
    relationship: {
      kind: "belongsTo",
      target: "Capability",
      foreignKey: "capability_id",
    },
  }),
  field({ key: "order", baseType: "integer", required: true }),
  field({ key: "optional", baseType: "boolean" }),
  field({ key: "when", baseType: "object" }),
  field({ key: "inputMapping", baseType: "object", cardinality: "collection" }),
  field({ key: "outputMapping", baseType: "object", cardinality: "collection" }),
  field({ key: "forEach", baseType: "object" }),
];

const parentRelationship: CompiledRelationship = {
  key: "serviceId",
  kind: "belongsTo",
  target: "Service",
  ownership: "reference",
  foreignKey: "service_id",
};

const operationRelationship: CompiledRelationship = {
  key: "capabilityId",
  kind: "belongsTo",
  target: "Capability",
  ownership: "reference",
  foreignKey: "capability_id",
};

export const related = (name: string, table: string, fields?: CompiledField[]) =>
  catalogInput(contract({ name, fields: fields ?? [field({ key: "name" })] }), table);

export const executionBase = {
  operationRef: "capabilityId",
  operationEntity: "Capability",
  providerRef: "adapterId",
  providerEntity: "Adapter",
  connectionEntity: "Connection",
  connectionProviderRef: "adapterId",
  connectionValuesField: "values",
};

export const ownedBindings: CompiledRelationship = {
  key: "capabilityBindings",
  kind: "hasMany",
  target: "ServiceCapabilityBinding",
  ownership: "owned",
  inverse: "serviceId",
  foreignKey: "service_id",
};

export function ownerInput(
  execution: Omit<AuthoredDerivedExecution, "bindingsRelation"> & {
    bindingsRelation?: string;
  },
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
          execution: execution as AuthoredDerivedExecution,
        },
      },
    }),
    "integration.services",
  );
}

export function catalogInputs(owner: McpCatalogInput, bindingFields = BINDING_FIELDS) {
  return [
    owner,
    catalogInput(
      contract({
        name: "ServiceCapabilityBinding",
        fields: bindingFields,
        relationships: [parentRelationship, operationRelationship],
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
