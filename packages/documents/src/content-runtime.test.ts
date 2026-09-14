// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { composeTemplate, contentFieldProjection, materializeFields, materializeTemplate } from "./content-runtime.js";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001", template: "10000000-0000-4000-8000-000000000002",
  version: "10000000-0000-4000-8000-000000000003", variant: "10000000-0000-4000-8000-000000000004",
  block: "10000000-0000-4000-8000-000000000005", chip: "10000000-0000-4000-8000-000000000006",
};
const carrier: RuntimeEntityValueCarrier = {
  entityName: "Block", fieldKey: "values", definitionField: "definitionKey", schema: "erp", table: "blocks",
  valuesColumn: "values", definitionColumn: "definition_key",
  definitions: {
    TextBlock: {
      entityName: "TextBlock", schemaVersion: 1, definitionHash: "a".repeat(64), fields: [{ key: "text", valueType: "string", required: true }],
      valueSchema: { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"], additionalProperties: false },
      references: [], materializeOperationId: "TextBlock.materialize",
    },
    IncludeBlock: {
      entityName: "IncludeBlock", schemaVersion: 1, definitionHash: "b".repeat(64), fields: [{ key: "version", valueType: "string", required: true, relationship: { target: "TemplateVersion" } }, { key: "parameters", valueType: "object" }],
      valueSchema: { type: "object", properties: { parameters: { type: "object" } }, additionalProperties: false },
      references: [{ fieldKey: "version", targetEntity: "TemplateVersion", schema: "erp", table: "template_versions", column: "include_version_id", required: true }],
    },
  },
};

function fixture(blockDefault?: string, withReference = false) {
  const authorizations: string[] = [];
  const calls: { schema: unknown; values: unknown }[] = [];
  const executions: unknown[] = [];
  const reads: string[] = [];
  const queries: string[] = [];
  const data = { text: "Hello {{local.name}} from {{chips.brand}}", chip: "Example", tenant: ids.tenant, unavailableOperation: false, denyBlock: false, disallowText: false,
    redactChip: false, redactBlock: false, omitBlockText: false, missingRead: "" };
  const compiledCarrier = structuredClone({ ...carrier, definitions: { ...carrier.definitions,
    TextBlock: { ...carrier.definitions.TextBlock!, fields: [{ key: "text", valueType: "string", required: true,
      ...(blockDefault === undefined ? {} : { defaultValue: blockDefault }) },
      ...(withReference ? [{ key: "brand", valueType: "string", required: true, relationship: { target: "Chip" } }] : [])],
      references: withReference ? [{ fieldKey: "brand", targetEntity: "Chip", column: "text_brand_id", schema: "erp", table: "chips", required: true }] : [],
    },
  } });
  const op = {
    id: "TextBlock.materialize", intent: "invoke", effects: { data: "read", external: "none" },
    input: { kind: "json-schema", schema: { type: "object", required: ["definitionKey", "values"], properties: { definitionKey: { const: "TextBlock" }, values: { type: "object" } } } },
  };
  const context = {
    transport: "operation",
    session: { tenantId: ids.tenant, userId: ids.tenant, credential: "bearer", roles: ["General.All.Read"], groups: [], scope: "tenant" },
    platform: {
      records: { async assertAccess(_session: unknown, request: { entityName: string; id: string }) {
        authorizations.push(`${request.entityName}:${request.id}`);
        if (data.denyBlock && request.entityName === "Block") throw operationFailure({ code: "FORBIDDEN", message: "Not allowed." });
      } },
      schemas: {
        entityValues: { get: () => compiledCarrier, collection: () => ({ targetEntity: "Block", allowedDefinitions: data.disallowText ? ["IncludeBlock"] : Object.keys(carrier.definitions) }) },
        fields: {
          object: () => ({ type: "object", properties: { name: { type: "string", default: "Reader" } } }),
          validateObject: () => ({ valid: true }),
        },
        json: { validate(schema: unknown, values: unknown) { calls.push({ schema, values }); return { valid: true }; } },
      },
      db: { async withSession(_session: unknown, work: (trx: unknown) => unknown) {
        return work({ async executeQuery(query: { sql: string; parameters: unknown[] }) {
          queries.push(query.sql);
          expect(query.parameters[0]).toBe(ids.tenant);
          if (query.sql.includes("from erp.template_versions")) return { rows: [{ id: ids.version, tenant_id: data.tenant, template_id: ids.template, version_number: 1, parameters: [{ key: "name", valueType: "string", defaultValue: "Reader" }] }] };
          if (query.sql.includes("from erp.template_variants")) return { rows: [{ id: ids.variant, channel: "document", locale: "en" }] };
          if (query.sql.includes('from "erp"."blocks"')) return { rows: [{ id: ids.block, definition_key: "TextBlock", definition_version: 1, values: { text: data.text } }] };
          if (query.sql.includes("from erp.chips")) return { rows: [{ id: ids.chip, tenant_id: ids.tenant, value: data.chip, version: "2026-01-01T00:00:00Z" }] };
          throw new Error(`Unexpected query: ${query.sql}`);
        } });
      } },
      operations: {
        list: async () => ["TemplateVersion", "TemplateVariant", "Block", "Chip"].filter(entity => entity !== data.missingRead).map(entityName => ({
          id: `${entityName}.get`, entityName, intent: "get", effects: { data: "read", external: "none" },
        })),
        get: async () => data.unavailableOperation ? undefined : op,
        async execute(_session: unknown, request: { operation: { intent: string; entityName?: string }; input: Record<string, unknown> }) {
          if (request.operation.intent === "get") {
            const entity = request.operation.entityName!;
            reads.push(entity);
            const base = { id: request.input.id, tenantId: data.tenant, updatedAt: "2026-01-01T00:00:00Z" };
            const records: Record<string, unknown> = {
              TemplateVersion: { ...base, template: ids.template, versionNumber: 1, parameters: [{ key: "name", valueType: "string", defaultValue: "Reader" }] },
              TemplateVariant: { ...base, version: ids.version, channel: "document", locale: "en" },
              Block: { ...base, variant: ids.variant, definitionKey: "TextBlock", definitionVersion: 1,
                values: data.redactBlock ? null : { ...(data.omitBlockText ? {} : { text: data.text }), ...(withReference ? { brand: ids.chip } : {}) } },
              Chip: { ...base, key: "brand", value: data.redactChip ? null : data.chip },
            };
            return { data: records[entity], operations: [] };
          }
          executions.push(request);
          if (withReference) return { data: { kind: "block", value: request.input.values }, operations: [] };
          const result = await materializeFields(request.input, context as unknown as ModuleOperationContext);
          if ("value" in result) return { data: result.value, operations: [] };
          throw new Error("Unexpected handler failure.");
        },
      },
    },
  };
  return { context: context as unknown as ModuleOperationContext, data, authorizations, calls, executions, reads, queries, carrier: compiledCarrier };
}

describe("template materialization runtime adapter", () => {
  test("reads scoped records, applies local/chip values and invokes the canonical block Operation", async () => {
    const f = fixture();
    const response = await materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context);
    expect("value" in response).toBe(true);
    const snapshot = (response as { value: { blocks: Array<{ values: { text: string }; materialization: unknown }> } }).value;
    expect(snapshot.blocks[0]!.values.text).toBe("Hello Reader from Example");
    expect(snapshot.blocks[0]!.materialization).toEqual({ operationId: "TextBlock.materialize", result: { kind: "block", value: { text: "Hello Reader from Example" } } });
    expect(f.authorizations).toEqual([`TemplateVersion:${ids.version}`, `Template:${ids.template}`, `TemplateVariant:${ids.variant}`, `Block:${ids.block}`, `Chip:${ids.chip}`]);
    expect(f.calls[0]!.schema).toBe(f.carrier.definitions.TextBlock!.valueSchema);
    expect(f.reads).toEqual(["TemplateVersion", "TemplateVariant", "Block", "Chip"]);
    expect(f.queries.every(query => query.startsWith("select id from "))).toBe(true);
    expect(f.executions).toHaveLength(1);
    f.data.chip = "Changed";
    expect(snapshot.blocks[0]!.values.text).toBe("Hello Reader from Example");
  });
  test("does not return data after a denied block read or missing materialization Operation", async () => {
    const f = fixture();
    f.data.denyBlock = true;
    await expect(materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context)).rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } });
    expect(f.executions).toHaveLength(0);
    f.data.denyBlock = false;
    f.data.unavailableOperation = true;
    await expect(materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context)).rejects.toMatchObject({ operationError: { code: "OPERATION_UNAVAILABLE" } });
  });
  test("never exposes a confidential Chip value when canonical get redacts it", async () => {
    const f = fixture();
    f.data.chip = "confidential-fixture-value";
    f.data.redactChip = true;
    let failure: unknown;
    try {
      await materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context);
    } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(f.reads).toContain("Chip");
    expect(f.executions).toHaveLength(0);
    expect(JSON.stringify(failure)).not.toContain(f.data.chip);
    expect(JSON.stringify(f.calls)).not.toContain(f.data.chip);
    expect(f.queries.every(query => query.startsWith("select id from "))).toBe(true);
  });
  test("never reads Block.values around canonical redaction or restores omitted leaves", async () => {
    for (const policy of ["redactBlock", "omitBlockText"] as const) {
      // A default must not reintroduce a field omitted by the authorized read.
      const f = fixture("confidential-block-fixture");
      f.data.text = "confidential-block-fixture";
      f.data[policy] = true;
      let failure: unknown;
      try {
        await materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context);
      } catch (error) { failure = error; }
      expect(failure).toBeDefined();
      expect(f.reads).toContain("Block");
      expect(f.executions).toHaveLength(0);
      expect(JSON.stringify(failure)).not.toContain(f.data.text);
    }
  });
  test("fails closed without canonical source reads and rejects a mismatched tenant", async () => {
    for (const entity of ["TemplateVersion", "TemplateVariant", "Block", "Chip"]) {
      const f = fixture();
      f.data.missingRead = entity;
      await expect(materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context))
        .rejects.toMatchObject({ operationError: { code: "OPERATION_UNAVAILABLE" } });
      expect(f.executions).toHaveLength(0);
    }
    const f = fixture();
    f.data.tenant = ids.chip;
    await expect(materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context))
      .rejects.toMatchObject({ operationError: { code: "DEPENDENCY_INVALID" } });
  });
  test("uses authorized logical reference IDs and preserves reference-field redaction in frozen sources", async () => {
    const f = fixture(undefined, true);
    f.data.text = "Public caption";
    f.data.chip = "confidential-reference-fixture";
    f.data.redactChip = true;
    const result = await materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context);
    const snapshot = (result as { value: { blocks: Array<{ values: unknown; references: Record<string, unknown> }> } }).value;
    expect(snapshot.blocks[0]!.values).toEqual({ text: "Public caption" });
    expect(snapshot.blocks[0]!.references.brand).toMatchObject({ entity: "Chip", id: ids.chip, value: { value: null } });
    expect(JSON.stringify(snapshot)).not.toContain(f.data.chip);
    expect(f.queries.every(query => query.startsWith("select id from "))).toBe(true);
  });
  test("requires typed relational inclusion and never treats values.version as a reference", async () => {
    const f = fixture();
    await expect(composeTemplate({ definitionKey: "IncludeBlock", referenceField: "version", parametersField: "parameters", values: { parameters: {} }, references: {} }, f.context)).rejects.toMatchObject({ operationError: { code: "VALIDATION" } });
    const result = await composeTemplate({ definitionKey: "IncludeBlock", referenceField: "version", parametersField: "parameters", values: { parameters: { name: "Ada" } }, references: { version: { entity: "TemplateVersion", id: ids.version } } }, f.context);
    expect(result).toEqual({ value: { kind: "template", referenceField: "version", parameters: { name: "Ada" } } });
  });
  test("uses the owning collection allowlist rather than the union of loaded definitions", async () => {
    const f = fixture();
    f.data.disallowText = true;
    await expect(materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context))
      .rejects.toMatchObject({ operationError: { code: "BLOCK_NOT_ALLOWED" } });
    expect(f.executions).toHaveLength(0);
  });
  test("keeps resolved cardinality and nested fields in the snapshot projection", () => {
    expect(contentFieldProjection({ valueType: "object", cardinality: "collection", cardinalityBounds: { min: 1, max: 3 }, children: [{ key: "title", valueType: "string", required: true }] })).toMatchObject({ cardinality: { min: 1, max: 3 }, fields: { title: { valueType: "string", required: true } } });
  });
});
