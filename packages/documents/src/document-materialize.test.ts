// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { ModuleOperationContext, RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { contentBlockFromRow } from "./content-snapshot.js";
import { materializeDocument } from "./document-materialize.js";

const ids = {
  tenant: "20000000-0000-4000-8000-000000000001", template: "20000000-0000-4000-8000-000000000002",
  version: "20000000-0000-4000-8000-000000000003", templateVariant: "20000000-0000-4000-8000-000000000004",
  templateBlock: "20000000-0000-4000-8000-000000000005", document: "20000000-0000-4000-8000-000000000006",
  documentVariant: "20000000-0000-4000-8000-000000000007", first: "20000000-0000-4000-8000-000000000008",
  second: "20000000-0000-4000-8000-000000000009", include: "20000000-0000-4000-8000-00000000000a",
  included: "20000000-0000-4000-8000-00000000000b", includedVariant: "20000000-0000-4000-8000-00000000000c",
  includedBlock: "20000000-0000-4000-8000-00000000000d",
};
const carrier: RuntimeEntityValueCarrier = {
  entityName: "Block", fieldKey: "values", definitionField: "definitionKey", schema: "erp", table: "blocks",
  valuesColumn: "values", definitionColumn: "definition_key",
  definitions: {
    TextBlock: {
      entityName: "TextBlock", schemaVersion: 1, definitionHash: "a".repeat(64), fields: [{ key: "markdown", osfType: "markdown", baseType: "string", required: true }],
      valueSchema: { type: "object", properties: { markdown: { type: "string", minLength: 1 } }, required: ["markdown"], additionalProperties: false },
      references: [], materializeOperationId: "TextBlock.materialize",
    },
    IncludeBlock: {
      entityName: "IncludeBlock", schemaVersion: 1, definitionHash: "b".repeat(64),
      fields: [{ key: "version", osfType: "TemplateVersion", baseType: "string", required: true, relationship: { target: "TemplateVersion" } }, { key: "parameters", osfType: "object", baseType: "object" }],
      valueSchema: { type: "object", properties: { parameters: { type: "object" } }, additionalProperties: false },
      references: [{ fieldKey: "version", targetEntity: "TemplateVersion", schema: "erp", table: "template_versions", column: "include_version_id", required: true }],
      materializeOperationId: "IncludeBlock.compose",
    },
  },
};
const operations = {
  "TextBlock.materialize": {
    id: "TextBlock.materialize", intent: "invoke", effects: { data: "read", external: "none" },
    output: { kind: "json-schema", schema: { type: "object" } },
    input: { kind: "json-schema", schema: { type: "object", required: ["definitionKey", "values"], properties: { definitionKey: { const: "TextBlock" }, values: { type: "object" } } } },
  },
  "IncludeBlock.compose": {
    id: "IncludeBlock.compose", intent: "invoke", effects: { data: "read", external: "none" },
    output: { kind: "json-schema", schema: { type: "object" } },
    input: { kind: "json-schema", schema: { type: "object", properties: { definitionKey: { const: "IncludeBlock" }, values: { type: "object" }, references: { type: "object" } } } },
  },
} as const;

function templateSnapshot(templateId: string, variantId: string, blocks: Record<string, unknown>[]) {
  return { schemaVersion: 1, entity: "Template", head: { table: "templates",
    row: { id: templateId, tenant_id: ids.tenant, parameters: [{ key: "name", osfType: "string", defaultValue: "Reader" }] },
    children: { template_variants: [
      { table: "template_variants", row: { id: variantId, tenant_id: ids.tenant, template_id: templateId, channel: "document", locale: "en" }, children: { blocks: blocks.map((row) => ({ table: "blocks", row, children: {} })) } },
    ] } } };
}

