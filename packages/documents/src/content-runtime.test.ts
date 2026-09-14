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

function fixture() {
  const authorizations: string[] = [];
  const calls: { schema: unknown; values: unknown }[] = [];
  const executions: unknown[] = [];
  const data = { text: "Hello {{local.name}} from {{chips.brand}}", chip: "Example", tenant: ids.tenant, unavailableOperation: false, denyBlock: false, disallowText: false };
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
        entityValues: { get: () => carrier, collection: () => ({ targetEntity: "Block", allowedDefinitions: data.disallowText ? ["IncludeBlock"] : Object.keys(carrier.definitions) }) },
        fields: {
          object: () => ({ type: "object", properties: { name: { type: "string", default: "Reader" } } }),
          validateObject: () => ({ valid: true }),
        },
        json: { validate(schema: unknown, values: unknown) { calls.push({ schema, values }); return { valid: true }; } },
      },
      db: { async withSession(_session: unknown, work: (trx: unknown) => unknown) {
        return work({ async executeQuery(query: { sql: string; parameters: unknown[] }) {
          expect(query.parameters[0]).toBe(ids.tenant);
          if (query.sql.includes("from erp.template_versions")) return { rows: [{ id: ids.version, tenant_id: data.tenant, template_id: ids.template, version_number: 1, parameters: [{ key: "name", valueType: "string", defaultValue: "Reader" }] }] };
          if (query.sql.includes("from erp.template_variants")) return { rows: [{ id: ids.variant, channel: "document", locale: "en" }] };
          if (query.sql.includes('from "erp"."blocks"')) return { rows: [{ id: ids.block, definition_key: "TextBlock", definition_version: 1, values: { text: data.text } }] };
          if (query.sql.includes("from erp.chips")) return { rows: [{ id: ids.chip, tenant_id: ids.tenant, value: data.chip, version: "2026-01-01T00:00:00Z" }] };
          throw new Error(`Unexpected query: ${query.sql}`);
        } });
      } },
      operations: {
        list: async () => [],
        get: async () => data.unavailableOperation ? undefined : op,
        async execute(_session: unknown, request: { input: Record<string, unknown> }) {
          executions.push(request);
          const result = await materializeFields(request.input, context as unknown as ModuleOperationContext);
          if ("value" in result) return { data: result.value, operations: [] };
          throw new Error("Unexpected handler failure.");
        },
      },
    },
  };
  return { context: context as unknown as ModuleOperationContext, data, authorizations, calls, executions };
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
    expect(f.calls[0]!.schema).toBe(carrier.definitions.TextBlock!.valueSchema);
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
