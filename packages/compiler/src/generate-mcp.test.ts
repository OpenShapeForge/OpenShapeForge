// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  buildMcpCatalog,
  MAX_DEDICATED_TOOLS,
  type McpCatalogInput,
} from "./generate-mcp.js";
import type {
  CompiledEntityContract,
  CompiledField,
  CompiledRelationship,
} from "./authoring/types.js";

const field = (
  overrides: Partial<CompiledField> & { key: string },
): CompiledField =>
  ({
    valueType: "string",
    cardinality: "single",
    required: false,
    label: { en: overrides.key },
    render: { component: "Input" },
    ...overrides,
  }) as CompiledField;

const contract = (
  overrides: {
    name?: string;
    fields?: CompiledField[];
    mcp?: CompiledEntityContract["mcp"];
    filterField?: string;
    relationships?: CompiledRelationship[];
  } = {},
): CompiledEntityContract =>
  ({
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
    storage: { table: "widgets", columns: [] },
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
    authorization: undefined as never,
    views: {},
    canonical: {} as never,
    profiles: {},
  }) as CompiledEntityContract;

const input = (
  c: CompiledEntityContract,
  slug = "widget",
  table = "erp.widgets",
): McpCatalogInput => ({
  slug,
  contract: c,
  table,
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
  });

  it("routes generic-style entities through the shared osf_* tools", () => {
    const catalog = buildMcpCatalog(
      [
        input(
          contract({
            mcp: {
              toolPrefix: "widget",
              tools: "generic",
              operations: {
                list: true,
                get: false,
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
    expect(catalog.tools[0]?.name).toBe("osf_list");
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
                  valueType: "integer",
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
                  valueType: "object",
                  semanticType: "fieldDefinition",
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
        valueType: "string",
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
                field({ key: "createdAt", valueType: "datetime" }),
                field({ key: "updatedAt", valueType: "datetime" }),
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
                  valueType: "object",
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

    it("constrains list sorting to scalar fields and mentions the filter field", () => {
      const catalog = buildMcpCatalog(
        [
          input(
            contract({
              filterField: "name",
              fields: [
                field({ key: "name" }),
                field({ key: "tags", cardinality: "collection" }),
                field({ key: "payload", valueType: "object" }),
              ],
            }),
          ),
        ],
        "test",
      );
      const list = catalog.tools.find((tool) => tool.operation === "list")!;
      expect(prop(list.inputSchema, "sortField").enum).toEqual(["name"]);
      expect(list.description).toContain('"name"');
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
      get: { name: "read_widget", description: "Read one Widget by id." },
      update: { name: "edit_widget" },
    },
  };

  it("uses override names and descriptions, composed defaults elsewhere", () => {
    const catalog = buildMcpCatalog(
      [input(contract({ mcp: mcpWithOverrides }))],
      "test",
    );
    const byOperation = new Map(
      catalog.tools.map((tool) => [tool.operation, tool]),
    );
    expect(byOperation.get("get")?.name).toBe("read_widget");
    expect(byOperation.get("get")?.description).toBe("Read one Widget by id.");
    expect(byOperation.get("update")?.name).toBe("edit_widget");
    // Description override was not authored for update: composed default stays.
    expect(byOperation.get("update")?.description).toContain(
      "Partially updates",
    );
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
            bindingsField: "bindings",
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

    const catalog = buildMcpCatalog(
      [
        input(owner, "service", "services.definitions"),
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
          list: false,
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
