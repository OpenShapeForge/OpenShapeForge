// SPDX-License-Identifier: BUSL-1.1
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, test } from "bun:test";
import type {
  CompiledEntityContract,
  CompiledField,
} from "./authoring/types.js";
import { buildEntityOperations } from "./authoring/compiler/entity-operations.js";
import { entityOperationJsonSchemas } from "./entity-operation-json-schema.js";
import { buildMcpCatalog } from "./generate-mcp.js";

function field(
  key: string,
  overrides: Partial<CompiledField> = {},
): CompiledField {
  return {
    key,
    valueType: "string",
    cardinality: "single",
    required: false,
    label: { en: key },
    render: { component: "Input" },
    ...overrides,
  };
}

const entity = { id: "example.WorkItem", name: "WorkItem" };
const authorization = {
  entitySlug: "work-item",
  roles: {
    read: ["WorkItems.Read"],
    create: ["WorkItems.Write"],
    update: ["WorkItems.Write"],
    delete: ["WorkItems.Delete"],
  },
  compositeRoles: [],
  fieldAuthorizations: [],
  profileAuthorizations: {},
};
const entityOperations = buildEntityOperations({
  entity,
  authorization,
  crud: {
    operations: { list: true, get: true, create: true, update: true, delete: true },
  },
});
entityOperations.create!.interaction.secureInput = {
  type: "secureInput",
  sourceField: "adapterId",
  sourceEntity: "Adapter",
  definitionsField: "configurationFields",
  into: "secretValues",
};
entityOperations.update!.concurrency = {
  version: { mode: "required", field: "updatedAt" },
  editLease: { mode: "required", expiresAfterInactivity: "PT7M" },
};
entityOperations.delete!.concurrency = entityOperations.update!.concurrency;
entityOperations.delete!.interaction.confirmation = {
  mode: "challenge",
  challenge: {
    kind: "type-current-field",
    field: "title",
    issuedBy: "server",
    bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
    expiresAfter: "PT5M",
    singleUse: true,
  },
};

const contract = {
  authoringVersion: 2,
  entity: { ...entity, title: "Work item", domains: [] },
  model: {
    fields: [
      field("title", {
        required: true,
        validation: { minLength: 2, maxLength: 80 },
      }),
      field("stableCode", { immutable: true }),
      field("reviewedAt", { writtenBy: ["example.work-item.review"] }),
      field("secretValues", { valueType: "object" }),
    ],
    relationships: [{
      key: "project",
      kind: "belongsTo",
      target: "Project",
      foreignKey: "project_id",
    }],
  },
  storage: {
    columns: [
      { field: "title", column: "title", type: "text", nullable: false, storageClass: "core" },
      { field: "stableCode", column: "stable_code", type: "text", nullable: true, storageClass: "core" },
      { field: "reviewedAt", column: "reviewed_at", type: "timestamptz", nullable: true, storageClass: "core" },
      { field: "secretValues", column: "secret_values", type: "jsonb", nullable: true, storageClass: "core" },
      { field: "projectId", column: "project_id", type: "uuid", nullable: false, storageClass: "core" },
    ],
  },
  mcp: {
    toolPrefix: "work_item",
    tools: "dedicated",
    operations: { list: true, get: true, create: true, update: true, delete: true },
    elicitOnCreate: {
      sourceField: "adapterId",
      sourceEntity: "Adapter",
      definitionsField: "configurationFields",
      into: "secretValues",
    },
  },
  entityOperations,
} as unknown as CompiledEntityContract;

const contracts = [
  contract,
  {
    entity: { id: "example.Project", name: "Project", title: "Project" },
    model: { fields: [], relationships: [] },
    storage: { columns: [] },
    entityOperations: {},
  } as unknown as CompiledEntityContract,
];

const adapterContract = {
  entity: { id: "example.Adapter", name: "Adapter", title: "Adapter" },
  model: {
    fields: [field("configurationFields", { valueType: "object" })],
    relationships: [],
  },
  storage: {
    columns: [{
      field: "configurationFields",
      column: "configuration_fields",
      type: "jsonb",
      nullable: true,
      storageClass: "core",
    }],
  },
  entityOperations: {},
} as unknown as CompiledEntityContract;

