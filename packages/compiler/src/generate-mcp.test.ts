// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { buildEntityOperations } from "./authoring/compiler/entity-operations.js";
import type {
  CompiledEntityContract,
  CompiledField,
  CompiledRelationship,
} from "./authoring/types.js";
import {
  DATA_ACQUISITION_TOOL_FOOTER,
  advertisedEntityTool,
  advertisedToolBytes,
  schemaInLanguage,
} from "@openshapeforge/operations";
import {
  advertisedToolSizes,
  assertAdvertisedToolBytes,
  buildMcpCatalog,
  MAX_ADVERTISED_TOOL_BYTES,
  MAX_DEDICATED_TOOLS,
  operationMcpServer,
  type McpCatalogInput,
} from "./generate-mcp.js";
import type { CompiledPluginOperation } from "./generate-operations.js";
import { collectJobOperations } from "./job-operations.js";

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

const contract = (
  overrides: {
    authoringVersion?: 3;
    name?: string;
    fields?: CompiledField[];
    mcp?: CompiledEntityContract["mcp"];
    filterField?: string;
    relationships?: CompiledRelationship[];
    columns?: CompiledEntityContract["storage"]["columns"];
  } = {},
): CompiledEntityContract => {
  const compiled = {
    authoringVersion: overrides.authoringVersion ?? 3,
    contractVersion: 2,
    kind: "compiledEntityContract",
    entity: {
      id: `core.${overrides.name ?? "Widget"}`,
      name: overrides.name ?? "Widget",
      module: "core",
      title: "Widget",
      description: { en: "A widget." },
      labels: { en: "Widget" },
      domains: ["things"],
      ...(overrides.filterField ? { filterField: overrides.filterField } : {}),
    },
    storage: {
      table: "widgets",
      // Every persisted field has a storage column; a fixture that names none
      // gets one per field, as the compiler would have derived.
      columns: overrides.columns ?? (overrides.fields ?? [field({ key: "name" })]).map((entry) => ({
        field: entry.key,
        column: entry.key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        type: entry.baseType === "boolean" ? "boolean" : entry.baseType === "object" || entry.cardinality === "collection" ? "jsonb" : "text",
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
    mcp: overrides.mcp ?? {
      toolPrefix: "widget",
      tools: "dedicated",
      operations: {
        list: true,
        get: true,
        create: true,
        update: true,
        delete: true,
      },
    },
    authorization: {
      entitySlug: (overrides.name ?? "Widget").toLowerCase(),
      roles: { read: [], create: [], update: [], delete: [] },
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

const input = (
  c: CompiledEntityContract,
  slug = "widget",
  table = "erp.widgets",
): McpCatalogInput => ({
  slug,
  contract: c,
  table,
});

const staticOperation = (index: number): CompiledPluginOperation => ({
  key: `demo.operation.${String(index).padStart(3, "0")}`,
  id: `demo.operation.${String(index).padStart(3, "0")}`,
  intent: "invoke",
  plugin: "demo",
  title: `Demo operation ${index}`,
  description: `Runs demo operation ${index}.`,
  handler: `operation${index}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: {}, additionalProperties: false },
  errors: [],
  auth: { mode: "session", roles: ["Demo.Read"] },
  tenancy: { mode: "required" },
  idempotency: { mode: "none" },
  effects: { data: "write", external: "none" },
  transports: {
    rest: {
      method: "POST",
      path: `/api/demo/operations/${index}`,
      response: { status: 200, kind: "json" },
    },
    mcp: { enabled: true, name: `demo_operation_${index}` },
    graphql: { enabled: false, reason: "Not exposed in this fixture." },
    typescript: { enabled: false, reason: "Not exposed in this fixture." },
  },
});

/** Read a named sub-schema, failing the test rather than returning undefined. */
const prop = (
  schema: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const value = properties?.[key];
  if (!value) throw new Error(`expected property "${key}" in schema`);
  return value;
};

describe("buildMcpCatalog", () => {
  it("emits nothing for a contract without an mcp section", () => {
    const bare = contract();
    delete (bare as { mcp?: unknown }).mcp;
    const catalog = buildMcpCatalog([input(bare)], "test");
    expect(catalog.tools).toEqual([]);
    expect(catalog.entities).toEqual([]);
  });

  it("emits one tool per enabled operation, and skips disabled ones", () => {
    const catalog = buildMcpCatalog(
      [
        input(
          contract({
            mcp: {
              toolPrefix: "widget",
              tools: "dedicated",
              operations: {
                list: true,
                get: true,
                create: false,
                update: false,
                delete: false,
              },
            },
          }),
        ),
      ],
      "test",
    );
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "widget_list",
      "widget_get",
    ]);
    expect(catalog.tools[0]).toMatchObject({
      operation: "list",
    });
    expect(catalog.tools[0]).toHaveProperty("operationId");
    expect(catalog.tools[0]).toHaveProperty("outputSchema");
  });

  it("emits canonical output envelopes for every generated entity operation", () => {
    const catalog = buildMcpCatalog(
      [
        input(
          contract({
            authoringVersion: 3,
            fields: [
              field({ key: "id", required: true, validation: { format: "uuid" } }),
              field({ key: "name" }),
            ],
            columns: [
              {
                field: "id",
                column: "id",
                type: "uuid",
                nullable: false,
                storageClass: "core",
              },
              {
                field: "name",
                column: "name",
                type: "text",
                nullable: true,
                storageClass: "core",
              },
            ],
          }),
        ),
      ],
      "test",
    );
    const byOperation = new Map(
      catalog.tools.map((tool) => [tool.operation, tool]),
    );
    for (const tool of catalog.tools) {
      expect(tool.operationId).toBe(`Widget.${tool.operation}`);
    }
    const success = (operation: "list" | "get" | "create" | "update" | "delete") =>
      (byOperation.get(operation)!.outputSchema!.oneOf as Record<string, unknown>[])[0]!;

    const record = (
      success("get").properties as Record<string, Record<string, unknown>>
    ).data!;
    expect(record).toMatchObject({
      type: "object",
      additionalProperties: true,
      required: ["id", "tenantId", "createdAt", "updatedAt"],
    });
    expect(prop(record, "name").anyOf).toEqual([
      expect.objectContaining({ type: "string" }),
      { type: "null" },
    ]);

    const listData = (
      success("list").properties as Record<string, Record<string, unknown>>
    ).data!;
    const listItems = prop(listData, "items").items as Record<string, unknown>;
    expect(listItems.required).toEqual(["data", "operations"]);
    expect(prop(listItems, "operations").items).toEqual({
      $ref: "#/$defs/OperationOffer",
    });
    expect(listData.required).toEqual(["items", "totalCount", "nextCursor"]);

    const deleted = (
      success("delete").properties as Record<string, Record<string, unknown>>
    ).data!;
    expect(prop(deleted, "deleted")).toEqual({ type: "boolean", const: true });

    for (const tool of catalog.tools) {
      expect(tool.outputSchema!.type).toBe("object");
      expect(tool.outputSchema!.$defs).toMatchObject({
        OperationReference: expect.any(Object),
        OperationOffer: expect.any(Object),
        OperationError: expect.any(Object),
        OperationConcurrency: expect.any(Object),
      });
      expect((tool.outputSchema!.oneOf as Record<string, unknown>[])[1]).toMatchObject({
        required: ["error"],
        properties: { error: { $ref: "#/$defs/OperationError" } },
      });
    }

    const ajv = new Ajv2020.default({ strict: false, validateFormats: false });
    const instant = "2026-09-11T12:00:00.000Z";
    const recordValue = {
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: "00000000-0000-4000-8000-000000000002",
      createdAt: instant,
      updatedAt: instant,
      name: null,
    };
    const offers = [
      {
        operation: { id: "Widget.update", intent: "update" },
        available: true,
        concurrency: {
          version: { mode: "required", field: "updatedAt" },
          editLease: { mode: "required", expiresAfterInactivity: "PT2M" },
        },
      },
    ];
    const successes: Record<string, unknown> = {
      list: {
        data: {
          items: [{ data: recordValue, operations: offers }],
          totalCount: 1,
          nextCursor: null,
        },
        operations: offers,
      },
      get: { data: recordValue, operations: offers },
      create: { data: recordValue, operations: offers },
      update: { data: recordValue, operations: offers },
      delete: { data: { deleted: true }, operations: offers },
    };
    for (const tool of catalog.tools) {
      const validate = ajv.compile(tool.outputSchema!);
      expect(validate(successes[tool.operation])).toBe(true);
      expect(
        validate({
          error: {
            code: "LOCKED",
            message: "This record is being edited.",
            detail: "The lease is still active.",
            retryable: true,
            retryAt: instant,
          },
        }),
      ).toBe(true);
    }
  });

  it("does not advertise update as idempotent while it repeats events and updatedAt", () => {
    const catalog = buildMcpCatalog([input(contract())], "test");
    const update = catalog.tools.find((tool) => tool.operation === "update")!;
    expect(update.annotations.idempotentHint).toBe(false);
  });

  it("projects version, lease and confirmation controls into v2 mutation inputs", () => {
    const secured = contract({ authoringVersion: 3 });
    secured.entityOperations.create = {
      ...secured.entityOperations.create!,
      interaction: { confirmation: { mode: "acknowledgement" } },
    };
    secured.entityOperations.update = {
      ...secured.entityOperations.update!,
      concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
      },
      interaction: {
        confirmation: {
          mode: "challenge",
          challenge: {
            kind: "type-current-field",
            field: "name",
            issuedBy: "server",
            bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
            expiresAfter: "PT5M",
            singleUse: true,
          },
        },
      },
    };
    secured.entityOperations.delete = {
      ...secured.entityOperations.delete!,
      concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
      },
      interaction: {
        confirmation: {
          mode: "challenge",
          challenge: {
            kind: "type-current-field",
            field: "name",
            issuedBy: "server",
            bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
            expiresAfter: "PT5M",
            singleUse: true,
          },
        },
      },
    };

    const catalog = buildMcpCatalog([input(secured)], "test");
    const create = catalog.tools.find((tool) => tool.operation === "create")!;
    const update = catalog.tools.find((tool) => tool.operation === "update")!;
    const deletion = catalog.tools.find((tool) => tool.operation === "delete")!;

    expect(create.inputSchema.required ?? []).not.toContain("confirmed");
    expect(prop(create.inputSchema, "confirmed")).toMatchObject({
      type: "boolean",
    });
    expect(prop(create.inputSchema, "confirmed")).not.toHaveProperty("const");
    expect(update.inputSchema.required).toEqual([
      "id",
      "values",
      "expectedVersion",
      "leaseToken",
    ]);
    expect(update.inputSchema.dependentRequired).toEqual({
      confirmationToken: ["confirmationAnswer"],
      confirmationAnswer: ["confirmationToken"],
    });
    expect(prop(update.inputSchema, "expectedVersion")).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(prop(update.inputSchema, "leaseToken")).toMatchObject({ minLength: 1 });
    expect(deletion.inputSchema.required).toEqual([
      "id",
      "expectedVersion",
      "leaseToken",
    ]);
    expect(deletion.inputSchema.dependentRequired).toEqual({
      confirmationToken: ["confirmationAnswer"],
      confirmationAnswer: ["confirmationToken"],
    });
    expect(prop(deletion.inputSchema, "confirmationAnswer").description).toContain(
      "name",
    );

    const validateDelete = new Ajv2020.default({
      strict: false,
      validateFormats: false,
    }).compile(deletion.inputSchema);
    const firstCall = {
      id: "00000000-0000-4000-8000-000000000001",
      expectedVersion: "2026-09-11T12:00:00.000Z",
      leaseToken: "edit-lease-token",
    };
    expect(validateDelete(firstCall)).toBe(true);
    expect(validateDelete({ ...firstCall, confirmationToken: "challenge-token" })).toBe(
      false,
    );
    expect(
      validateDelete({
        ...firstCall,
        confirmationToken: "challenge-token",
        confirmationAnswer: "Current name",
      }),
    ).toBe(true);
  });

  it("leaves acknowledgement to the canonical runtime instead of MCP schema rejection", () => {
    const acknowledged = contract({ authoringVersion: 3 });
    for (const intent of ["create", "update", "delete"] as const) {
      acknowledged.entityOperations[intent] = {
        ...acknowledged.entityOperations[intent]!,
        interaction: { confirmation: { mode: "acknowledgement" } },
      };
    }

    const catalog = buildMcpCatalog([input(acknowledged)], "test");
    for (const intent of ["create", "update", "delete"] as const) {
      const tool = catalog.tools.find((candidate) => candidate.operation === intent)!;
      expect(tool.inputSchema.required ?? []).not.toContain("confirmed");
      expect(prop(tool.inputSchema, "confirmed")).toMatchObject({
        type: "boolean",
      });
      expect(prop(tool.inputSchema, "confirmed")).not.toHaveProperty("const");
      expect(prop(tool.inputSchema, "confirmed").description).toContain(
        "acknowledges",
      );
    }
  });

  it("keeps the five shared osf_* tools for a generic strict-v2 projection", () => {
    const catalog = buildMcpCatalog(
      [
        input(
          contract({
            authoringVersion: 3,
            mcp: {
              toolPrefix: "widget",
              tools: "generic",
              operations: {
                list: true,
                get: true,
                create: true,
                update: true,
                delete: true,
              },
            },
          }),
        ),
      ],
      "test",
    );
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "osf_list",
      "osf_get",
      "osf_create",
      "osf_update",
      "osf_delete",
    ]);
    const success = (
      catalog.tools[0]?.outputSchema!.oneOf as Record<string, unknown>[]
    )[0]!;
    const listData = (
      success.properties as Record<string, Record<string, unknown>>
    ).data!;
    const item = prop(listData, "items").items as Record<string, unknown>;
    const itemData = prop(item, "data");
    expect(itemData).toEqual({ type: "object", additionalProperties: true });
  });

  it("keeps plugin-backed CRUD schemas under the canonical generic tools", () => {
    const pluginBacked = contract({
      authoringVersion: 3,
      mcp: {
        toolPrefix: "widget",
        tools: "generic",
        operations: {
          list: true,
          get: true,
          create: true,
          update: true,
          delete: true,
        },
      },
    });
    pluginBacked.entityOperations.create = {
      ...pluginBacked.entityOperations.create!,
      implementation: { type: "plugin", plugin: "example", handler: "createWidget" },
      target: {
        entityId: pluginBacked.entity.id,
        entityName: pluginBacked.entity.name,
        scope: "collection",
      },
      input: {
        kind: "json-schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["requestKey", "definition"],
          properties: {
            requestKey: { type: "string", format: "uuid" },
            definition: { type: "object", "x-osf-sourceField": "name" },
          },
        },
      },
      output: {
        kind: "json-schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name"],
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
          },
        },
      },
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
    };

    const catalog = buildMcpCatalog([input(pluginBacked)], "test");
    const create = catalog.tools.find((tool) => tool.name === "osf_create")!;
    expect(create.operationId).toBe("Widget.create");
    expect(create.inputSchema).toMatchObject({
      required: ["requestKey", "definition"],
      properties: {
        requestKey: { type: "string", format: "uuid" },
        definition: { type: "object", "x-osf-sourceField": "name" },
      },
    });
    expect(create.inputSchema.properties).not.toHaveProperty("values");
    expect(create.annotations).toMatchObject({ idempotentHint: true });
    const success = (create.outputSchema!.oneOf as Record<string, unknown>[])[0]!;
    expect((success.properties as Record<string, unknown>).data).toEqual(
      pluginBacked.entityOperations.create.output.kind === "json-schema"
        ? pluginBacked.entityOperations.create.output.schema
        : undefined,
    );
  });

  describe("field-level schema", () => {
    it("maps authored validation onto JSON Schema keywords", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({
                  key: "name",
                  required: true,
                  validation: {
                    minLength: 1,
                    maxLength: { value: 200 },
                    pattern: "^[a-z]+$",
                  },
                }),
                field({
                  key: "score",
                  baseType: "integer",
                  validation: { min: 0, max: 10 },
                }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      expect(prop(create.inputSchema, "name")).toMatchObject({
        type: "string",
        title: "name",
        minLength: 1,
        maxLength: 200,
        pattern: "^[a-z]+$",
      });
      expect(prop(create.inputSchema, "score")).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: 10,
      });
      expect(create.inputSchema.required).toEqual(["name"]);
    });

    it("bundles the recursive FieldDefinition contract for semantic fields", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({
                  key: "definition",
                  baseType: "object",
                  osfType: "fieldDefinition",
          schema: { $ref: "#/$defs/fieldDefinition" },
                }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;

      expect(prop(create.inputSchema, "definition").$ref).toBe("#/$defs/fieldDefinition");
      expect(create.inputSchema.$defs).toMatchObject({
        fieldDefinition: expect.any(Object),
      });
      const update = catalog.tools.find((tool) => tool.operation === "update")!;
      const values = prop(update.inputSchema, "values");
      expect(prop(values, "definition").$ref).toBe("#/$defs/fieldDefinition");
      expect(values.$defs).toBeUndefined();
      expect(update.inputSchema.$defs).toMatchObject({
        fieldDefinition: expect.any(Object),
      });
    });

    it("turns static options into an enum with labels in the description", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({
                  key: "status",
                  options: {
                    type: "static",
                    items: [
                      { value: "open", label: { en: "Open" } },
                      { value: "closed", label: { en: "Closed" } },
                    ],
                  },
                }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      const status = prop(create.inputSchema, "status");
      expect(status.enum).toEqual(["open", "closed"]);
      expect(status.description).toContain("open (Open)");
      expect(status.description).toContain("closed (Closed)");
    });

    it("appends hints.aiInstructions to the parameter description", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({
                  key: "notes",
                  description: { en: "Free text." },
                  relationship: { kind: "belongsTo", entity: "Relation" },
                  hints: { aiInstructions: "Never put personal data here." },
                }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      const notes = prop(create.inputSchema, "notes");
      expect(notes.description).toBe(
        "Free text. References the Relation entity — resolve an id with that entity's list tool. " +
          "Never put personal data here.",
      );
    });

    it("keeps relationship resolution guidance before computed-field guidance", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({
                  key: "relationId",
                  relationship: { kind: "belongsTo", entity: "Relation" },
                  computed: {
                    expression: "relation.id",
                    dependencies: ["relation"],
                  },
                }),
              ],
            }),
          ),
        ],
        "test",
      );
      const described = catalog.entities[0]?.fields[0]?.description;
      expect(described).toContain(
        "References the Relation entity — resolve an id with that entity's list tool. " +
          "Derived server-side; any supplied value is ignored.",
      );
      expect(catalog.entities[0]?.fields[0]?.relationship).toEqual({
        kind: "belongsTo",
        entity: "Relation",
      });
      expect(catalog.entities[0]?.fields[0]).toMatchObject({
        baseType: "string",
        cardinality: "single",
        immutable: false,
      });
    });

    it("carries authored entity relationships as structural resource metadata", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              relationships: [
                {
                  key: "relation",
                  kind: "belongsTo",
                  target: "Relation",
                  foreignKey: "relation_id",
                  label: { en: "Relation" },
                },
              ],
            }),
          ),
        ],
        "test",
      );
      expect(catalog.entities[0]?.relationships).toEqual([
        {
          key: "relation",
          kind: "belongsTo",
          target: "Relation",
          foreignKey: "relation_id",
          field: "relationId",
          label: "Relation",
        },
      ]);
    });

    it("omits computed and server-managed fields from write schemas, but not readOnly", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({ key: "id" }),
                field({ key: "tenantId" }),
                field({ key: "createdAt", baseType: "datetime" }),
                field({ key: "updatedAt", baseType: "datetime" }),
                field({ key: "slug", readOnly: true }),
                field({
                  key: "total",
                  computed: { expression: "a+b", dependencies: ["a"] },
                }),
                field({ key: "name" }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      // `slug` is authored readOnly, which is a presentation flag here, not an
      // API contract — omitting it would hide a field the server accepts.
      expect(Object.keys(create.inputSchema.properties as object)).toEqual([
        "slug",
        "name",
      ]);
    });

    it("offers an immutable field on create and withholds it on update (#177)", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({ key: "name" }),
                field({ key: "displayOnly", readOnly: true }),
                field({ key: "relationId", readOnly: true, immutable: true }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      const update = catalog.tools.find((tool) => tool.operation === "update")!;
      const values = (
        update.inputSchema.properties as Record<string, Record<string, unknown>>
      ).values!;

      // Settable once: the create schema still advertises it, so an agent can
      // create the attached record (#180).
      expect(Object.keys(create.inputSchema.properties as object)).toEqual([
        "name",
        "displayOnly",
        "relationId",
      ]);
      // Fixed afterwards: absent from the update patch, which the runtime
      // validates arguments against.
      expect(Object.keys(values.properties as object)).toEqual([
        "name",
        "displayOnly",
      ]);
    });

    it("withholds a writtenBy field from create AND update, and says who writes it", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({ key: "name" }),
                field({
                  key: "reviewedAt",
                  writtenBy: ["pentest.finding.review"],
                }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      const update = catalog.tools.find((tool) => tool.operation === "update")!;
      const values = (
        update.inputSchema.properties as Record<string, Record<string, unknown>>
      ).values!;

      expect(Object.keys(create.inputSchema.properties as object)).toEqual([
        "name",
      ]);
      expect(Object.keys(values.properties as object)).toEqual(["name"]);
      // A model that only sees the field missing tries anyway; both tool
      // descriptions name the operation that does write it.
      for (const tool of [create, update]) {
        expect(tool.description).toContain("reviewedAt (pentest.finding.review)");
      }
    });

    it("leaves an entity with no immutable field identical across create and update", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [field({ key: "name" }), field({ key: "slug" })],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      const update = catalog.tools.find((tool) => tool.operation === "update")!;
      const values = (
        update.inputSchema.properties as Record<string, Record<string, unknown>>
      ).values!;

      expect(Object.keys(values.properties as object)).toEqual(
        Object.keys(create.inputSchema.properties as object),
      );
    });

    it("models a collection as an array carrying the item constraints", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({
                  key: "tags",
                  cardinality: "collection",
                  validation: { maxLength: 20, minItems: 1 },
                }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      const tags = prop(create.inputSchema, "tags");
      expect(tags.type).toBe("array");
      expect(tags.minItems).toBe(1);
      expect(tags.items).toMatchObject({ type: "string", maxLength: 20 });
    });

    it("records classified field keys for the runtime to withhold", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({ key: "email", classification: { sensitivity: "pii" } }),
                field({
                  key: "note",
                  classification: { sensitivity: "internal" },
                }),
                field({ key: "name" }),
              ],
            }),
          ),
        ],
        "test",
      );
      // `internal` imposes no read restriction, so only `email` is listed.
      expect(catalog.entities[0]?.classifiedFields).toEqual(["email"]);
    });

    it("makes update a partial — only the id is required", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              fields: [
                field({ key: "name", required: true, defaultValue: "Unnamed" }),
                field({
                  key: "metadata",
                  baseType: "object",
                  children: [field({ key: "source", defaultValue: "api" })],
                }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      const update = catalog.tools.find((tool) => tool.operation === "update")!;
      expect(update.inputSchema.required).toEqual(["id", "values"]);
      const values = prop(update.inputSchema, "values");
      expect(values.required).toBeUndefined();
      expect(prop(create.inputSchema, "name").default).toBe("Unnamed");
      expect(prop(values, "name").default).toBeUndefined();
      const metadata = prop(values, "metadata");
      expect(prop(metadata, "source").default).toBeUndefined();
    });

    it("constrains list sorting to scalar fields", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              filterField: "name",
              fields: [
                field({ key: "name" }),
                field({ key: "tags", cardinality: "collection" }),
                field({ key: "payload", baseType: "object" }),
              ],
            }),
          ),
        ],
        "test",
      );
      const list = catalog.tools.find((tool) => tool.operation === "list")!;
      expect(prop(list.inputSchema, "sortField").enum).toEqual(["name"]);
    });
  });

  it("sorts entities by tool prefix so output is deterministic", () => {
    const catalog = buildMcpCatalog(
      [
        input(
          contract({
            name: "Zebra",
            mcp: {
              toolPrefix: "zebra",
              tools: "dedicated",
              operations: {
                list: true,
                get: false,
                create: false,
                update: false,
                delete: false,
              },
            },
          }),
          "zebra",
        ),
        input(
          contract({
            name: "Alpha",
            mcp: {
              toolPrefix: "alpha",
              tools: "dedicated",
              operations: {
                list: true,
                get: false,
                create: false,
                update: false,
                delete: false,
              },
            },
          }),
          "alpha",
        ),
      ],
      "test",
    );
    expect(catalog.entities.map((entry) => entry.toolPrefix)).toEqual([
      "alpha",
      "zebra",
    ]);
  });

  it("fails the build when the dedicated tool count would flood tool selection", () => {
    const many = Array.from(
      { length: MAX_DEDICATED_TOOLS / 5 + 1 },
      (_unused, index) =>
        input(
          contract({
            name: `Entity${index}`,
            mcp: {
              toolPrefix: `entity_${index}`,
              tools: "dedicated",
              operations: {
                list: true,
                get: true,
                create: true,
                update: true,
                delete: true,
              },
            },
          }),
          `entity-${index}`,
        ),
    );
    expect(() => buildMcpCatalog(many, "test")).toThrow(/over the 60 limit/);
  });

  it("fails the build when the advertised listing would exceed the byte budget, naming the largest tools", () => {
    // Forty wide dedicated entities: a description per field of a few hundred
    // bytes puts the listing far over the budget, the way a real catalogue's
    // record schemas do when every entity keeps its own tools.
    const wide = Array.from({ length: 12 }, (_unused, index) =>
      input(
        contract({
          name: `Wide${index}`,
          fields: Array.from({ length: 60 }, (_f, fieldIndex) =>
            field({
              key: `wide${index}Field${fieldIndex}`,
              description: { en: "A field whose description is long enough to weigh. ".repeat(6) },
            }),
          ),
          mcp: {
            toolPrefix: `wide_${index}`,
            tools: "dedicated",
            operations: { list: true, get: true, create: true, update: true, delete: true },
          },
        }),
        `wide-${index}`,
        `erp.wide_${index}`,
      ),
    );
    expect(() => buildMcpCatalog(wide, "test")).toThrow(
      /over the 640 KB listing budget \(MAX_ADVERTISED_TOOL_BYTES\)\. Largest: wide_\d+_\w+ \(\d+ KB\)/,
    );
    // The same entities on the generic tools fit: the listing carries the
    // entity enum and the shared properties, the schemas move to osf_describe.
    const generic = wide.map((entry) => ({
      ...entry,
      contract: { ...entry.contract, mcp: { ...entry.contract.mcp!, tools: "generic" as const } },
    }));
    const catalog = buildMcpCatalog(generic, "test");
    const sizes = advertisedToolSizes({
      tools: catalog.tools,
      entities: catalog.entities,
      operationTools: catalog.operationTools,
      projection: catalog.operationToolProjection.mode,
    });
    // The release lease tool is always listed; nothing here is lease-protected.
    expect(sizes.map((entry) => entry.name)).toEqual([
      "osf_list", "osf_get", "osf_create", "osf_update", "osf_delete", "osf_describe",
      "osf_release_edit_lease",
    ]);
    expect(sizes.reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThan(64 * 1024);
    expect(() => assertAdvertisedToolBytes(sizes)).not.toThrow();
    // The reservations count: a maximum below them fails before any tool weighs.
    expect(() => assertAdvertisedToolBytes(sizes, 1024)).toThrow(/over the 1 KB listing budget/);
    expect(MAX_ADVERTISED_TOOL_BYTES).toBe(640 * 1024);
  });

  it("measures the whole static listing: searchable pair, lease tools, derived helpers, guides, connectors", () => {
    const withGuide = input(
      contract({
        mcp: {
          toolPrefix: "widget",
          tools: "dedicated",
          operations: { list: true, get: true, create: false, update: false, delete: false },
          guide: { name: "widget_guide", description: "How widgets work.", roles: ["Widgets.All.Read"], content: "..." },
        } as never,
      }),
    );
    const operations = Array.from({ length: MAX_DEDICATED_TOOLS + 1 }, (_unused, index) => staticOperation(index));
    const catalog = buildMcpCatalog([withGuide], "test", {}, operations);
    const sizes = advertisedToolSizes({
      tools: catalog.tools,
      entities: catalog.entities,
      operationTools: catalog.operationTools,
      projection: catalog.operationToolProjection.mode,
      guideTools: catalog.guideTools,
      derivedTools: [
        {
          entity: "Service", table: "erp.services", roles: [], keyField: "key", descriptionField: "description",
          inputFieldsField: "inputs",
          connect: { name: "connect_service", description: "Sign in.", roles: [] },
          dryRun: { name: "dry_run", description: "Compose.", roles: [] },
          execution: {} as never,
        } as never,
      ],
      editLeaseOperationIds: ["Widget.update"],
      connectorTools: [{
        name: "example_list", title: "List", description: "Lists.", inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      }],
    });
    expect(sizes.map((entry) => entry.name)).toEqual([
      "widget_list", "widget_get",
      "osf_search_operations", "osf_execute_operation",
      "osf_acquire_edit_lease", "osf_renew_edit_lease", "osf_release_edit_lease",
      "connect_service", "dry_run",
      "widget_guide",
      "example_list",
    ]);
    for (const entry of sizes) expect(entry.bytes).toBeGreaterThan(100);
  });

  it("rejects the reported guide name collision with jobs_list", () => {
    const withCollidingGuide = input(
      contract({
        mcp: {
          toolPrefix: "widget",
          tools: "dedicated",
          operations: { list: true, get: true, create: true, update: true, delete: true },
          guide: {
            name: "jobs_list",
            description: "Explain widget maintenance.",
            roles: ["Widgets.All.Read"],
            content: "Use the widget operations.",
          },
        } as never,
      }),
    );

    expect(() =>
      buildMcpCatalog([withCollidingGuide], "test", {}, collectJobOperations())
    ).toThrow(
      'Duplicate MCP tool name "jobs_list": claimed by both Widget.guide and canonical Operation "jobs.list".',
    );
  });

  it("measures the shape the runtime lists: write reminder, mirrored title, app link, localized text", () => {
    const elicits = input(
      contract({
        fields: [field({ key: "name" }), field({ key: "fields", baseType: "json" } as never), field({ key: "values", baseType: "json" } as never)],
        mcp: {
          toolPrefix: "widget",
          tools: "dedicated",
          operations: { list: false, get: false, create: true, update: false, delete: false },
          elicitOnCreate: { sourceEntity: "Widget", sourceField: "id", definitionsField: "fields", into: "values" },
        } as never,
      }),
    );
    const catalog = buildMcpCatalog([elicits], "test");
    const create = catalog.tools.find((tool) => tool.name === "widget_create")!;
    const [measured] = advertisedToolSizes({
      tools: catalog.tools,
      entities: catalog.entities,
      operationTools: [],
      projection: "dedicated",
      canonicalTexts: new Map([[create.operationId ?? "", {
        name: { en: "Create widget", nl: "Widget aanmaken met een langere titel" },
        description: { en: create.description.split(".")[0] + ".", nl: "Maakt één widget aan na validatie van de canonieke velden, uitgebreid." },
      }]]),
    });
    // The bare compiled entry in one language, plus what the listing adds:
    // the reminder on a write tool, the title in the annotations and the app
    // link. (The compiled entry carries every language; the listing one.)
    const bare = advertisedToolBytes({
      name: create.name, title: create.title, description: create.description,
      inputSchema: schemaInLanguage(create.inputSchema, "en"),
      outputSchema: schemaInLanguage(create.outputSchema, "en"),
      annotations: create.annotations,
    });
    const listed = advertisedToolBytes(advertisedEntityTool({
      name: create.name, operation: "create", title: create.title, description: create.description,
      inputSchema: create.inputSchema, outputSchema: create.outputSchema, annotations: create.annotations,
      linksConfigurationApp: true,
    }));
    expect(listed).toBeGreaterThan(bare + DATA_ACQUISITION_TOOL_FOOTER.length);
    // The longer Dutch text is what the budget counts.
    expect(measured!.bytes).toBeGreaterThan(listed);
    // A third language authored on the catalogue is measured too: a tool
    // whose German copy is the longest weighs what the German listing weighs.
    const german = advertisedToolSizes({
      tools: [{ ...create, inputSchema: { ...create.inputSchema, properties: { ...(create.inputSchema.properties as Record<string, unknown>),
        name: { type: "string", "x-osf-i18n": { title: { en: "Name", nl: "Naam", de: "Bezeichnung des Datensatzes, ausführlich".repeat(4) } } } } } }],
      entities: catalog.entities,
      operationTools: [],
      projection: "dedicated",
    }).find((entry) => entry.name === create.name)!;
    expect(german.bytes).toBeGreaterThan(measured!.bytes);
    expect(JSON.stringify(advertisedEntityTool({
      name: create.name, operation: "create", title: "t", description: "d",
      inputSchema: {}, annotations: create.annotations, linksConfigurationApp: true,
    }))).toContain("ui://openshapeforge/configuration");
  });

  it("classifies generic tools by the entity's declared policy and refuses the osf_ prefix on a dedicated tool", () => {
    // A dedicated entity whose prefix spells like the shared tools: refused,
    // not silently merged into osf_list and exempted from the checks.
    expect(() =>
      buildMcpCatalog(
        [input(contract({ mcp: { toolPrefix: "osf", tools: "dedicated", operations: { list: true, get: true, create: true, update: true, delete: true } } }))],
        "test",
      ),
    ).toThrow(/"osf_list" \(Widget\.list\) uses the reserved "osf_" prefix/);
    // The same names on a generic entity are the shared tools, counted as such.
    const catalog = buildMcpCatalog(
      [input(contract({ mcp: { toolPrefix: "osf", tools: "generic", operations: { list: true, get: true, create: true, update: true, delete: true } } }))],
      "test",
    );
    expect(catalog.entities[0]!.tools).toBe("generic");
    expect(advertisedToolSizes({
      tools: catalog.tools, entities: catalog.entities, operationTools: [], projection: "dedicated",
    }).map((entry) => entry.name)).toContain("osf_describe");
  });

  it("retains every static Operation and switches the advertised projection over the limit", () => {
    const operations = Array.from(
      { length: MAX_DEDICATED_TOOLS + 1 },
      (_unused, index) => staticOperation(index),
    );
    const catalog = buildMcpCatalog([], "test", {}, operations);

    expect(catalog.operationTools).toHaveLength(MAX_DEDICATED_TOOLS + 1);
    expect(new Set(catalog.operationTools.map((tool) => tool.key)).size)
      .toBe(MAX_DEDICATED_TOOLS + 1);
    expect(catalog.operationToolProjection).toEqual({
      mode: "searchable",
      search: "osf_search_operations",
      execute: "osf_execute_operation",
    });
  });

  it("keeps static Operations dedicated while the combined catalog fits", () => {
    const catalog = buildMcpCatalog(
      [],
      "test",
      {},
      [staticOperation(1), staticOperation(2)],
    );
    expect(catalog.operationToolProjection.mode).toBe("dedicated");
  });
});

describe("authored tool overrides", () => {
  const mcpWithOverrides = {
    toolPrefix: "widget",
    tools: "dedicated" as const,
    operations: {
      list: false,
      get: true,
      create: true,
      update: true,
      delete: true,
    },
    toolOverrides: {
      get: { name: "read_widget" },
      update: { name: "edit_widget" },
    },
  };

  it("uses override names, composed defaults elsewhere", () => {
    const catalog = buildMcpCatalog(
      [input(contract({ mcp: mcpWithOverrides }))],
      "test",
    );
    const byOperation = new Map(
      catalog.tools.map((tool) => [tool.operation, tool]),
    );
    expect(byOperation.get("get")?.name).toBe("read_widget");
    expect(byOperation.get("get")?.description).toBe("get Widget");
    expect(byOperation.get("update")?.name).toBe("edit_widget");
    expect(byOperation.get("update")?.description).toContain("update Widget");
    expect(byOperation.get("create")?.name).toBe("widget_create");
    expect(byOperation.get("delete")?.name).toBe("widget_delete");
  });

  it("fails closed on a duplicate dedicated tool name across the catalog", () => {
    const first = contract({
      name: "Widget",
      mcp: {
        toolPrefix: "widget",
        tools: "dedicated",
        operations: {
          list: false,
          get: true,
          create: false,
          update: false,
          delete: false,
        },
        toolOverrides: { get: { name: "read_thing" } },
      },
    });
    const second = contract({
      name: "Gadget",
      mcp: {
        toolPrefix: "gadget",
        tools: "dedicated",
        operations: {
          list: false,
          get: true,
          create: false,
          update: false,
          delete: false,
        },
        toolOverrides: { get: { name: "read_thing" } },
      },
    });
    expect(() =>
      buildMcpCatalog(
        [input(first, "widget"), input(second, "gadget")],
        "test",
      ),
    ).toThrow(/Duplicate MCP tool name "read_thing"/);
  });
});

describe("resource catalog", () => {
  const mcpWithResource = {
    toolPrefix: "widget",
    tools: "dedicated" as const,
    operations: {
      list: false,
      get: true,
      create: true,
      update: true,
      delete: true,
    },
    resource: {
      uri: "app://widgets",
      description: "Read the widget catalogue.",
    },
  };

  it("emits a direct resource plus derived template with label fallbacks", () => {
    const catalog = buildMcpCatalog(
      [input(contract({ mcp: mcpWithResource }))],
      "test",
    );
    expect(catalog.resources).toEqual([
      {
        uri: "app://widgets",
        name: "Widgets",
        description: "Read the widget catalogue.",
        templateUri: "app://widgets/{id}",
        templateName: "Specific Widget",
        templateDescription: "Read one Widget by its identifier.",
        entity: "Widget",
        table: "erp.widgets",
      },
    ]);
  });

  it("emits an empty resources array when nothing opts in", () => {
    expect(buildMcpCatalog([input(contract())], "test").resources).toEqual([]);
  });

  it("fails closed on a duplicate resource uri across entities", () => {
    const duplicated = (name: string, prefix: string) =>
      contract({
        name,
        mcp: {
          toolPrefix: prefix,
          tools: "dedicated",
          operations: {
            list: false,
            get: true,
            create: false,
            update: false,
            delete: false,
          },
          resource: { uri: "app://shared" },
        },
      });
    expect(() =>
      buildMcpCatalog(
        [
          input(duplicated("Widget", "widget"), "widget"),
          input(duplicated("Gadget", "gadget"), "gadget"),
        ],
        "test",
      ),
    ).toThrow(/Duplicate MCP resource uri "app:\/\/shared"/);
  });
});

describe("derived tools catalog", () => {
  it("emits the derivedTools projection config for opted-in entities", () => {
    const mcp = {
      toolPrefix: "widget",
      tools: "dedicated" as const,
      operations: {
        list: false,
        get: true,
        create: true,
        update: true,
        delete: true,
      },
      derivedTools: {
        roles: ["viewer"],
        keyField: "name",
        descriptionField: "name",
        inputFieldsField: "name",
        outputFieldsField: "name",
      },
    };
    const catalog = buildMcpCatalog([input(contract({ mcp }))], "test");
    expect(catalog.derivedTools).toEqual([
      {
        entity: "Widget",
        table: "erp.widgets",
        roles: ["viewer"],
        keyField: "name",
        descriptionField: "name",
        inputFieldsField: "name",
        outputFieldsField: "name",
      },
    ]);
    expect(buildMcpCatalog([input(contract())], "test").derivedTools).toEqual(
      [],
    );
  });

  it("resolves every execution entity to its own physical table", () => {
    const related = (name: string): CompiledEntityContract => {
      const value = contract({ name });
      delete (value as { mcp?: unknown }).mcp;
      return value;
    };
    const owner = contract({
      name: "ServiceDefinition",
      fields: [
        field({ key: "name" }),
        field({ key: "revision", baseType: "integer" }),
        field({
          key: "bindings",
          osfType: "ServiceBinding",
          cardinality: "collection",
          relationship: {
            kind: "hasMany",
            ownership: "owned",
            target: "ServiceBinding",
            inverse: "serviceId",
          },
        }),
      ],
      relationships: [
        {
          key: "bindings",
          kind: "hasMany",
          target: "ServiceBinding",
          ownership: "owned",
          inverse: "serviceId",
          foreignKey: "service_id",
        },
      ],
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
          keyField: "name",
          descriptionField: "name",
          inputFieldsField: "name",
          versionField: "revision",
          execution: {
            bindingsRelation: "bindings",
            operationRef: "operationId",
            operationEntity: "ProviderOperation",
            providerRef: "providerId",
            providerEntity: "Provider",
            connectionEntity: "ProviderConnection",
            connectionProviderRef: "providerId",
            connectionValuesField: "values",
          },
        },
      },
    });
    const binding = contract({
      name: "ServiceBinding",
      fields: [
        field({
          key: "serviceId",
          osfType: "ServiceDefinition",
          relationship: {
            kind: "belongsTo",
            target: "ServiceDefinition",
            foreignKey: "service_id",
          },
        }),
        field({
          key: "operationId",
          osfType: "ProviderOperation",
          relationship: {
            kind: "belongsTo",
            target: "ProviderOperation",
            foreignKey: "operation_id",
          },
        }),
        field({ key: "order", baseType: "integer", required: true }),
        field({ key: "optional", baseType: "boolean" }),
        field({ key: "when", baseType: "object" }),
        field({ key: "inputMapping", baseType: "object", cardinality: "collection" }),
        field({ key: "outputMapping", baseType: "object", cardinality: "collection" }),
        field({ key: "forEach", baseType: "object" }),
      ],
      relationships: [
        {
          key: "serviceId",
          kind: "belongsTo",
          target: "ServiceDefinition",
          ownership: "reference",
          foreignKey: "service_id",
        },
        {
          key: "operationId",
          kind: "belongsTo",
          target: "ProviderOperation",
          ownership: "reference",
          foreignKey: "operation_id",
        },
      ],
    });
    delete (binding as { mcp?: unknown }).mcp;

    const catalog = buildMcpCatalog(
      [
        input(owner, "service", "services.definitions"),
        input(binding, "binding", "services.bindings"),
        input(related("ProviderOperation"), "operation", "services.operations"),
        input(related("Provider"), "provider", "services.providers"),
        input(
          related("ProviderConnection"),
          "connection",
          "services.connections",
        ),
      ],
      "test",
    );

    expect(catalog.derivedTools[0]).toMatchObject({
      versionField: "revision",
      execution: {
        bindingsRelation: "bindings",
        bindingsEntity: "ServiceBinding",
        bindingsTable: "services.bindings",
        parentRef: "serviceId",
        operationTable: "services.operations",
        providerTable: "services.providers",
        connectionTable: "services.connections",
      },
    });
  });
});

describe("elicitOnCreate catalog", () => {
  const source = contract({
    name: "Provider",
    fields: [field({ key: "configFields" })],
    mcp: {
      toolPrefix: "provider",
      tools: "dedicated",
      operations: {
        list: false,
        get: true,
        create: false,
        update: false,
        delete: false,
      },
    },
  });
  const owner = (elicit: Record<string, unknown>) =>
    contract({
      name: "Widget",
      fields: [
        field({ key: "adapterId" }),
        field({ key: "configurationValues" }),
      ],
      mcp: {
        toolPrefix: "widget",
        tools: "dedicated",
        operations: {
          list: true,
          get: true,
          create: true,
          update: true,
          delete: true,
        },
        elicitOnCreate: elicit,
      } as never,
    });
  const elicit = {
    sourceField: "adapterId",
    sourceEntity: "Provider",
    definitionsField: "configFields",
    into: "configurationValues",
  };

  it("resolves the source table and excludes the target field from create and update", () => {
    const catalog = buildMcpCatalog(
      [
        input(owner(elicit), "widget", "erp.widgets"),
        input(source, "provider", "erp.providers"),
      ],
      "test",
    );
    const entry = catalog.entities.find((entity) => entity.entity === "Widget");
    expect(entry?.elicitOnCreate).toEqual({
      ...elicit,
      sourceTable: "erp.providers",
    });
    const create = catalog.tools.find(
      (tool) => tool.entity === "Widget" && tool.operation === "create",
    );
    const properties = create?.inputSchema.properties as Record<
      string,
      unknown
    >;
    expect(properties.adapterId).toBeDefined();
    expect(properties.configurationValues).toBeUndefined();
    const update = catalog.tools.find(
      (tool) => tool.entity === "Widget" && tool.operation === "update",
    );
    const updateValues = (
      update?.inputSchema.properties as Record<string, unknown>
    ).values as {
      properties: Record<string, unknown>;
    };
    expect(updateValues.properties.configurationValues).toBeUndefined();
    const list = catalog.tools.find(
      (tool) => tool.entity === "Widget" && tool.operation === "list",
    );
    const listProperties = list?.inputSchema.properties as {
      filter: { properties: Record<string, unknown> };
      sortField: { enum: string[] };
    };
    expect(
      listProperties.filter.properties.configurationValues,
    ).toBeUndefined();
    expect(listProperties.sortField.enum).not.toContain("configurationValues");
  });

  it("fails closed on a dangling source entity or field", () => {
    expect(() =>
      buildMcpCatalog([input(owner(elicit), "widget")], "test"),
    ).toThrow(/not part of this catalog/);
    expect(() =>
      buildMcpCatalog(
        [
          input(owner({ ...elicit, definitionsField: "missing" }), "widget"),
          input(source, "provider"),
        ],
        "test",
      ),
    ).toThrow(/has no field "missing"/);
  });
});

describe("test tool catalog", () => {
  it("emits testTools with a composed default description", () => {
    const mcp = {
      toolPrefix: "widget",
      tools: "dedicated" as const,
      operations: {
        list: false,
        get: true,
        create: false,
        update: false,
        delete: false,
      },
      elicitOnCreate: {
        sourceField: "adapterId",
        sourceEntity: "Widget",
        definitionsField: "name",
        into: "name",
      },
      test: { name: "test_widget" },
    };
    const catalog = buildMcpCatalog(
      [
        input(
          contract({
            mcp,
            fields: [field({ key: "adapterId" }), field({ key: "name" })],
          }),
        ),
      ],
      "test",
    );
    expect(catalog.testTools).toEqual([
      {
        name: "test_widget",
        description: expect.stringContaining("Verify one Widget"),
        entity: "Widget",
        table: "erp.widgets",
      },
    ]);
    expect(buildMcpCatalog([input(contract())], "test").testTools).toEqual([]);
  });

  it("refuses a test name colliding with a dedicated tool", () => {
    const mcp = {
      toolPrefix: "widget",
      tools: "dedicated" as const,
      operations: {
        list: false,
        get: true,
        create: false,
        update: false,
        delete: false,
      },
      elicitOnCreate: {
        sourceField: "name",
        sourceEntity: "Widget",
        definitionsField: "name",
        into: "name",
      },
      test: { name: "widget_get" },
    };
    expect(() =>
      buildMcpCatalog(
        [input(contract({ mcp, fields: [field({ key: "name" })] }))],
        "test",
      ),
    ).toThrow(/Duplicate MCP tool name "widget_get"/);
  });
});

describe("relationship keys", () => {
  const belongsTo = (
    key: string,
    target: string,
    foreignKey: string,
  ): CompiledRelationship => ({
    key,
    kind: "belongsTo",
    target,
    foreignKey,
    label: { en: target },
  });

  /** The shared factory labels everything "Widget"; a relationship description names two entities. */
  const labelled = (c: CompiledEntityContract, label: string) => {
    c.entity.labels = { en: label };
    return c;
  };

  /** A Finding-shaped contract: two belongsTo keys and a hasMany that must not leak. */
  const finding = (
    columns: CompiledEntityContract["storage"]["columns"] = [
      { field: "title", column: "title", type: "text", nullable: false, storageClass: "core" },
    ],
  ) =>
    labelled(contract({
      name: "Finding",
      fields: [field({ key: "title", required: true })],
      relationships: [
        belongsTo("assessment", "Assessment", "assessment_id"),
        belongsTo("testTarget", "TestTarget", "test_target_id"),
        {
          key: "evidence",
          kind: "hasMany",
          target: "Evidence",
          foreignKey: "finding_id",
        },
      ],
      columns,
      mcp: {
        toolPrefix: "finding",
        tools: "dedicated",
        operations: {
          list: true,
          get: true,
          create: true,
          update: true,
          delete: true,
        },
      },
    }), "Finding");

  const assessment = labelled(contract({
    name: "Assessment",
    mcp: {
      toolPrefix: "assessment",
      tools: "dedicated",
      operations: {
        list: true,
        get: true,
        create: false,
        update: false,
        delete: false,
      },
    },
  }), "Assessment");

  const toolNamed = (
    catalog: ReturnType<typeof buildMcpCatalog>,
    name: string,
  ) => {
    const tool = catalog.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`expected tool ${name}`);
    return tool;
  };

  it("advertises <key>Id on create, update.values and list.filter, never the hasMany side", () => {
    const catalog = buildMcpCatalog(
      [input(finding(), "finding", "pentest.findings"), input(assessment, "assessment", "pentest.assessments")],
      "test",
    );

    const create = toolNamed(catalog, "finding_create").inputSchema;
    expect(Object.keys(create.properties as object)).toEqual([
      "title",
      "assessmentId",
      "testTargetId",
    ]);
    expect(prop(create, "assessmentId")).toEqual({
      type: "string",
      format: "uuid",
      "x-osf-type": "Assessment",
      description:
        "Identifier of the Assessment this Finding belongs to, as returned by `assessment_list`.",
    });
    expect(create.additionalProperties).toBe(false);

    const values = prop(toolNamed(catalog, "finding_update").inputSchema, "values");
    expect(Object.keys(values.properties as object)).toEqual([
      "title",
      "assessmentId",
      "testTargetId",
    ]);
    expect(values.required).toBeUndefined();

    const filter = prop(toolNamed(catalog, "finding_list").inputSchema, "filter");
    expect(prop(filter, "assessmentId")).toMatchObject({ type: "string", format: "uuid" });
    expect(prop(filter, "testTargetId")).toMatchObject({ type: "string", format: "uuid" });
    expect((filter.properties as object)).not.toHaveProperty("evidenceId");
    expect((filter.properties as object)).not.toHaveProperty("findingId");

    // The get and delete tools take only an id.
    expect(Object.keys(toolNamed(catalog, "finding_get").inputSchema.properties as object)).toEqual(["id"]);
  });

  it("requires the key exactly when the storage column refuses null", () => {
    const catalog = buildMcpCatalog(
      [
        input(
          finding([
            { field: "title", column: "title", type: "text", nullable: false, storageClass: "core" },
            { field: "assessmentId", column: "assessment_id", type: "uuid", nullable: false, storageClass: "core" },
            { field: "testTargetId", column: "test_target_id", type: "uuid", nullable: true, storageClass: "core" },
          ]),
        ),
      ],
      "test",
    );
    const create = toolNamed(catalog, "finding_create").inputSchema;
    expect(create.required).toEqual(["title", "assessmentId"]);
    // Update stays a partial: a NOT NULL column is still "leave it alone" when omitted.
    const values = prop(toolNamed(catalog, "finding_update").inputSchema, "values");
    expect(values.required).toBeUndefined();
  });

  it("names the storage column's field key, not a recomputed one", () => {
    const catalog = buildMcpCatalog(
      [
        input(
          contract({
            name: "Finding",
            relationships: [belongsTo("assessment", "Assessment", "assessment_id")],
            columns: [
              { field: "assessmentId", column: "assessment_id", type: "uuid", nullable: true, storageClass: "core" },
            ],
          }),
        ),
      ],
      "test",
    );
    expect(catalog.entities[0]?.relationships[0]).toMatchObject({
      key: "assessment",
      field: "assessmentId",
    });
    expect(prop(toolNamed(catalog, "widget_create").inputSchema, "assessmentId")).toBeDefined();
  });

  it("does not duplicate a foreign key an authored field already owns", () => {
    // PaymentDetail.relationId persists at relation_id and is a real field with
    // its own schema; the relationship must not add a second property for it.
    const catalog = buildMcpCatalog(
      [
        input(
          contract({
            name: "PaymentDetail",
            fields: [
              field({ key: "relationId", baseType: "string" }),
              field({ key: "iban" }),
            ],
            relationships: [belongsTo("relation", "Relation", "relation_id")],
            columns: [
              { field: "relationId", column: "relation_id", type: "uuid", nullable: true, storageClass: "core" },
              { field: "iban", column: "iban", type: "text", nullable: true, storageClass: "core" },
            ],
          }),
        ),
      ],
      "test",
    );
    const create = toolNamed(catalog, "widget_create").inputSchema;
    expect(Object.keys(create.properties as object)).toEqual(["relationId", "iban"]);
    expect(prop(create, "relationId")).not.toHaveProperty("format");
    expect(catalog.entities[0]?.relationships[0]).toMatchObject({ field: "relationId" });
  });

  it("points at the target's list tool only when the target is in the catalog", () => {
    const generic = contract({
      name: "Assessment",
      mcp: {
        toolPrefix: "assessment",
        tools: "generic",
        operations: { list: true, get: true, create: false, update: false, delete: false },
      },
    });
    const withGeneric = buildMcpCatalog(
      [input(finding(), "finding", "pentest.findings"), input(generic, "assessment", "pentest.assessments")],
      "test",
    );
    expect(
      prop(toolNamed(withGeneric, "finding_create").inputSchema, "assessmentId").description,
    ).toBe("Identifier of the Widget this Finding belongs to, as returned by `osf_list`.");

    const alone = buildMcpCatalog([input(finding(), "finding", "pentest.findings")], "test");
    expect(
      prop(toolNamed(alone, "finding_create").inputSchema, "assessmentId").description,
    ).toBe("Identifier of the Assessment this Finding belongs to.");
  });

  it("emits relationship keys deterministically", () => {
    const build = () =>
      JSON.stringify(buildMcpCatalog([input(finding(), "finding", "pentest.findings")], "test"));
    expect(build()).toBe(build());
  });
});

describe("control-realm Operation tools", () => {
  const controlOperation = (index: number): CompiledPluginOperation => ({
    ...staticOperation(index),
    key: `control.operation-${index}`,
    id: `control.operation-${index}`,
    plugin: "osf-control",
    auth: { mode: "control", roles: ["platform-operator"] },
    tenancy: { mode: "none" },
    effects: { data: "read", external: "none" },
    transports: {
      ...staticOperation(index).transports,
      rest: {
        method: "GET",
        path: `/api/control/v1/operations/${index}`,
        response: { status: 200, kind: "json" },
      },
      mcp: { enabled: true, name: `control_operation_${index}` },
    },
  });

  it("lists control tools by the auth mode the control server filters on, outside the tenant budget", () => {
    const control = Array.from(
      { length: MAX_DEDICATED_TOOLS + 1 },
      (_unused, index) => controlOperation(index),
    );
    const catalog = buildMcpCatalog([], "test", {}, [staticOperation(1), ...control]);

    expect(catalog.operationTools).toHaveLength(MAX_DEDICATED_TOOLS + 2);
    expect(catalog.operationTools.filter((tool) => tool.auth.mode === "control"))
      .toHaveLength(MAX_DEDICATED_TOOLS + 1);
    expect(catalog.operationTools.find((tool) => tool.key === "control.operation-0")).toMatchObject({
      plugin: "osf-control",
      name: "control_operation_0",
      auth: { mode: "control", roles: ["platform-operator"] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    });
    // Sixty-one tenant tools would flip the catalog to searchable; these
    // belong to the control server, so the tenant projection is untouched.
    expect(catalog.operationToolProjection.mode).toBe("dedicated");
    expect(operationMcpServer(control[0]!)).toBe("control");
    expect(operationMcpServer(staticOperation(1))).toBe("tenant");
  });
});
