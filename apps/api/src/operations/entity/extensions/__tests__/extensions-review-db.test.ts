// SPDX-License-Identifier: BUSL-1.1
/**
 * Regression tests for the two adversarial reviews of fase 1a (#372): one on
 * security (S1–S7), one on lifecycle and data (D1–D15). Each test names its
 * finding. Every test runs in a tenant of its own, so the field limit of the
 * acceptance entity (10) holds per test and no test sees another's fields.
 *
 * Row policies of the entity are stood in for by a restrictive SELECT policy
 * on the entity table that hides records named `Hidden…` from every session
 * but their writer's: the index inherits whatever row policy the entity
 * has (authorization profiles included) through the same `exists` on the
 * entity row, so the mechanism under test is the same one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { withDbSession } from "../../../../db/session.js";
import { composeJobHandlers } from "../../../../jobs/handlers.js";
import { processJobBatch } from "../../../../jobs/worker.js";
import { readChangeBatch } from "../../../../platform/entity-change-stream.js";
import { projectGeneratedEntityRow } from "../../catalog.js";
import { executeEntityOperation } from "../../runtime.js";
import { executeFieldDefinitionAction, executeReferencedBy, type FieldDefinitionAction } from "../definitions.js";
import { enforceExtensionReferencesOnDelete } from "../references.js";
import { loadExtensionFields } from "../store.js";
import { EXTENSION_BACKFILL_KIND, EXTENSION_RETENTION_KIND, applyExtensionRetention, extensionBackfillJobHandler, extensionRetentionJobHandler } from "../backfill.js";
import rawCatalog from "../../../../generated/operations/catalog.json" with { type: "json" };
import { createExtensionFixture, ENTITY, MANAGER_ROLE, READER_ROLE, sessionFor, VALUES_TABLE, UNIQUE_TABLE, WRITER_ROLE, type ExtensionFixture } from "./fixture.js";

let fixture: ExtensionFixture;
const silent = { info() {}, warn() {}, error() {} };
const handlers = composeJobHandlers([{ name: "test-extensions", jobHandlers: {
  [EXTENSION_BACKFILL_KIND]: extensionBackfillJobHandler, [EXTENSION_RETENTION_KIND]: extensionRetentionJobHandler,
} }]);

type Session = ReturnType<typeof sessionFor>;
type Row = Record<string, unknown> & { id: string; updated_at?: unknown; extensions: Record<string, unknown>; extensionsMeta: Record<string, Record<string, unknown>> };
const label = (text: string) => ({ nl: text, en: text });
const pub = (osfType: string, extra: Record<string, unknown> = {}) => ({ osfType, label: label(osfType), classification: { sensitivity: "public" }, ...extra });
const options = (...values: string[]) => ({ type: "static", items: values.map((value) => ({ value, label: label(value) })) });
const rule = (path: string, operator: string, value?: unknown) => ({ operator, left: { kind: "path", path }, ...(value === undefined ? {} : { right: { kind: "literal", value } }) });

/** A tenant of its own, with the four sessions the tests use. */
async function tenant() {
  const id = randomUUID();
  await fixture.addTenants(id);
  return {
    id,
    manager: sessionFor(id, [MANAGER_ROLE, WRITER_ROLE, READER_ROLE]),
    managerOnly: sessionFor(id, [MANAGER_ROLE]),
    writer: sessionFor(id, [WRITER_ROLE]),
    otherWriter: sessionFor(id, [WRITER_ROLE]),
    reader: sessionFor(id, [READER_ROLE]),
    outsider: sessionFor(id, ["Nothing.At.All"]),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

const define = (session: Session, action: FieldDefinitionAction, input: Record<string, unknown> = {}) =>
  withDbSession(fixture.app.db, session, (trx) => executeFieldDefinitionAction(trx, session, ENTITY, action, input));
const field = async (session: Session, key: string, definition: Record<string, unknown>, appliesWhen?: unknown) =>
  (await define(session, "create", { key, definition, ...(appliesWhen ? { appliesWhen } : {}) }) as { fieldId: string }).fieldId;
const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { operationError?: { code: string; message: string; detail?: string } }).operationError ?? error; }
  throw new Error("expected a refusal");
};
async function createAsset(session: Session, extensions?: Record<string, unknown>, name = "Object") {
  return executeEntityOperation(fixture.app.db, session, {
    operation: { id: `${ENTITY}.create`, intent: "create" },
    input: { values: { name, ...(extensions ? { extensions } : {}) } },
  });
}
async function created(session: Session, extensions?: Record<string, unknown>, name?: string): Promise<Row> {
  const result = await createAsset(session, extensions, name);
  if ("error" in result || !result.data) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.data as Row;
}
async function get(session: Session, id: string) {
  const result = await executeEntityOperation(fixture.app.db, session, { operation: { id: `${ENTITY}.get`, intent: "get" }, input: { id } });
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return result.data as Row | null;
}
async function update(session: Session, id: string, values: Record<string, unknown>) {
  const current = await get(session, id);
  return executeEntityOperation(fixture.app.db, session, { operation: { id: `${ENTITY}.update`, intent: "update" },
    input: { id, values, expectedVersion: current ? String(current.updated_at) : new Date(0).toISOString() } });
}
async function remove(session: Session, row: { id: string; updated_at?: unknown }, entity = ENTITY) {
  return executeEntityOperation(fixture.app.db, session, { operation: { id: `${entity}.delete`, intent: "delete" },
    input: { id: row.id, confirmed: true, expectedVersion: String(row.updated_at) } });
}
async function list(session: Session, input: Record<string, unknown>) {
  return executeEntityOperation(fixture.app.db, session, { operation: { id: `${ENTITY}.list`, intent: "list" }, input });
}
const ids = (result: Awaited<ReturnType<typeof list>>) => {
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return (result.data as { items: Array<{ data: { id: string } }> }).items.map((item) => item.data.id);
};
const privileged = <T>(query: ReturnType<typeof sql<T>>) => query.execute(fixture.privileged.db).then((result) => result.rows);
const source = async (id: string) => (await privileged(sql<{ extension_values: Record<string, unknown> }>`
  select extension_values from erp.extensible_assets where id = ${id}::uuid`))[0]!.extension_values;