describe("canonical entity Operation JSON Schemas", () => {
  test("uses the executor values envelope and preserves authored field eligibility", () => {
    const create = entityOperationJsonSchemas(
      contract,
      entityOperations.create!,
      contracts,
      {},
    );
    const createProperties = create.inputSchema.properties as Record<string, any>;
    expect(create.inputSchema.required).toEqual(["values"]);
    expect(createProperties.values.required).toEqual(["title", "projectId"]);
    expect(createProperties.values.properties.title).toMatchObject({
      type: "string",
      minLength: 2,
      maxLength: 80,
    });
    expect(Object.keys(createProperties.values.properties)).toEqual([
      "title",
      "stableCode",
      "projectId",
    ]);

    const update = entityOperationJsonSchemas(
      contract,
      entityOperations.update!,
      contracts,
      {},
    );
    const updateProperties = update.inputSchema.properties as Record<string, any>;
    expect(update.inputSchema.required).toEqual([
      "id",
      "values",
      "expectedVersion",
      "leaseToken",
    ]);
    expect(Object.keys(updateProperties.values.properties)).toEqual([
      "title",
      "projectId",
    ]);
    expect(updateProperties.values.required).toBeUndefined();
  });

  test("projects read paging, challenge controls and camel-case result data", () => {
    const list = entityOperationJsonSchemas(
      contract,
      entityOperations.list!,
      contracts,
      {},
    );
    expect(Object.keys(list.inputSchema.properties as object)).toEqual([
      "limit",
      "cursor",
      "filter",
      "sort",
      "includeTotalCount",
    ]);
    expect(
      ((list.inputSchema.properties as Record<string, any>).filter.properties),
    ).not.toHaveProperty("secretValues");
    expect(list.outputSchema).toMatchObject({
      properties: {
        items: { items: { properties: { data: { properties: { reviewedAt: {} } } } } },
      },
    });

    const remove = entityOperationJsonSchemas(
      contract,
      entityOperations.delete!,
      contracts,
      {},
    );
    expect(remove.inputSchema.required).toEqual([
      "id",
      "expectedVersion",
      "leaseToken",
    ]);
    expect(remove.inputSchema.dependentRequired).toEqual({
      confirmationToken: ["confirmationAnswer"],
      confirmationAnswer: ["confirmationToken"],
    });
  });

  test("keeps writable value eligibility aligned with generated MCP", () => {
    const catalog = buildMcpCatalog(
      [
        { slug: "work-item", table: "example.work_items", contract },
        { slug: "adapter", table: "example.adapters", contract: adapterContract },
      ],
      "test",
    );
    const createTool = catalog.tools.find(({ operation }) => operation === "create")!;
    const updateTool = catalog.tools.find(({ operation }) => operation === "update")!;
    const create = entityOperationJsonSchemas(
      contract,
      entityOperations.create!,
      contracts,
      {},
    );
    const update = entityOperationJsonSchemas(
      contract,
      entityOperations.update!,
      contracts,
      {},
    );
    const canonicalCreateValues = (create.inputSchema.properties as Record<string, any>)
      .values.properties;
    const canonicalUpdateValues = (update.inputSchema.properties as Record<string, any>)
      .values.properties;
    expect(Object.keys(canonicalCreateValues)).toEqual(
      Object.keys(createTool.inputSchema.properties as object),
    );
    expect(Object.keys(canonicalUpdateValues)).toEqual(
      Object.keys((updateTool.inputSchema.properties as Record<string, any>).values.properties),
    );
  });
});


test("blueprint create requires ordinary fields unless an explicit source is supplied", () => {
  const copied = { ...contract, blueprint: { fields: ["title"], labelField: "title", operations: { list: "b.list", status: "b.status", reset: "b.reset", publish: "b.publish" } } };
  const { inputSchema } = entityOperationJsonSchemas(copied, entityOperations.create!, [copied], { groups: {} } as never);
  const ajv = new Ajv2020.default({ strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(inputSchema);
  expect(validate({ values: {} })).toBe(false);
  expect(validate({ values: {}, blueprintId: "standard" })).toBe(false);
  const projectId = "11111111-1111-4111-8111-111111111111";
  expect(validate({ values: { projectId }, blueprintId: "standard" })).toBe(true);
  expect(validate({ values: {}, blueprintId: "" })).toBe(false);
  expect(validate({ values: { title: "Valid", projectId } })).toBe(true);
  expect(validate({ values: { title: "x" }, blueprintId: "standard" })).toBe(false);
});
