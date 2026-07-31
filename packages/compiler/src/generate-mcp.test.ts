// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { buildMcpCatalog, MAX_DEDICATED_TOOLS, type McpCatalogInput } from "./generate-mcp.js";
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";

const field = (overrides: Partial<CompiledField> & { key: string }): CompiledField =>
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
  } = {},
): CompiledEntityContract =>
  ({
    contractVersion: 1,
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
    model: { fields: overrides.fields ?? [field({ key: "name" })], relationships: [] },
    graphql: {} as never,
    mcp: overrides.mcp ?? {
      toolPrefix: "widget",
      tools: "dedicated",
      operations: { list: true, get: true, create: true, update: true, delete: true },
    },
    authorization: undefined as never,
    views: {},
    canonical: {} as never,
    profiles: {},
  }) as CompiledEntityContract;

const input = (c: CompiledEntityContract, slug = "widget"): McpCatalogInput => ({
  slug,
  contract: c,
  table: "erp.widgets",
});

/** Read a named sub-schema, failing the test rather than returning undefined. */
const prop = (schema: Record<string, unknown>, key: string): Record<string, unknown> => {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
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
              operations: { list: true, get: true, create: false, update: false, delete: false },
            },
          }),
        ),
      ],
      "test",
    );
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["widget_list", "widget_get"]);
  });

  it("routes generic-style entities through the shared osf_* tools", () => {
    const catalog = buildMcpCatalog(
      [
        input(
          contract({
            mcp: {
              toolPrefix: "widget",
              tools: "generic",
              operations: { list: true, get: false, create: false, update: false, delete: false },
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
                  validation: { minLength: 1, maxLength: { value: 200 }, pattern: "^[a-z]+$" },
                }),
                field({ key: "score", valueType: "integer", validation: { min: 0, max: 10 } }),
              ],
            }),
          ),
        ],
        "test",
      );
      const create = catalog.tools.find((tool) => tool.operation === "create")!;
      expect(prop(create.inputSchema, "name")).toMatchObject({
        type: "string",
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
      expect(notes.description).toBe("Free text. Never put personal data here.");
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
                field({ key: "total", computed: { expression: "a+b", dependencies: ["a"] } }),
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
      expect(Object.keys(create.inputSchema.properties as object)).toEqual(["slug", "name"]);
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
                field({ key: "note", classification: { sensitivity: "internal" } }),
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
        [input(contract({ fields: [field({ key: "name", required: true })] }))],
        "test",
      );
      const update = catalog.tools.find((tool) => tool.operation === "update")!;
      expect(update.inputSchema.required).toEqual(["id", "values"]);
      const values = prop(update.inputSchema, "values");
      expect(values.required).toBeUndefined();
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
        input(contract({ name: "Zebra", mcp: { toolPrefix: "zebra", tools: "dedicated", operations: { list: true, get: false, create: false, update: false, delete: false } } }), "zebra"),
        input(contract({ name: "Alpha", mcp: { toolPrefix: "alpha", tools: "dedicated", operations: { list: true, get: false, create: false, update: false, delete: false } } }), "alpha"),
      ],
      "test",
    );
    expect(catalog.entities.map((entry) => entry.toolPrefix)).toEqual(["alpha", "zebra"]);
  });

  it("fails the build when the dedicated tool count would flood tool selection", () => {
    const many = Array.from({ length: MAX_DEDICATED_TOOLS / 5 + 1 }, (_unused, index) =>
      input(
        contract({
          name: `Entity${index}`,
          mcp: {
            toolPrefix: `entity_${index}`,
            tools: "dedicated",
            operations: { list: true, get: true, create: true, update: true, delete: true },
          },
        }),
        `entity-${index}`,
      ),
    );
    expect(() => buildMcpCatalog(many, "test")).toThrow(/over the 60 limit/);
  });
});