const indexRows = (recordId: string, fieldId: string) => privileged(sql<Record<string, unknown>>`
  select * from erp.extensible_assets_field_values where record_id = ${recordId}::uuid and field_id = ${fieldId}::uuid order by ordinal`);
async function drainJobs() {
  for (let round = 0; round < 50; round += 1) {
    const { processed } = await processJobBatch(fixture.worker.db, handlers, silent, { kinds: [EXTENSION_BACKFILL_KIND] });
    if (!processed) return;
  }
}
const listed = async (t: Tenant, key: string) => ((await define(t.manager, "list", { includeDeprecated: true })) as {
  items: Array<{ key: string; state: string; version: number; definition: Record<string, unknown>; appliesWhen: any; backfill?: { state: string } }>;
}).items.find((item) => item.key === key);

describe("fase 1a review findings", () => {
  beforeAll(async () => {
    fixture = await createExtensionFixture("review");
  }, 180_000);
  afterAll(async () => { await fixture?.close(); });

  test("S1 appliesWhen never names a classified tenant field", async () => {
    const t = await tenant();
    await field(t.manager, "geheim", { ...pub("string"), options: options("a", "b"), classification: { sensitivity: "pii" } });
    expect(await failure(define(t.manager, "create", { key: "x", definition: pub("string"), appliesWhen: rule("extensions.geheim", "equals", "a") })))
      .toMatchObject({ code: "VALIDATION", message: expect.stringContaining("classified") });
  });

  test("S2 the index inherits the entity's row policies; maintenance still reaches every record", async () => {
    const t = await tenant();
    await sql.raw(`create policy review_hidden on erp.extensible_assets as restrictive for select
      using (app.bypass_rls() or name not like 'Hidden%' or current_setting('app.user_id', true) = '${t.writer.userId}')`).execute(fixture.privileged.db);
    try {
      const parent = await field(t.manager, "parent", pub(ENTITY, { onDelete: "restrict" }));
      const links = await field(t.manager, "links", pub(ENTITY, { cardinality: "collection", onDelete: "setNull" }));
      const code = await field(t.manager, "code", pub("string"));
      const soort = await field(t.manager, "soort", pub("string"));
      const target = await created(t.writer, undefined, "Target");
      const onlyHidden = await created(t.writer, undefined, "Guarded");
      const linkTarget = await created(t.writer, undefined, "Linked");
      const hidden = await created(t.writer, { parent: target.id, code: "H-dup", soort: "verborgen" }, "Hidden-1");
      const hidden2 = await created(t.writer, { code: "H-dup", links: [linkTarget.id] }, "Hidden-2");
      await created(t.writer, { parent: onlyHidden.id }, "Hidden-3");
      await created(t.writer, { parent: target.id, code: "V-1", soort: "zichtbaar" }, "Visible");

      // The index row of a hidden record is as hidden as the record.
      const visibleRows = await withDbSession(fixture.app.db, t.reader, async (trx) =>
        (await sql<{ n: string }>`select count(*)::text as n from erp.extensible_assets_field_values where record_id = ${hidden.id}::uuid`.execute(trx)).rows[0]!.n);
      expect(visibleRows).toBe("0");
      expect((await indexRows(hidden.id, code)).length).toBe(1);
      // referencedBy counts what the reader may see.
      const counted = await withDbSession(fixture.app.db, t.reader, (trx) => executeReferencedBy(trx, t.reader, ENTITY, { id: target.id }));
      expect(counted.items).toEqual([expect.objectContaining({ fieldId: parent, count: 1 })]);
      const all = await withDbSession(fixture.app.db, t.writer, (trx) => executeReferencedBy(trx, t.writer, ENTITY, { id: target.id }));
      expect(all.items).toEqual([expect.objectContaining({ fieldId: parent, count: 2 })]);

      // The deletion guard sees references the deleter cannot.
      expect(await remove(t.otherWriter, onlyHidden)).toMatchObject({ error: { code: "OPERATION_REFUSED" } });
      // setNull unlinks a record the deleter cannot see, in source and index.
      expect(await remove(t.otherWriter, linkTarget)).toMatchObject({ data: { deleted: true } });
      expect((await source(hidden2.id))[links]).toBeUndefined();
      expect(await privileged(sql`select 1 from erp.extensible_assets_field_values where record_id = ${hidden2.id}::uuid and value_ref_id = ${linkTarget.id}::uuid`)).toEqual([]);

      // A refusal counts every record but shows no value of one the actor cannot see.
      const narrowed = await failure(define(t.manager, "update", { fieldId: soort, definition: { ...pub("string"), options: options("zichtbaar") } })) as { message: string; detail?: string };
      expect(narrowed.message).toContain("1 existing value(s)");
      expect(JSON.stringify(narrowed)).not.toContain("verborgen");
      const duplicate = await failure(define(t.manager, "update", { fieldId: code, definition: pub("string", { unique: true }) })) as { code: string; message: string };
      expect(duplicate).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("1 value(s)") });
      expect(JSON.stringify(duplicate).toLowerCase()).not.toContain("h-dup");
    } finally {
      await sql`drop policy if exists review_hidden on erp.extensible_assets`.execute(fixture.privileged.db);
    }
  });

  test("S3 refusals show values only to a reader of the entity, and never of a classified field", async () => {
    const t = await tenant();
    const merk = await field(t.manager, "merk", pub("string"));
    const pas = await field(t.manager, "pas", { ...pub("string"), classification: { sensitivity: "pii" } });
    for (const value of ["Merk-1", "Merk-1"]) await created(t.writer, { merk: value, pas: "Pas-1" });
    const asReader = await failure(define(t.manager, "update", { fieldId: merk, definition: { ...pub("string"), options: options("X") } }));
    expect(JSON.stringify(asReader)).toContain("Merk-1");
    const asManagerOnly = await failure(define(t.managerOnly, "update", { fieldId: merk, definition: { ...pub("string"), options: options("X") } }));
    expect(JSON.stringify(asManagerOnly)).not.toContain("Merk-1");
    // Duplicates are shown as uniqueness compares them: trimmed and case-folded.
    expect(JSON.stringify(await failure(define(t.manager, "update", { fieldId: merk, definition: pub("string", { unique: true }) })))).toContain("merk-1");
    const blind = await failure(define(t.managerOnly, "update", { fieldId: merk, definition: pub("string", { unique: true }) }));
    expect(blind).toMatchObject({ code: "CONFLICT" });
    expect(JSON.stringify(blind).toLowerCase()).not.toContain("merk-1");
    const classified = await failure(define(t.manager, "update", { fieldId: pas, definition: { ...pub("string", { unique: true }), classification: { sensitivity: "pii" } } }));
    expect(classified).toMatchObject({ code: "CONFLICT" });
    expect(JSON.stringify(classified).toLowerCase()).not.toContain("pas-1");
  });

  test("S4 a classified reference stays out of referencedBy, and the guard names a source only to its reader", async () => {
    const t = await tenant();
    const secret = await field(t.manager, "geheimeLink", { ...pub(ENTITY, { onDelete: "restrict" }), classification: { sensitivity: "pii" } });
    const open = await field(t.manager, "openLink", pub(ENTITY, { onDelete: "restrict" }));
    const target = await created(t.writer, undefined, "Target");
    await created(t.writer, { geheimeLink: target.id });
    await created(t.writer, { openLink: target.id });
    const byReader = await withDbSession(fixture.app.db, t.reader, (trx) => executeReferencedBy(trx, t.reader, ENTITY, { id: target.id }));
    expect(byReader.items.map((item) => item.fieldId)).toEqual([open]);
    const byWriter = await withDbSession(fixture.app.db, t.writer, (trx) => executeReferencedBy(trx, t.writer, ENTITY, { id: target.id }));
    expect(byWriter.items.map((item) => item.fieldId).sort()).toEqual([open, secret].sort());
    const guard = (session: Session) => failure(withDbSession(fixture.app.db, session, (trx) =>
      enforceExtensionReferencesOnDelete(trx, session, fixture.table, target.id))) as Promise<{ code: string; message: string }>;
    const anonymous = await guard(t.outsider);
    expect(anonymous).toMatchObject({ code: "OPERATION_REFUSED", message: "This record is still referenced by 1 record(s)." });
    expect((await guard(t.writer)).message).toContain(ENTITY);
  });

  test("S5 a projection uses only definitions proven in its own transaction", async () => {
    const t = await tenant();
    const kleur = await field(t.manager, "kleur", pub("string"));
    const record = await created(t.writer, { kleur: "rood" });
    expect((await get(t.reader, record.id))!.extensions).toEqual({ kleur: "rood" });
    // Another replica renames the field: this process's cache knows nothing of it.
    await sql`with old as (update platform.extension_field_definitions set is_current = false
        where field_id = ${kleur}::uuid and is_current returning *)
      insert into platform.extension_field_definitions (tenant_id, id, field_id, entity, key, version, kind, definition, applies_when, state, position, is_current, created_at)
      select tenant_id, gen_random_uuid(), field_id, entity, 'tint', version + 1, kind, definition, applies_when, state, position, true, now() from old`.execute(fixture.privileged.db);
    const raw = (await privileged(sql<{ row: Record<string, unknown> }>`select to_jsonb(a.*) as row from erp.extensible_assets a where id = ${record.id}::uuid`))[0]!.row;
    // Outside any transaction nothing is proven: no extensions rather than stale ones.
    expect(projectGeneratedEntityRow(fixture.table, t.reader, raw).extensions).toBeUndefined();
    const fresh = await withDbSession(fixture.app.db, t.reader, async (trx) => {
      await loadExtensionFields(trx, t.reader, fixture.table);
      return projectGeneratedEntityRow(fixture.table, t.reader, raw).extensions;
    });
    expect(fresh).toEqual({ tint: "rood" });
    expect((await get(t.reader, record.id))!.extensions).toEqual({ tint: "rood" });
  });

  test("S7 the worker holds no MAINTAIN and only the definition columns a backfill changes", async () => {
    const worker = "openshapeforge_worker";
    const [rights] = await privileged(sql<Record<string, boolean>>`select
      has_table_privilege(${worker}, ${VALUES_TABLE}, 'MAINTAIN') as values_maintain,
      has_table_privilege(${worker}, 'erp.extensible_assets', 'MAINTAIN') as entity_maintain,
      has_table_privilege(${worker}, ${VALUES_TABLE}, 'INSERT') as values_dml,
      has_table_privilege(${worker}, ${UNIQUE_TABLE}, 'DELETE') as unique_dml,
      has_table_privilege(${worker}, 'platform.extension_field_definitions', 'SELECT') as definitions_select,
      has_table_privilege(${worker}, 'platform.extension_field_definitions', 'DELETE') as definitions_delete,
      has_column_privilege(${worker}, 'platform.extension_field_definitions', 'state', 'UPDATE') as definitions_state,
      has_column_privilege(${worker}, 'platform.extension_field_definitions', 'definition', 'UPDATE') as definitions_definition,
      has_table_privilege(${worker}, 'platform.extension_field_dependencies', 'SELECT,INSERT,UPDATE,DELETE') as dependencies_any,
      has_column_privilege(${worker}, 'erp.extensible_assets', 'name', 'UPDATE') as entity_name`);
    expect(rights).toEqual({
      values_maintain: false, entity_maintain: false, values_dml: true, unique_dml: true,
      definitions_select: true, definitions_delete: false, definitions_state: true, definitions_definition: false,
      dependencies_any: false, entity_name: false,
    });
  });

  test("D1 a duplicate met by the unique backfill turns unique off again; the field never stays updating", async () => {
    const t = await tenant();
    const code = await field(t.manager, "code", pub("string"));
    await created(t.writer, { code: "D-1" });
    expect(await define(t.manager, "update", { fieldId: code, definition: pub("string", { unique: true }) })).toMatchObject({ state: "updating" });
    // A writer under the unique version claims at once, before the backfill reached the older record.
    await created(t.writer, { code: "D-1" });
    await drainJobs();
    const after = await listed(t, "code");
    expect(after).toMatchObject({ state: "ready", version: 3, backfill: { state: "failed" } });
    expect(after!.definition.unique).toBeUndefined();
    const [backfill] = await privileged(sql<{ error: Record<string, unknown> }>`select error from platform.extension_field_backfills
      where field_id = ${code}::uuid order by created_at desc limit 1`);
    expect(backfill!.error).toMatchObject({ code: "DUPLICATE_VALUE", duplicates: 1 });
    expect(await privileged(sql`select 1 from erp.extensible_assets_field_unique_values where field_id = ${code}::uuid`)).toEqual([]);
    expect((await created(t.writer, { code: "D-1" })).extensions.code).toBe("D-1");
  });

  test("D2 a deprecated field is not changed until it is restored", async () => {
    const t = await tenant();
    const f = await field(t.manager, "f", pub("string"));
    await define(t.manager, "deprecate", { fieldId: f });
    expect(await failure(define(t.manager, "update", { fieldId: f, definition: pub("string", { unique: true }) })))
      .toMatchObject({ code: "CONFLICT", message: expect.stringContaining("restore") });
    expect(await listed(t, "f")).toMatchObject({ state: "deprecated" });
  });

  test("D3 appliesWhen is stored on field ids, survives a rename and keeps its field from going away", async () => {
    const t = await tenant();
    const soort = await field(t.manager, "soort", { ...pub("string"), options: options("a", "b") });
    const x = await field(t.manager, "x", pub("number"), rule("extensions.soort", "equals", "a"));
    const [stored] = await privileged(sql<{ applies_when: any }>`select applies_when from platform.extension_field_definitions where field_id = ${x}::uuid and is_current`);
    expect(stored!.applies_when.left.path).toBe(`extensions.${soort}`);
    expect((await listed(t, "x"))!.appliesWhen.left.path).toBe("extensions.soort");
    expect(await privileged(sql`select depends_on_field from platform.extension_field_dependencies where field_id = ${x}::uuid and tenant_id = ${t.id}::uuid`))
      .toEqual([{ depends_on_field: soort }]);
    await define(t.manager, "update", { fieldId: soort, key: "type" });
    expect((await listed(t, "x"))!.appliesWhen.left.path).toBe("extensions.type");
    expect((await created(t.writer, { type: "a", x: 1 })).extensionsMeta.x).toMatchObject({ applicable: true });
    expect(await failure(define(t.manager, "deprecate", { fieldId: soort })))
      .toMatchObject({ code: "CONFLICT", message: expect.stringContaining("x") });
  });

  test("D4 rebuildIndex restores the index from the source; backfills remove orphaned index rows", async () => {
    const t = await tenant();
    const n = await field(t.manager, "n", pub("number"));
    const i = await field(t.manager, "i", pub("integer"));
    const kept = await created(t.writer, { n: 5, i: 2 });
    const bare = await created(t.writer, {});
    await sql`delete from erp.extensible_assets_field_values where record_id = ${kept.id}::uuid and field_id = ${n}::uuid`.execute(fixture.privileged.db);
    for (const fieldId of [n, i]) {
      await sql`insert into erp.extensible_assets_field_values (tenant_id, record_id, field_id, ordinal, value_number)
        values (${t.id}::uuid, ${bare.id}::uuid, ${fieldId}::uuid, 0, 9)`.execute(fixture.privileged.db);
    }
    const rebuilt = await define(t.manager, "rebuildIndex", { fieldId: n }) as { backfills: Array<{ fieldId: string; backfillId: string }> };
    expect(rebuilt.backfills).toEqual([{ fieldId: n, backfillId: expect.any(String) }]);
    await drainJobs();
    expect((await indexRows(kept.id, n)).map((row) => row.value_number)).toEqual(["5"]);
    expect(await indexRows(bare.id, n)).toEqual([]);
    // A retype backfill clears what a record without the key left behind, too.
    await define(t.manager, "update", { fieldId: i, definition: pub("number") });
    await drainJobs();
    expect(await indexRows(bare.id, i)).toEqual([]);
    expect((await indexRows(kept.id, i)).map((row) => row.value_number)).toEqual(["2"]);
    // Compiled as a REST and GraphQL Operation, never an MCP tool.
    const compiled = (rawCatalog as unknown as { operations: Array<{ key: string; transports: Record<string, any> }> }).operations
      .find((operation) => operation.key === `${ENTITY}.fieldDefinitions.rebuildIndex`)!;
    expect(compiled.transports.mcp.enabled).toBe(false);
    expect(compiled.transports.graphql.enabled).toBe(true);
    expect(compiled.transports.rest.path).toEndWith("/field-definitions/rebuild-index");
  });

  test("D5 a snapshot freezes values as a reader sees them, with only their definitions", async () => {
    const { extensionSnapshot } = await import("../snapshot.js");
    const t = await tenant();
    const soort = await field(t.manager, "soort", { ...pub("string"), options: options("a", "b") });
    await field(t.manager, "bsn", { ...pub("string"), classification: { sensitivity: "bsn" } });
    const leeg = await field(t.manager, "leeg", pub("string"));
    const record = await created(t.writer, { soort: "a", bsn: "123" });
    // A field defined after the record: no stored value, its default applies.
    const aantal = await field(t.manager, "aantal", pub("integer", { defaultValue: 2 }));
    const raw = (await privileged(sql<{ row: Record<string, unknown> }>`select to_jsonb(a.*) as row from erp.extensible_assets a where id = ${record.id}::uuid`))[0]!.row;
    const snapshot = () => withDbSession(fixture.app.db, t.writer, (trx) => extensionSnapshot(trx, t.writer, ENTITY, raw));
    const first = await snapshot();
    expect(first.extensions).toEqual({ [soort]: "a", [aantal]: 2 });
    expect(Object.keys(first.extensionDefinitions).sort()).toEqual([soort, aantal].sort());
    expect(first.extensionDefinitions[soort]).toMatchObject({ version: 1, key: "soort", osfType: "string", options: options("a", "b").items });
    expect(first.extensionDefinitions[aantal]).toMatchObject({ key: "aantal", defaultValue: 2 });
    expect(first.extensionDefinitions[soort]!.defaultValue).toBeUndefined();
    // An unrelated field does not change what is frozen (nor the content hash).
    await field(t.manager, "nieuw", pub("string"));
    await define(t.manager, "update", { fieldId: leeg, key: "leeg2" });
    expect(await snapshot()).toEqual(first);
  });

  test("D6 narrowing or reinterpreting a field is refused; widening its validation is not", async () => {
    const t = await tenant();
    const p = await field(t.manager, "p", pub("number", { validation: { min: 0, max: 10 } }));
    const s = await field(t.manager, "s", pub("string", { validation: { maxLength: 10 } }));
    const u = await field(t.manager, "u", pub("number", { unit: "kWh" }));
    const refused = (fieldId: string, definition: Record<string, unknown>) =>
      failure(define(t.manager, "update", { fieldId, definition })).then((error) => (error as { message: string }).message);
    expect(await refused(p, pub("number", { validation: { min: 1, max: 10 } }))).toContain("create a new field");
    expect(await refused(p, pub("number", { validation: { min: 0, max: 5 } }))).toContain("validation.max ");
    expect(await refused(s, pub("string", { validation: { maxLength: 5 } }))).toContain("validation.maxLength");
    expect(await refused(s, pub("string", { validation: { maxLength: 10, pattern: "^[A-Z]+$" } }))).toContain("validation.pattern");
    expect(await refused(s, { ...pub("string", { validation: { maxLength: 10 } }), classification: { sensitivity: "internal" } })).toContain("classification");
    expect(await refused(u, pub("number", { unit: "Wh" }))).toContain("unit");
    expect(await define(t.manager, "update", { fieldId: p, definition: pub("number", { validation: { min: -5, max: 20 } }) })).toMatchObject({ version: 2 });
    expect(await define(t.manager, "update", { fieldId: s, definition: pub("string", { validation: { maxLength: 20 } }) })).toMatchObject({ version: 2 });
  });

  test("D7 defaults are stored on create and when a field comes to apply; filters count older records by their default", async () => {
    const t = await tenant();
    const tag = randomUUID().slice(0, 8);
    const before = await created(t.writer, {}, `D7-${tag}-before`);
    const aantal = await field(t.manager, "aantal", pub("integer", { defaultValue: 1 }));
    await field(t.manager, "soort", { ...pub("string"), options: options("a", "b") });
    const accu = await field(t.manager, "accu", pub("number", { defaultValue: 5, required: true }), rule("extensions.soort", "equals", "a"));
    const after = await created(t.writer, {}, `D7-${tag}-after`);
    expect((await source(after.id))[aantal]).toBe(1);
    expect((await indexRows(after.id, aantal)).map((row) => row.value_number)).toEqual(["1"]);
    expect((await source(before.id))[aantal]).toBeUndefined();
    const battery = await created(t.writer, { soort: "a" }, `D7-${tag}-battery`);
    expect((await source(battery.id))[accu]).toBe(5);
    const kit = await created(t.writer, { soort: "b" }, `D7-${tag}-kit`);
    expect((await source(kit.id))[accu]).toBeUndefined();
    expect("error" in await update(t.writer, kit.id, { extensions: { soort: "a" } })).toBe(false);
    expect((await source(kit.id))[accu]).toBe(5);
    const scope = { name: `D7-${tag}` };
    // `before` holds no value and reads 1: an equality on the default counts it.
    expect(ids(await list(t.reader, { filter: { ...scope, extensions: { aantal: { eq: 1 } } }, limit: 50 }))).toContain(before.id);
    expect(ids(await list(t.reader, { filter: { ...scope, extensions: { aantal: { eq: 2 } } } }))).toEqual([]);
    expect(ids(await list(t.reader, { filter: { ...scope, extensions: { aantal: { isNull: true } } } }))).toEqual([]);
    // A field with appliesWhen filters on stored values only.
    expect(ids(await list(t.reader, { filter: { ...scope, extensions: { accu: { eq: 5 } } } })).sort()).toEqual([battery.id, kit.id].sort());
    // A sort treats a missing value as missing: nulls last.
    expect(ids(await list(t.reader, { filter: scope, sort: { field: "extensions.aantal", direction: "asc" } })).at(-1)).toBe(before.id);
  });

  test("D8 a measurement filters with its unit and is not a sort key", async () => {
    const t = await tenant();
    await field(t.manager, "cap", pub("measurement"));
    const tag = randomUUID().slice(0, 8);
    const kwh = await created(t.writer, { cap: { value: 10, unit: "m" } }, `D8-${tag}`);
    await created(t.writer, { cap: { value: 10, unit: "cm" } }, `D8-${tag}`);
    const scope = { name: `D8-${tag}` };
    expect(await list(t.reader, { filter: { ...scope, extensions: { cap: { gt: 1 } } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    expect(ids(await list(t.reader, { filter: { ...scope, extensions: { cap: { value: { gt: 1 }, unit: { eq: "m" } } } } }))).toEqual([kwh.id]);
    expect(await list(t.reader, { filter: scope, sort: { field: "extensions.cap" } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
  });

  test("D9 setNull, retention and the delete backfill write like a caller: updated_at and per-key audit", async () => {
    const t = await tenant();
    await field(t.manager, "links", pub(ENTITY, { cardinality: "collection", onDelete: "setNull" }));
    const tag = await field(t.manager, "tag", pub("string", { retention: { days: 30 } }));
    const weg = await field(t.manager, "weg", pub("string"));
    const events = async (id: string) => (await privileged(sql<{ n: string }>`select count(*)::text as n from platform.entity_events
      where aggregate_id = ${id} and event_type = 'extensionsChanged'`))[0]!.n;
    const stamp = async (id: string) => (await privileged(sql<{ updated_at: string }>`select updated_at::text from erp.extensible_assets where id = ${id}::uuid`))[0]!.updated_at;

    const target = await created(t.writer, undefined, "Target");
    const linked = await created(t.writer, { links: [target.id] });
    const [linkedStamp, linkedEvents] = [await stamp(linked.id), await events(linked.id)];
    expect(await remove(t.writer, target)).toMatchObject({ data: { deleted: true } });
    expect(await stamp(linked.id)).not.toBe(linkedStamp);
    expect(Number(await events(linked.id))).toBe(Number(linkedEvents) + 1);

    const old = await created(t.writer, { tag: "x" });
    await sql`update erp.extensible_assets set created_at = now() - interval '40 days' where id = ${old.id}::uuid`.execute(fixture.privileged.db);
    const [oldStamp, oldEvents] = [await stamp(old.id), await events(old.id)];
    await withDbSession(fixture.worker.db, t.manager, (trx) => applyExtensionRetention(trx, t.manager, ENTITY));
    expect((await source(old.id))[tag]).toBeUndefined();
    expect(await stamp(old.id)).not.toBe(oldStamp);
    expect(Number(await events(old.id))).toBe(Number(oldEvents) + 1);

    const doomed = await created(t.writer, { weg: "y" });
    const [doomedStamp, doomedEvents] = [await stamp(doomed.id), await events(doomed.id)];
    await define(t.manager, "deprecate", { fieldId: weg });
    await define(t.manager, "delete", { fieldId: weg, confirmAffectedRecords: 1 });
    await drainJobs();
    expect((await source(doomed.id))[weg]).toBeUndefined();
    expect(await stamp(doomed.id)).not.toBe(doomedStamp);
    expect(Number(await events(doomed.id))).toBe(Number(doomedEvents) + 1);
  });

  test("D11 appliesWhen and required are decided against the row as inserted", async () => {
    const t = await tenant();
    await field(t.manager, "z", pub("string", { required: true }), rule("createdAt", "isNotEmpty"));
    expect(await createAsset(t.writer, {})).toMatchObject({ error: { code: "VALIDATION", violations: [expect.objectContaining({ field: "extensions.z", code: "REQUIRED" })] } });
    expect((await created(t.writer, { z: "ok" })).extensions.z).toBe("ok");
  });

  test("D12 uniqueness is trimmed, case-folded and UTC; the stored value stays as entered", async () => {
    const t = await tenant();
    await field(t.manager, "sku", pub("string", { unique: true }));
    await field(t.manager, "ts", pub("datetime", { unique: true }));
    const code = await field(t.manager, "code", pub("string"));
    const first = await created(t.writer, { sku: "Abc ", ts: "2026-01-01T01:00:00+01:00" });
    expect(await createAsset(t.writer, { sku: "abc" })).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await createAsset(t.writer, { ts: "2026-01-01T00:00:00.000Z" })).toMatchObject({ error: { code: "CONFLICT" } });
    expect((await get(t.reader, first.id))!.extensions.sku).toBe("Abc ");
    await created(t.writer, { code: "Q" });
    await created(t.writer, { code: " q" });
    expect(await failure(define(t.manager, "update", { fieldId: code, definition: pub("string", { unique: true }) }))).toMatchObject({ code: "CONFLICT" });
  });

  test("D13 the database holds one current version per field", async () => {
    const t = await tenant();
    const f = await field(t.manager, "f", pub("string"));
    await expect(sql`insert into platform.extension_field_definitions (tenant_id, id, field_id, entity, key, version, kind, definition, state, position, is_current)
      values (${t.id}::uuid, gen_random_uuid(), ${f}::uuid, ${ENTITY}, 'g', 9, 'stored', '{}'::jsonb, 'ready', 9, true)`.execute(fixture.privileged.db))
      .rejects.toThrow(/extension_field_definitions_current_field_uidx/);
  });

  test("D14 a date field compares as a date and takes only a date", async () => {
    const t = await tenant();
    await field(t.manager, "datum", pub("date"));
    const tag = randomUUID().slice(0, 8);
    const day = await created(t.writer, { datum: "2026-01-05" }, `D14-${tag}`);
    const scope = { name: `D14-${tag}` };
    expect(ids(await list(t.reader, { filter: { ...scope, extensions: { datum: { gt: "2026-01-04" } } } }))).toEqual([day.id]);
    expect(ids(await list(t.reader, { filter: { ...scope, extensions: { datum: { eq: "2026-01-05" } } } }))).toEqual([day.id]);
    expect(await list(t.reader, { filter: { ...scope, extensions: { datum: { gt: "2026-01-04T10:00:00Z" } } } })).toMatchObject({ error: { code: "VALIDATION" } });
  });

  test("D15 a definition change is a realtime event for readers of the definitions in that tenant only", async () => {
    const t = await tenant();
    const other = await tenant();
    const cursor = async (session: Session) => (await readChangeBatch(fixture.app.db, session)).cursor;
    const start = { reader: await cursor(t.reader), outsider: await cursor(t.outsider), other: await cursor(other.reader) };
    const f = await field(t.manager, "f", pub("string"));
    await define(t.manager, "deprecate", { fieldId: f });
    const changes = async (session: Session, from: string) => (await readChangeBatch(fixture.app.db, session, from)).changes.map((change) => change.data);
    expect(await changes(t.reader, start.reader)).toEqual([
      { entity: `${ENTITY}FieldDefinition`, id: f, change: "created" },
      { entity: `${ENTITY}FieldDefinition`, id: f, change: "updated" },
    ]);
    expect(await changes(t.outsider, start.outsider)).toEqual([]);
    expect(await changes(other.reader, start.other)).toEqual([]);
    const [payload] = await privileged(sql<{ payload: unknown }>`select payload from platform.entity_events
      where aggregate_type = ${`${ENTITY}FieldDefinition`} and aggregate_id = ${f} limit 1`);
    // No payload of its own: only the envelope every event gets.
    expect(Object.keys(payload!.payload as object)).toEqual(["audit"]);
  });
});