function fixture(options: { templateVersionId?: string | null; parameters?: unknown; withInclusion?: boolean } = {}) {
  const templateVersionId = options.templateVersionId === undefined ? ids.version : options.templateVersionId;
  const authorizations: string[] = [];
  const reads: string[] = [];
  const queries: string[] = [];
  const validated: unknown[] = [];
  const executions: { id: string; input: Record<string, unknown> }[] = [];
  const data = { firstText: "First {{local.name}}", secondText: "Second", frozenText: "FROZEN-TEMPLATE-TEXT", includedText: "Included {{local.name}}" };
  const documentBlocks = () => [
    { id: ids.first, tenant_id: ids.tenant, document_variant_id: ids.documentVariant, document_variant_id_position: 0, variant_id: null, origin: "template", template_block_id: ids.templateBlock, diverged: true, locked: false, definition_key: "TextBlock", definition_version: 1, values: { markdown: data.firstText }, include_version_id: null },
    ...(options.withInclusion ? [{ id: ids.include, tenant_id: ids.tenant, document_variant_id: ids.documentVariant, document_variant_id_position: 1, variant_id: null, origin: "local", template_block_id: null, diverged: false, locked: false, definition_key: "IncludeBlock", definition_version: 1, values: { parameters: {} }, include_version_id: ids.included }] : []),
    { id: ids.second, tenant_id: ids.tenant, document_variant_id: ids.documentVariant, document_variant_id_position: 2, variant_id: null, origin: "local", template_block_id: null, diverged: false, locked: false, definition_key: "TextBlock", definition_version: 1, values: { markdown: data.secondText }, include_version_id: null },
  ];
  const context = {
    transport: "operation",
    session: { tenantId: ids.tenant, userId: ids.tenant, credential: "bearer", roles: ["CaseFile.All.Read"], groups: [], scope: "tenant" },
    platform: {
      records: {
        async assertAccess(_session: unknown, request: { entityName: string; id: string }) { authorizations.push(`${request.entityName}:${request.id}`); },
        projectStoredFields(_session: unknown, request: { fields: Record<string, unknown> }) { return request.fields; },
      },
      schemas: {
        entityValues: { get: () => carrier, collection: (entity: string) => ({ targetEntity: "Block", allowedDefinitions: entity === "DocumentVariant" ? ["TextBlock", "IncludeBlock"] : ["TextBlock", "IncludeBlock"] }) },
        fields: {
          object: () => ({ type: "object", properties: { name: { type: "string", default: "Reader" } } }),
          validateObject(_fields: unknown, values: unknown) { validated.push(values); return { valid: true }; },
        },
        json: { validate: () => ({ valid: true }) },
      },
      db: { async withSession(_session: unknown, work: (trx: unknown) => unknown) {
        return work({ async executeQuery(query: { sql: string; parameters: unknown[] }) {
          queries.push(query.sql);
          expect(query.parameters[0]).toBe(ids.tenant);
          if (query.sql.includes("from erp.documents")) return { rows: [{ id: ids.document, template_version_id: templateVersionId, parameters: options.parameters === undefined ? { name: "Ada" } : options.parameters }] };
          if (query.sql.includes("from erp.template_versions")) {
            // The pinned version is read raw under the document's authority; an inclusion's row is only locked here.
            if (!query.sql.startsWith("select template_id")) return { rows: [{ id: query.parameters[1] }] };
            expect(query.parameters[1]).toBe(ids.version);
            const frozenBlock = { id: ids.templateBlock, tenant_id: ids.tenant, variant_id: ids.templateVariant, variant_id_position: 0, definition_key: "TextBlock", definition_version: 1, values: { markdown: data.frozenText } };
            return { rows: [{ template_id: ids.template, version_number: 3, snapshot: templateSnapshot(ids.template, ids.templateVariant, [frozenBlock]) }] };
          }
          if (query.sql.includes("from erp.document_variants")) {
            return { rows: query.parameters[2] === "document" ? [{ id: ids.documentVariant, channel: "document", locale: "en" }] : [] };
          }
          if (query.sql.includes("from erp.blocks")) {
            expect(query.parameters[1]).toBe(ids.documentVariant);
            return { rows: documentBlocks().map((row) => ({ row })) };
          }
          throw new Error(`Unexpected query: ${query.sql}`);
        } });
      } },
      operations: {
        list: async () => ["TemplateVersion", "Document"].map((entityName) => ({ id: `${entityName}.get`, entityName, intent: "get", effects: { data: "read", external: "none" } })),
        get: async (_session: unknown, id: keyof typeof operations) => operations[id],
        async execute(_session: unknown, request: { operation: { id: string; intent: string; entityName?: string }; input: Record<string, unknown> }) {
          if (request.operation.intent === "get") {
            reads.push(`${request.operation.entityName}:${request.input.id}`);
            const base = { id: request.input.id, tenantId: ids.tenant, updatedAt: "2026-01-01T00:00:00Z" };
            if (request.input.id === ids.version) {
              const frozenBlock = { id: ids.templateBlock, tenant_id: ids.tenant, variant_id: ids.templateVariant, variant_id_position: 0, definition_key: "TextBlock", definition_version: 1, values: { markdown: data.frozenText } };
              return { data: { ...base, template: ids.template, versionNumber: 3, snapshot: templateSnapshot(ids.template, ids.templateVariant, [frozenBlock]) }, operations: [] };
            }
            if (request.input.id === ids.included) {
              const includedBlock = { id: ids.includedBlock, tenant_id: ids.tenant, variant_id: ids.includedVariant, variant_id_position: 0, definition_key: "TextBlock", definition_version: 1, values: { markdown: data.includedText } };
              return { data: { ...base, template: ids.include, versionNumber: 1, snapshot: templateSnapshot(ids.include, ids.includedVariant, [includedBlock]) }, operations: [] };
            }
            return { data: null, operations: [] };
          }
          executions.push({ id: request.operation.id, input: request.input });
          if (request.operation.id === "IncludeBlock.compose") return { data: { kind: "template", referenceField: "version", parameters: {} }, operations: [] };
          return { data: { kind: "block", value: request.input.values }, operations: [] };
        },
      },
    },
  };
  return { context: context as unknown as ModuleOperationContext, data, authorizations, reads, queries, validated, executions };
}

