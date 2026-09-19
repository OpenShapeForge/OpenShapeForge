// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
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
      entityName: "TextBlock", schemaVersion: 1, definitionHash: "a".repeat(64), fields: [{ key: "text", osfType: "string", baseType: "string", required: true }],
      valueSchema: { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"], additionalProperties: false },
      references: [], materializeOperationId: "TextBlock.materialize",
    },
    IncludeBlock: {
      entityName: "IncludeBlock", schemaVersion: 1, definitionHash: "b".repeat(64), fields: [{ key: "version", osfType: "TemplateVersion", baseType: "string", required: true, relationship: { target: "TemplateVersion" } }, { key: "parameters", osfType: "object", baseType: "object" }],
      valueSchema: { type: "object", properties: { parameters: { type: "object" } }, additionalProperties: false },
      references: [{ fieldKey: "version", targetEntity: "TemplateVersion", schema: "erp", table: "template_versions", column: "include_version_id", required: true }],
    },
  },
};

function fixture(blockDefault?: string, withReference = false, withBinding = false) {
  const authorizations: string[] = [];
  const calls: { schema: unknown; values: unknown }[] = [];
  const executions: unknown[] = [];
  const reads: string[] = [];
  const queries: string[] = [];
  const data = { text: "Hello {{local.name}} from {{chips.brand}}", chip: "Example", tenant: ids.tenant, unavailableOperation: false, disallowText: false,
    redactChip: false, missingRead: "", snapshotTemplate: ids.template, liveText: "LIVE-ROW-MUST-NOT-LEAK", variantLocale: "en", variantDefault: false };
  const compiledCarrier = structuredClone({ ...carrier, definitions: { ...carrier.definitions,
    TextBlock: { ...carrier.definitions.TextBlock!, fields: [{ key: "text", osfType: "string", baseType: "string", required: true,
      ...(blockDefault === undefined ? {} : { defaultValue: blockDefault }) },
      ...(withReference ? [{ key: "brand", osfType: "Chip", baseType: "string", required: true, relationship: { target: "Chip" } }] : [])],
      references: withReference ? [{ fieldKey: "brand", targetEntity: "Chip", column: "text_brand_id", schema: "erp", table: "chips", required: true,
        ...(withBinding ? { parameterColumn: "text_brand_parameter" } : {}) }] : [],
    },
  } });
  const op = {
    id: "TextBlock.materialize", intent: "invoke", effects: { data: "read", external: "none" },
    output: { kind: "json-schema", schema: { type: "object", properties: { value: { type: "object", properties: { text: { type: "string", title: "Text" } } } } } },
    input: { kind: "json-schema", schema: { type: "object", required: ["definitionKey", "values"], properties: { definitionKey: { const: "TextBlock" }, values: { type: "object" } } } },
  };
  const context = {
    transport: "operation",
    session: { tenantId: ids.tenant, userId: ids.tenant, credential: "bearer", roles: ["General.All.Read"], groups: [], scope: "tenant" },
    platform: {
      records: { async assertAccess(_session: unknown, request: { entityName: string; id: string }) {
        authorizations.push(`${request.entityName}:${request.id}`);
      } },
      schemas: {
        entityValues: { get: () => compiledCarrier, collection: () => ({ targetEntity: "Block", allowedDefinitions: data.disallowText ? ["IncludeBlock"] : Object.keys(carrier.definitions) }) },
        fields: {
          object: () => ({ type: "object", properties: { name: { type: "string", default: "Reader" },
            ...(withBinding ? { brand: { type: "string", format: "uuid", "x-osf-reference": { entity: "Chip" } } } : {}) } }),
          validateObject: () => ({ valid: true }),
        },
        json: { validate(schema: unknown, values: unknown) { calls.push({ schema, values }); return { valid: true }; } },
      },
      db: { async withSession(_session: unknown, work: (trx: unknown) => unknown) {
        return work({ async executeQuery(query: { sql: string; parameters: unknown[] }) {
          queries.push(query.sql);
          expect(query.parameters[0]).toBe(ids.tenant);
          if (query.sql.includes("from erp.template_versions")) return { rows: [{ id: ids.version }] };
          // Live variant and block rows exist but must never be consulted: the
          // published snapshot is the only source of frozen content.
          if (/template_variants|blocks/.test(query.sql)) throw new Error(`Live content table read: ${query.sql}`);
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
            const blockRow = { id: ids.block, tenant_id: data.tenant, variant_id: ids.variant, variant_id_position: 0, definition_key: "TextBlock", definition_version: 1, values: { text: data.text },
              ...(withReference ? (withBinding ? { text_brand_parameter: "brand", text_brand_id: null } : { text_brand_id: ids.chip, text_brand_parameter: null }) : {}) };
            const snapshot = { schemaVersion: 1, entity: "Template", head: { table: "templates",
              row: { id: data.snapshotTemplate, tenant_id: data.tenant, parameters: [{ key: "name", osfType: "string", defaultValue: "Reader" }] },
              children: { template_variants: [
                { table: "template_variants", row: { id: ids.variant, tenant_id: data.tenant, template_id: ids.template, channel: "document", locale: data.variantLocale, is_default: data.variantDefault }, children: { blocks: [{ table: "blocks", row: blockRow, children: {} }] } },
                { table: "template_variants", row: { id: ids.chip, tenant_id: data.tenant, template_id: ids.template, channel: "email", locale: "en" }, children: { blocks: [] } },
              ] } } };
            const records: Record<string, unknown> = {
              TemplateVersion: { ...base, template: ids.template, versionNumber: 1, snapshot },
              // Live rows drifted after publish; a materialization that shows them is a bug.
              TemplateVariant: { ...base, template: ids.template, channel: "document", locale: "en" },
              Block: { ...base, variant: ids.variant, definitionKey: "TextBlock", definitionVersion: 1, values: { text: data.liveText } },
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
  test("preserves entity parameter metadata and resolves symbolic references via canonical reads", async () => {
    const f = fixture(undefined, true, true);
    const response = await materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en", parameters: { brand: ids.chip } }, f.context);
    expect("value" in response).toBe(true);
    expect(f.reads).toContain("Chip");
    expect(f.executions).toHaveLength(1);
    expect((response as any).value.templates[0].version.variants[0].blocks[0].references.brand).toEqual({ parameter: "brand" });
    const missing = fixture(undefined, true, true);
    await expect(materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, missing.context)).rejects.toBeDefined();
    expect(missing.executions).toHaveLength(0);
  });
  test("reads scoped records, applies local/chip values and invokes the canonical block Operation", async () => {
    const f = fixture();
    const response = await materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context);
    expect("value" in response).toBe(true);
    const snapshot = (response as { value: { blocks: Array<{ values: { text: string }; materialization: unknown }> } }).value;
    expect(snapshot.blocks[0]!.values.text).toBe("Hello Reader from Example");
    expect(snapshot.blocks[0]!.materialization).toEqual({ operationId: "TextBlock.materialize", result: { kind: "block", value: { text: "Hello Reader from Example" } } });
    expect(f.authorizations).toEqual([`TemplateVersion:${ids.version}`, `Template:${ids.template}`, `Chip:${ids.chip}`]);
    expect(f.calls[0]!.schema).toBe(f.carrier.definitions.TextBlock!.valueSchema);
    expect(f.reads).toEqual(["TemplateVersion", "Chip"]);
    expect(JSON.stringify(snapshot)).not.toContain(f.data.liveText);
    expect(f.queries.every(query => query.startsWith("select id from "))).toBe(true);
    expect(f.executions).toHaveLength(1);
    expect((response as any).value.definitions.TextBlock.materializationSchema.properties.value.properties.text.title).toBe("Text");
    f.data.chip = "Changed";
    expect(snapshot.blocks[0]!.values.text).toBe("Hello Reader from Example");
  });
  test("does not return data when the block materialization Operation is missing", async () => {
    const f = fixture();
    f.data.unavailableOperation = true;
    await expect(materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context)).rejects.toMatchObject({ operationError: { code: "OPERATION_UNAVAILABLE" } });
    expect(f.executions).toHaveLength(0);
  });
  test("rejects a snapshot frozen for another template and a locale that was never published", async () => {
    const f = fixture();
    f.data.snapshotTemplate = ids.chip;
    await expect(materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "en" }, f.context)).rejects.toMatchObject({ operationError: { code: "DEPENDENCY_INVALID" } });
    const g = fixture();
    await expect(materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "nl" }, g.context)).rejects.toBeDefined();
    expect(g.executions).toHaveLength(0);
    expect(g.reads).toEqual(["TemplateVersion"]);
  });
  test("serves the frozen variant of the requested language, or the channel's frozen default", async () => {
    const f = fixture();
    f.data.variantLocale = "nl";
    const served = await materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "nl-NL" }, f.context);
    expect((served as { value: { templates: { variantId: string; version: { variants: { locale: string }[] } }[] } }).value.templates[0]!.version.variants[0]!.locale).toBe("nl");
    const g = fixture();
    g.data.variantDefault = true;
    const fallback = await materializeTemplate({ templateVersionId: ids.version, channel: "document", locale: "nl" }, g.context);
    expect((fallback as { value: { templates: { variantId: string }[] } }).value.templates[0]!.variantId).toBe(ids.variant);
    expect(g.executions).toHaveLength(1);
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
  test("fails closed without canonical source reads and rejects a mismatched tenant", async () => {
    for (const entity of ["TemplateVersion", "Chip"]) {
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
    expect(contentFieldProjection({ osfType: "object", baseType: "object", cardinality: "collection", cardinalityBounds: { min: 1, max: 3 }, children: [{ key: "title", osfType: "string", baseType: "string", required: true }] })).toMatchObject({ cardinality: { min: 1, max: 3 }, fields: { title: { baseType: "string", required: true } } });
  });
});
