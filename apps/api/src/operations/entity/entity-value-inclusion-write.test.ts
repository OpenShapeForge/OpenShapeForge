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

const SOURCE_ROLES = ["Templates.Manage", "General.All.ReadWrite"];
type Registry = typeof generatedEntityValues;

function harness(options: { deny?: boolean; roles?: string[]; registry?: Registry } = {}) {
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
  const session = { tenantId: tenant, userId: user, roles: options.roles ?? SOURCE_ROLES, groups: [] };
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
    new Map<GeneratedCrudColumn, unknown>([...(current ? [] : [[column(carrier.definitionColumn), "TemplateBlock"] as const, [column("document_variant_id"), documentVariant] as const]), [column(carrier.valuesColumn), values]]),
    current ? "update" : "create", current as never, { inclusionActor, ...(options.registry ? { registry: options.registry } : {}) }));
  const writes = () => statements.filter((statement) => /^(insert|update|delete)\b/i.test(statement));
  /** Every statement that touches a source template version: its authorization lock, its field definitions or its snapshot. */
  const sourceReads = () => statements.filter((statement) => statement.includes("template_versions"));
  return { prepare, statements, writes, sourceReads, authorized };
}
/** A session that may edit the host but holds no role on the source template, and whose record access to it is denied. */
const withoutSourceAccess = () => harness({ roles: [], deny: true });
const forbidden = { operationError: { code: "FORBIDDEN" } };
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

