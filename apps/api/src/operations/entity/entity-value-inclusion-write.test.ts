// SPDX-License-Identifier: BUSL-1.1
/**
 * The entity-value write path settles a template inclusion before the row is
 * stored: what `prepareEntityValueWriteInTransaction` returns is what the
 * generated CRUD writes. No database is used: the statements run against a
 * recording driver, so the test also shows that a refusal issues no write.
 */
import { describe, expect, test } from "bun:test";
import { CompiledQuery, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type DatabaseConnection, type Driver, type QueryResult } from "kysely";
import type { InclusionActor } from "@openshapeforge/documents/content-commands";
import type { DB } from "../../generated/db/types.js";
import { generatedEntityValues } from "../../modules/entity-value-registry.js";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "../../modules/field-schemas.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { prepareEntityValueWriteInTransaction } from "./entity-value-io.js";
import type { GeneratedCrudColumn } from "./types.js";

const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenant = id(1), user = id(2), template = id(3), variant = id(4), documentVariant = id(5), version = id(6), greeting = id(7), terms = id(8), rowId = id(9);
const carrier = generatedEntityValues.get("Block", "values")!;
const table = getGeneratedCrudTables().find((candidate) => candidate.source?.authoringEntityName === "Block")!;
const column = (name: string): GeneratedCrudColumn => table.columns.find((candidate) => candidate.name === name)!;
const versionColumn = carrier.definitions.TemplateBlock!.references.find((reference) => reference.fieldKey === "version")!.column;

const snapshot = { schemaVersion: 1, entity: "Template", head: { table: "templates",
  row: { id: template, tenant_id: tenant, parameters: [{ key: "name", osfType: "string", label: { en: "Name" } }] },
  children: { template_variants: [{ table: "template_variants", row: { id: variant, tenant_id: tenant, template_id: template, channel: "document", locale: "en" }, children: { [carrier.table]: [
    { table: carrier.table, children: {}, row: { id: greeting, tenant_id: tenant, variant_id: variant, variant_id_position: 0, definition_key: "TextBlock", definition_version: carrier.definitions.TextBlock!.schemaVersion, values: { markdown: "Dear {{local.name}}" }, locked: false } },
    { table: carrier.table, children: {}, row: { id: terms, tenant_id: tenant, variant_id: variant, variant_id_position: 1, definition_key: "TextBlock", definition_version: carrier.definitions.TextBlock!.schemaVersion, values: { markdown: "Terms" }, locked: true } },
  ] } }] } } };

function harness(options: { deny?: boolean } = {}) {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const text = query.sql.replace(/\s+/g, " ").trim();
      statements.push(text);
      const rows = (found: unknown[]) => ({ rows: found as R[] });
      if (/from "?erp"?\."?template_versions"?/.test(text)) return rows([{ id: version, snapshot }]);
      if (text.includes("from erp.document_variants")) return rows([{ channel: "document", locale: "en", template_version_id: null, parameters: {} }]);
      return rows([]);
    },
    async *streamQuery() { throw new Error("Streaming is not used here."); },
  };
  const driver: Driver = {
    async init() {}, async acquireConnection() { return connection; }, async beginTransaction() {}, async commitTransaction() {}, async rollbackTransaction() {}, async releaseConnection() {}, async destroy() {},
  };
  const db = new Kysely<DB>({ dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => driver, createIntrospector: (instance) => new PostgresIntrospector(instance), createQueryCompiler: () => new PostgresQueryCompiler() } });
  const session = { tenantId: tenant, userId: user, roles: ["Templates.Manage", "General.All.ReadWrite"], groups: [] };
  const authorized: string[] = [];
  /** The writing session's own platform services, as the host hands them to the documents module. */
  const inclusionActor: InclusionActor = (work) => work({ transport: "operation", session, platform: {
    records: {
      async assertAccess(_session: unknown, request: { entityName: string; id: string }) { authorized.push(`${request.entityName}:${request.id}`); if (options.deny) throw new Error("FORBIDDEN"); },
      projectStoredFields: (_session: unknown, request: { fields: Record<string, unknown> }) => request.fields,
    },
    schemas: { entityValues: generatedEntityValues, fields: generatedRuntimeFieldSchemas, json: runtimeJsonSchemas },
    operations: {
      list: async () => [{ id: "TemplateVersion.get", entityName: "TemplateVersion", intent: "get", effects: { data: "read", external: "none" } }],
      get: async () => undefined,
      execute: async () => ({ data: { id: version, tenantId: tenant, updatedAt: "2026-01-01T00:00:00Z", template, versionNumber: 1, snapshot }, operations: [] }),
    },
  } } as unknown as Parameters<Parameters<InclusionActor>[0]>[0]);
  const prepare = (values: Record<string, unknown>, current?: Record<string, unknown>) => db.transaction().execute((trx) => prepareEntityValueWriteInTransaction(trx, session, table,
    new Map<GeneratedCrudColumn, unknown>([...(current ? [] : [[column(carrier.definitionColumn), "TemplateBlock"] as const]), [column(carrier.valuesColumn), values]]),
    current ? "update" : "create", current as never, { inclusionActor }));
  const writes = () => statements.filter((statement) => /^(insert|update|delete)\b/i.test(statement));
  return { prepare, statements, writes, authorized };
}
const stored = (prepared: Map<GeneratedCrudColumn, unknown>) => prepared.get(column(carrier.valuesColumn)) as { parameters: unknown; content: { source: { id: string; hash: string; locked?: boolean }[]; blocks: { id: string; values: { markdown: string }; locked?: boolean }[] } };