const request = { id: ids.document, channel: "document", locale: "en" };

describe("contentBlockFromRow", () => {
  const selection = { tenantId: ids.tenant, carrier, definitionVersionColumn: "definition_version" };
  test("projects a live document block row to the engine's block and keeps reference slots out of values", () => {
    const row = { id: ids.include, tenant_id: ids.tenant, document_variant_id: ids.documentVariant, origin: "local", locked: false, definition_key: "IncludeBlock", definition_version: 2, values: { parameters: { name: "Ada" }, version: "smuggled" }, include_version_id: ids.included };
    expect(contentBlockFromRow(row, { column: "document_variant_id", id: ids.documentVariant }, selection, "stored")).toEqual({
      id: ids.include, definitionKey: "IncludeBlock", schemaVersion: 2, values: { parameters: { name: "Ada" } }, references: { version: { entity: "TemplateVersion", id: ids.included } },
    });
  });
  test("refuses a row owned by another variant, without a definition version, or of an unknown definition", () => {
    const row = { id: ids.first, tenant_id: ids.tenant, document_variant_id: ids.documentVariant, definition_key: "TextBlock", definition_version: 1, values: { markdown: "x" } };
    expect(() => contentBlockFromRow(row, { column: "document_variant_id", id: ids.second }, selection, "stored")).toThrow(/stored block belongs to another variant/);
    expect(() => contentBlockFromRow({ ...row, definition_version: null }, { column: "document_variant_id", id: ids.documentVariant }, selection, "stored")).toThrow(/no definition version/);
    expect(() => contentBlockFromRow({ ...row, definition_key: "Unknown" }, { column: "document_variant_id", id: ids.documentVariant }, selection)).toThrow();
  });
});