describe("the source of a stored inclusion is provenance, not a dependency of an ordinary edit", () => {
  const captured = async () => stored(await harness().prepare({ version, parameters: { name: "Ada" } }));
  const row = (values: unknown, definitionKey = "TemplateBlock") => ({ id: rowId, tenant_id: tenant, document_variant_id: documentVariant, variant_id: null, origin: "local", diverged: false, locked: false, [carrier.definitionColumn]: definitionKey, [carrier.valuesColumn]: values, [versionColumn]: version });
  const edit = (values: Awaited<ReturnType<typeof captured>>, markdown: string) => ({ ...values.content, blocks: values.content.blocks.map((block) => block.id === greeting ? { ...block, values: { markdown } } : block) });

  test("editing unprotected copied text needs no role on the source and reads nothing of it", async () => {
    const values = await captured();
    const h = withoutSourceAccess();
    const prepared = await h.prepare({ version, parameters: values.parameters, content: edit(values, "Dear Ada, welcome") }, row(values));
    const next = stored(prepared);
    expect(next.content.blocks.map((block) => block.values.markdown)).toEqual(["Dear Ada, welcome", "Terms"]);
    expect(next.content.source).toEqual(values.content.source);
    expect(next.parameters).toEqual(values.parameters);
    expect(prepared.get(column(versionColumn))).toBe(version);
    expect(h.sourceReads()).toEqual([]);
    expect(h.authorized).toEqual([]);
    // The same holds when the caller leaves `content` out, and the stored locks still hold without source access.
    await h.prepare({ version, parameters: values.parameters }, row(values));
    const tampered = { ...values.content, blocks: values.content.blocks.map((block) => block.id === terms ? { ...block, values: { markdown: "Other terms" } } : block) };
    await expect(h.prepare({ version, parameters: values.parameters, content: tampered }, row(values))).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    expect(h.sourceReads()).toEqual([]);
    expect(h.authorized).toEqual([]);
    expect(h.writes()).toEqual([]);
  });

  test("another version, other inputs or a prepared refresh still read the source as the caller, and are refused without access", async () => {
    const values = await captured();
    const refreshed = { ...values.content, source: values.content.source.map((entry) => entry.id === greeting ? { ...entry, hash: "0".repeat(64) } : entry) };
    const changes: Record<string, unknown>[] = [
      { version: id(10), parameters: values.parameters, content: values.content },
      { version, parameters: { name: "Grace" }, content: values.content },
      { version, parameters: { name: "Grace" } },
      { version, parameters: values.parameters, content: refreshed },
    ];
    for (const change of changes) {
      // No role on the source: refused by the source's own canonical read Operation, before anything is captured.
      const roleless = withoutSourceAccess();
      await expect(roleless.prepare(change, row(values))).rejects.toMatchObject(forbidden);
      expect(roleless.authorized).toEqual([]);
      expect(roleless.writes()).toEqual([]);
      // The role but no access to the record: the capture itself is refused, as the writing session.
      const denied = harness({ deny: true });
      await expect(denied.prepare(change, row(values))).rejects.toThrow("FORBIDDEN");
      expect(denied.authorized.length).toBeGreaterThan(0);
      expect(denied.sourceReads().length).toBeGreaterThan(0);
      expect(denied.writes()).toEqual([]);
    }
    // With access, changed inputs are captured as the caller and stored.
    const allowed = harness();
    const next = stored(await allowed.prepare({ version, parameters: { name: "Grace" } }, row(values)));
    expect(next.content.blocks.map((block) => block.values.markdown)).toEqual(["Dear Grace", "Terms"]);
    expect(allowed.authorized).toContain(`TemplateVersion:${version}`);
  });

  test("a refresh of a stale stored record is captured as the caller", async () => {
    const values = await captured();
    // What the server holds was captured from an earlier state of the source; the caller offers the record a prepare read returned.
    const stale = { ...values, content: { ...values.content, source: values.content.source.map((entry) => entry.id === greeting ? { ...entry, hash: "0".repeat(64) } : entry) } };
    const h = harness();
    const next = stored(await h.prepare({ version, parameters: values.parameters, content: values.content }, row(stale)));
    expect(next.content.source).toEqual(values.content.source);
    expect(h.authorized).toContain(`TemplateVersion:${version}`);
    await expect(withoutSourceAccess().prepare({ version, parameters: values.parameters, content: values.content }, row(stale))).rejects.toMatchObject(forbidden);
  });

  test("what counts as stored provenance is read from the server's row, never from what the caller sends", async () => {
    const values = await captured();
    // A row stored before copies existed holds no copy: a caller-supplied copy and record do not make it one.
    const referenceOnly = row({ parameters: values.parameters });
    const forged = withoutSourceAccess();
    await expect(forged.prepare({ version, parameters: values.parameters, content: values.content }, referenceOnly)).rejects.toMatchObject(forbidden);
    expect(forged.authorized).toEqual([]);
    // A record that drops a lock is not the stored record: the source is captured again and the forgery does not match it.
    const unlocked = { ...values.content, source: values.content.source.map((entry) => ({ id: entry.id, hash: entry.hash })),
      blocks: values.content.blocks.map((block) => block.id === terms ? { ...block, locked: false, values: { markdown: "Other terms" } } : block) };
    await expect(withoutSourceAccess().prepare({ version, parameters: values.parameters, content: unlocked }, row(values))).rejects.toMatchObject(forbidden);
    const h = harness();
    await expect(h.prepare({ version, parameters: values.parameters, content: unlocked }, row(values))).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    expect(h.authorized).toContain(`TemplateVersion:${version}`);
    expect(h.writes()).toEqual([]);
    // The stored inputs are the baseline too: a row holding other inputs does not retain what the caller sends.
    await expect(withoutSourceAccess().prepare({ version, parameters: { name: "Grace" }, content: values.content }, row({ ...values, parameters: { name: "Ada" } }))).rejects.toMatchObject(forbidden);
  });

  test("an unchanged live typed reference is still authorized on every write", async () => {
    // The same typed reference on a definition that is not an inclusion: nothing is copied, so the reference is live.
    const inclusion = carrier.definitions.TemplateBlock!;
    const live = { ...inclusion, fields: inclusion.fields.map((field) => { const { valueFieldsFrom: _source, ...rest } = field as Record<string, unknown>; return rest; }) };
    const linked = { ...carrier, definitions: { ...carrier.definitions, LinkedVersion: live } };
    const registry = { get: (entity: string, field: string) => entity === "Block" && field === carrier.fieldKey ? linked : undefined } as unknown as Registry;
    const current = row({ parameters: {} }, "LinkedVersion");
    const allowed = harness({ registry });
    await allowed.prepare({ version, parameters: {} }, current);
    expect(allowed.sourceReads().some((statement) => /for share$/.test(statement))).toBe(true);
    const roleless = harness({ registry, roles: [] });
    await expect(roleless.prepare({ version, parameters: {} }, current)).rejects.toMatchObject(forbidden);
    expect(roleless.writes()).toEqual([]);
  });
});