describe("writing a template inclusion through the entity-value path", () => {
  test("the map handed to the generated write holds the server's copy and source record, not the caller's input", async () => {
    const h = harness();
    const prepared = await h.prepare({ version, parameters: { name: "Ada" } });
    const values = stored(prepared);
    expect(values.parameters).toEqual({ name: "Ada" });
    expect(values.content.blocks.map((block) => [block.id, block.values.markdown, block.locked ?? false])).toEqual([[greeting, "Dear Ada", false], [terms, "Terms", true]]);
    expect(values.content.source.map((entry) => [entry.id, entry.locked ?? false])).toEqual([[greeting, false], [terms, true]]);
    expect(values.content.source.every((entry) => /^[a-f0-9]{64}$/.test(entry.hash))).toBe(true);
    // The typed reference went to its own column and is not part of the stored values.
    expect(prepared.get(column(versionColumn))).toBe(version);
    expect(values).not.toHaveProperty("version");
    // The source was read as the writing session.
    expect(h.authorized).toEqual([`TemplateVersion:${version}`, `Template:${template}`]);
    // Preparing wrote nothing: the row itself is written by the caller, with this map.
    expect(h.writes()).toEqual([]);
  });

  test("an edit keeps the stored record, and a caller's record or a changed protected block is refused before any write", async () => {
    const h = harness();
    const values = stored(await h.prepare({ version, parameters: { name: "Ada" } }));
    const current = { id: rowId, tenant_id: tenant, document_variant_id: documentVariant, variant_id: null, origin: "local", diverged: false, locked: false, [carrier.definitionColumn]: "TemplateBlock", [carrier.valuesColumn]: values, [versionColumn]: version };
    const edited = { ...values.content, blocks: values.content.blocks.map((block) => block.id === greeting ? { ...block, values: { markdown: "Dear Ada, welcome" } } : block) };
    const next = stored(await h.prepare({ version, parameters: values.parameters, content: edited }, current));
    expect(next.content.blocks.map((block) => block.values.markdown)).toEqual(["Dear Ada, welcome", "Terms"]);
    expect(next.content.source).toEqual(values.content.source);
    h.statements.length = 0;
    const tampered = { ...values.content, blocks: values.content.blocks.map((block) => block.id === terms ? { ...block, values: { markdown: "Other terms" } } : block) };
    await expect(h.prepare({ version, parameters: values.parameters, content: tampered }, current)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    await expect(h.prepare({ version, parameters: values.parameters, content: { ...tampered, source: values.content.source.map((entry) => ({ id: entry.id, hash: entry.hash })) } }, current)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    expect(h.writes()).toEqual([]);
  });

  test("a source the writing session may not read refuses the write, and nothing was written", async () => {
    const h = harness({ deny: true });
    await expect(h.prepare({ version, parameters: { name: "Ada" } })).rejects.toThrow("FORBIDDEN");
    expect(h.writes()).toEqual([]);
  });
});