describe("Document.materialize", () => {
  test("refuses a document without a linked template version before reading any content", async () => {
    const f = fixture({ templateVersionId: null });
    await expect(materializeDocument(request, f.context)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    expect(f.authorizations).toEqual([`Document:${ids.document}`]);
    expect(f.reads).toEqual([]);
    expect(f.queries).toHaveLength(1);
  });
  test("materializes the root from the document's live variants and blocks, not the frozen snapshot", async () => {
    const f = fixture();
    const response = await materializeDocument(request, f.context);
    expect("value" in response).toBe(true);
    const snapshot = (response as any).value;
    expect(snapshot.templateVersionId).toBe(ids.version);
    expect(snapshot.templates[0].version).toMatchObject({ id: ids.version, templateId: ids.template, versionNumber: 3 });
    expect(snapshot.templates[0].version.variants[0].id).toBe(ids.documentVariant);
    expect(snapshot.blocks.map((block: { id: string }) => block.id)).toEqual([ids.first, ids.second]);
    expect(snapshot.blocks[0].values.markdown).toBe("First Ada");
    expect(snapshot.blocks[1].values.markdown).toBe("Second");
    expect(JSON.stringify(snapshot)).not.toContain(f.data.frozenText);
    // The pinned version is the document's own: its read needs no TemplateVersion or Template role.
    expect(f.authorizations).toEqual([`Document:${ids.document}`]);
    expect(f.reads).toEqual([]);
    expect(f.queries.filter((query) => !query.startsWith("select template_id")).every((query) => /for share$/.test(query))).toBe(true);
    expect(f.executions.map((execution) => execution.id)).toEqual(["TextBlock.materialize", "TextBlock.materialize"]);
  });
  test("passes the document's stored parameters to the engine and defaults a missing row value to an empty object", async () => {
    const f = fixture();
    await materializeDocument(request, f.context);
    expect(f.validated).toEqual([{ name: "Ada" }]);
    const g = fixture({ parameters: null });
    const response = await materializeDocument(request, g.context);
    // The engine fills defaults before validation, so an absent row value only leaves the template default.
    expect(g.validated).toEqual([{ name: "Reader" }]);
    expect((response as any).value.blocks[0].values.markdown).toBe("First Reader");
  });
  test("resolves an included template version from its frozen snapshot while the root stays live", async () => {
    const f = fixture({ withInclusion: true });
    const response = await materializeDocument(request, f.context);
    const snapshot = (response as any).value;
    // An included template is another template: it keeps its TemplateVersion and Template read checks.
    expect(f.reads.length).toBeGreaterThan(0);
    expect(f.reads.every((read) => read === `TemplateVersion:${ids.included}`)).toBe(true);
    expect(f.authorizations).toContain(`Template:${ids.include}`);
    expect(f.authorizations).not.toContain(`Template:${ids.template}`);
    expect(f.queries.filter((query) => query.includes("from erp.document_variants"))).toHaveLength(1);
    expect(snapshot.templates.map((entry: { version: { id: string } }) => entry.version.id)).toEqual([ids.version, ids.included]);
    const included = snapshot.templates[1].version;
    expect(included.variants[0].id).toBe(ids.includedVariant);
    expect(included.variants[0].blocks[0].id).toBe(ids.includedBlock);
    expect(JSON.stringify(snapshot)).toContain("Included ");
    expect(JSON.stringify(snapshot)).not.toContain(f.data.frozenText);
  });
  test("produces the same composition hash for an unchanged head and a different one after an edit", async () => {
    const f = fixture();
    const first = (await materializeDocument(request, f.context)) as any;
    const again = (await materializeDocument(request, f.context)) as any;
    expect(again.value.compositionHash).toBe(first.value.compositionHash);
    f.data.secondText = "Second, edited";
    const edited = (await materializeDocument(request, f.context)) as any;
    expect(edited.value.compositionHash).not.toBe(first.value.compositionHash);
  });
  test("reports no variant for a locale the document does not have", async () => {
    const f = fixture();
    await expect(materializeDocument({ ...request, locale: "nl" }, f.context)).rejects.toBeDefined();
    expect(f.executions).toHaveLength(0);
  });
});
