// SPDX-License-Identifier: BUSL-1.1
/**
 * Formula fields end to end on a scratch database: the save-time check
 * (refusals with code and span, cycles and depth over the whole set), the
 * synchronous evaluation in the record's write — owned child included —,
 * per-record errors, query on the typed index, the backfill under the real
 * worker role, the snapshot, MCP and tenant isolation. Every test runs in a
 * tenant of its own, so the field limit of the acceptance entity (10) holds
 * per test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { withDbSession } from "../../../../db/session.js";
import { composeJobHandlers } from "../../../../jobs/handlers.js";
import { processJobBatch } from "../../../../jobs/worker.js";
import { catalog } from "../../../../mcp/catalog.js";
import { describeTool } from "../../../../mcp/entity-tool-projection.js";
import { invokeTool } from "../../../../mcp/entity-tool-invocation.js";
import { primeSessionExtensions, withExtensionTool } from "../../../../mcp/extension-schemas.js";
import { getGeneratedCrudTables } from "../../catalog.js";
import { createGeneratedEntityForTable, updateGeneratedEntityForTable } from "../../mutations.js";
import { executeEntityOperation } from "../../runtime.js";
import { applyExtensionRetention, EXTENSION_BACKFILL_KIND, extensionBackfillJobHandler, runBackfillBatch } from "../backfill.js";
import { executeFieldDefinitionAction, type FieldDefinitionAction } from "../definitions.js";
import { extensionSnapshot } from "../snapshot.js";
import { createExtensionFixture, ENTITY, MANAGER_ROLE, READER_ROLE, sessionFor, VALUES_TABLE, WRITER_ROLE, type ExtensionFixture } from "./fixture.js";

let fixture: ExtensionFixture;
const silent = { info() {}, warn() {}, error() {} };
const handlers = composeJobHandlers([{ name: "test-formulas", jobHandlers: { [EXTENSION_BACKFILL_KIND]: extensionBackfillJobHandler } }]);

type Session = ReturnType<typeof sessionFor>;
type Row = Record<string, unknown> & { id: string; updated_at?: unknown; extensions: Record<string, unknown>; extensionsMeta: Record<string, Record<string, unknown>> };
type Diagnostic = { code: string; message: string; start: number; end: number };
const label = (text: string) => ({ en: text, nl: text });
const number = (text: string, extra: Record<string, unknown> = {}) =>
  ({ osfType: "number", label: label(text), classification: { sensitivity: "public" }, ...extra });
const formula = (text: string, name = "Formula", extra: Record<string, unknown> = {}) =>
  ({ label: label(name), formula: { text }, classification: { sensitivity: "public" }, ...extra });
const typed = (osfType: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ osfType, label: label(text), classification: { sensitivity: "public" }, ...extra });

async function tenant() {
  const id = randomUUID();
  await fixture.addTenants(id);
  return { id, manager: sessionFor(id, [MANAGER_ROLE, WRITER_ROLE, READER_ROLE]), writer: sessionFor(id, [WRITER_ROLE]), reader: sessionFor(id, [READER_ROLE]) };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

const define = (session: Session, action: FieldDefinitionAction, input: Record<string, unknown> = {}) =>
  withDbSession(fixture.app.db, session, (trx) => executeFieldDefinitionAction(trx, session, ENTITY, action, input));
const field = async (session: Session, key: string, definition: Record<string, unknown>, kind?: string) =>
  (await define(session, "create", { key, definition, ...(kind ? { kind } : {}) }) as { fieldId: string }).fieldId;
const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) {
    return (error as { operationError?: { code: string; message: string; data?: { errors: Diagnostic[] }; violations?: unknown[] } }).operationError ?? error;
  }
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
const indexed = (recordId: string, fieldId: string) => privileged(sql<{ value_number: string | null; value_text: string | null }>`
  select value_number::text as value_number, value_text from erp.extensible_assets_field_values
  where record_id = ${recordId}::uuid and field_id = ${fieldId}::uuid order by ordinal`);
async function drainJobs() {
  for (let round = 0; round < 50; round += 1) {
    const { processed } = await processJobBatch(fixture.worker.db, handlers, silent, { kinds: [EXTENSION_BACKFILL_KIND] });
    if (!processed) return;
  }
}
const listed = async (t: Tenant, key: string) => ((await define(t.manager, "list", { includeDeprecated: true })) as {
  items: Array<{ fieldId: string; key: string; state: string; version: number; definition: Record<string, any>; backfill?: { id: string; state: string; processed: number; total: number } }>;
}).items.find((item) => item.key === key)!;
/** A new formula is `updating` until its backfill ran; tests that only write new records let it finish first. */
async function ready(t: Tenant, key: string, definition: Record<string, unknown>) {
  const fieldId = await field(t.manager, key, definition, "formula");
  await drainJobs();
  expect((await listed(t, key)).state).toBe("ready");
  return fieldId;
}

const specTable = () => getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === "ExtensibleAssetSpec" && !table.subtype)!;

describe("formula fields on an extensible entity", () => {
  beforeAll(async () => {
    fixture = await createExtensionFixture("formula");
  }, 180_000);
  afterAll(async () => { await fixture?.close(); });

  test("{Capacity kWh} * {Price per kWh} is computed in the record's own write, into source and index", async () => {
    const t = await tenant();
    await field(t.manager, "capacityKwh", number("Capacity kWh"));
    await field(t.manager, "pricePerKwh", number("Price per kWh"));
    const total = await ready(t, "total", formula("{Capacity kWh} * {Price per kWh}", "Total"));
    const definition = await listed(t, "total");
    expect(definition).toMatchObject({ kind: "formula", definition: { osfType: "number",
      formula: { text: "{Capacity kWh} * {Price per kWh}", resultType: "number", ast: { kind: "formula", op: "mul" } } } });

    const record = await created(t.writer, { capacityKwh: 13.5, pricePerKwh: 400 });
    expect(record.extensions.total).toBe(5400);
    expect((await source(record.id))[total]).toBe(5400);
    expect(await indexed(record.id, total)).toEqual([{ value_number: "5400", value_text: null }]);

    expect(await update(t.writer, record.id, { extensions: { pricePerKwh: 500 } })).toMatchObject({ data: { extensions: { total: 6750 } } });
    expect(await indexed(record.id, total)).toEqual([{ value_number: "6750", value_text: null }]);
    // A blank input counts as 0, as in a spreadsheet.
    await update(t.writer, record.id, { extensions: { pricePerKwh: null } });
    expect((await get(t.reader, record.id))!.extensions.total).toBe(0);
    expect(await indexed(record.id, total)).toEqual([{ value_number: "0", value_text: null }]);

    // A formula is never written by a caller.
    expect(await createAsset(t.writer, { total: 1 })).toMatchObject({ error: { violations: [expect.objectContaining({ code: "COMPUTED_FIELD" })] } });
    expect(await update(t.writer, record.id, { extensions: { total: 1 } })).toMatchObject({ error: { violations: [expect.objectContaining({ code: "COMPUTED_FIELD" })] } });

    // A renamed input keeps the formula: the AST holds field ids, the text follows the label.
    const capacity = (await listed(t, "capacityKwh"));
    await define(t.manager, "update", { fieldId: capacity.fieldId, definition: number("Capacity") });
    expect((await listed(t, "total")).definition.formula.text).toBe("{Capacity} * {Price per kWh}");
    // An authored field by its label, text by &.
    const named = await ready(t, "named", formula('{Name} & " (" & {Capacity} & ")"', "Named"));
    const second = await created(t.writer, { capacityKwh: 2 }, "Pack");
    expect(second.extensions.named).toBe("Pack (2)");
    expect(await indexed(second.id, named)).toEqual([{ value_number: null, value_text: "Pack (2)" }]);
    expect(await update(t.writer, second.id, { name: "Cell" })).toMatchObject({ data: { extensions: { named: "Cell (2)" } } });
    // A runtime create, without caller extensions, computes its formulas too.
    const runtime = await createGeneratedEntityForTable(fixture.app.db, t.writer, fixture.table, { name: "Runtime" });
    expect((await source(String(runtime.id)))[total]).toBe(0);
    expect((runtime as unknown as Row).extensions.total).toBe(0);
  });

  test("{Capacity kWh} * spec.weight reads the owned child; a write of the child recomputes its owner", async () => {
    const t = await tenant();
    await field(t.manager, "capacityKwh", number("Capacity kWh"));
    const weighted = await ready(t, "weighted", formula("{Capacity kWh} * spec.weight", "Weighted"));
    const record = await created(t.writer, { capacityKwh: 10 });
    // Without a spec its fields are blank, so they count as 0.
    expect(record.extensions.weighted).toBe(0);

    const spec = await createGeneratedEntityForTable(fixture.app.db, t.writer, specTable(), { asset: record.id, weight: 2 });
    expect((await get(t.reader, record.id))!.extensions.weighted).toBe(20);
    expect(await indexed(record.id, weighted)).toEqual([{ value_number: "20", value_text: null }]);
    await updateGeneratedEntityForTable(fixture.app.db, t.writer, specTable(), String(spec.id), { weight: 3.5 });
    expect((await get(t.reader, record.id))!.extensions.weighted).toBe(35);
    // The owner's own write reads the child too.
    expect(await update(t.writer, record.id, { extensions: { capacityKwh: 4 } })).toMatchObject({ data: { extensions: { weighted: 14 } } });
    // The child's change is the owner's change: audited per key on the owner.
    const events = await privileged(sql<{ payload: { audit: { changedFields: string[] } } }>`select payload from platform.entity_events
      where aggregate_id = ${record.id} and event_type = 'extensionsChanged' order by sequence`);
    expect(events.at(-2)?.payload.audit.changedFields).toEqual(["extensions.weighted"]);

    // Reach stops at owned single children: anything else is out of scope.
    const refused = await failure(define(t.manager, "create", { key: "far", kind: "formula", definition: formula("{Capacity kWh} * location.size") }));
    expect(refused).toMatchObject({ code: "VALIDATION", data: { errors: [expect.objectContaining({ code: "outOfScope", start: 17, end: 25 })] } });
  });

  test("formulas over formulas up to formulaDepth; deeper is refused, also when a change deepens a reader", async () => {
    const t = await tenant();
    await field(t.manager, "x", number("X"));
    await ready(t, "f1", formula("{X} + 1", "F1"));
    for (const depth of [2, 3, 4, 5]) await ready(t, `f${depth}`, formula(`{F${depth - 1}} + 1`, `F${depth}`));
    const record = await created(t.writer, { x: 10 });
    expect(record.extensions).toMatchObject({ f1: 11, f2: 12, f3: 13, f4: 14, f5: 15 });
    expect(await update(t.writer, record.id, { extensions: { x: 0 } })).toMatchObject({ data: { extensions: { f5: 5 } } });

    expect(await failure(define(t.manager, "create", { key: "f6", kind: "formula", definition: formula("{F5} + 1", "F6") })))
      .toMatchObject({ code: "VALIDATION", data: { errors: [expect.objectContaining({ code: "depthExceeded", start: 0, end: 4 })] } });
    // F1 one formula deeper would push F5 past the limit.
    await ready(t, "g", formula("{X} * 2", "G"));
    const f1 = (await listed(t, "f1")).fieldId;
    expect(await failure(define(t.manager, "update", { fieldId: f1, definition: formula("{G} + 1", "F1") })))
      .toMatchObject({ code: "VALIDATION", message: expect.stringContaining("'F5' reads this formula and would be 6 formulas deep"),
        data: { errors: [expect.objectContaining({ code: "depthExceeded" })] } });
  });

  test("a cycle over several definitions is refused when the closing one is saved", async () => {
    const t = await tenant();
    await field(t.manager, "x", number("X"));
    const a = await ready(t, "a", formula("{X} + 1", "A"));
    await ready(t, "b", formula("{A} + 1", "B"));
    await ready(t, "c", formula("{B} + 1", "C"));
    const refused = await failure(define(t.manager, "update", { fieldId: a, definition: formula("{C} + 1", "A") }));
    expect(refused).toMatchObject({ code: "VALIDATION", data: { errors: [expect.objectContaining({ code: "cycle", message: "Circular reference: A → C → B → A", start: 0, end: 3 })] } });
    expect(await failure(define(t.manager, "update", { fieldId: a, definition: formula("{A} + 1", "A") })))
      .toMatchObject({ data: { errors: [expect.objectContaining({ code: "cycle" })] } });
    // A field a formula reads cannot be taken away.
    const x = (await listed(t, "x")).fieldId;
    expect(await failure(define(t.manager, "deprecate", { fieldId: x }))).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("a depends on it") });
  });

  test("time functions, classified fields and stored-field properties are refused with their reason and span", async () => {
    const t = await tenant();
    await field(t.manager, "x", number("X"));
    await field(t.manager, "margin", number("Margin", { classification: { sensitivity: "confidential" } }));
    const errors = async (text: string) => ((await failure(define(t.manager, "create", { key: "f", kind: "formula", definition: formula(text) }))) as { data: { errors: Diagnostic[] } }).data.errors;
    expect(await errors("TODAY()")).toEqual([expect.objectContaining({ code: "timeFunction", start: 0, end: 7 })]);
    expect(await errors("DATEADD(NOW(), 1, 'days')")).toEqual([expect.objectContaining({ code: "timeFunction", start: 8, end: 13 })]);
    expect(await errors("{X} * {Margin}")).toEqual([expect.objectContaining({ code: "classifiedField", start: 6, end: 14 })]);
    expect(await errors("{X} +")).toEqual([expect.objectContaining({ code: "syntaxError" })]);
    expect(await errors("{Nope} + 1")).toEqual([expect.objectContaining({ code: "unknownField", start: 0, end: 6 })]);
    expect(await errors('IF({X} > 1, 1, "one")')).toEqual([expect.objectContaining({ code: "mixedBranches" })]);
    expect(await errors('{X} + "1"')).toEqual([expect.objectContaining({ code: "typeMismatch" })]);
    for (const extra of [{ unique: true }, { required: true }, { defaultValue: 1 }]) {
      expect(await failure(define(t.manager, "create", { key: "f", kind: "formula", definition: formula("{X} + 1", "F", extra) })))
        .toMatchObject({ code: "VALIDATION", message: expect.stringContaining("its value is computed") });
    }
    expect(await failure(define(t.manager, "create", { key: "f", kind: "formula", definition: formula("{X} + 1"),
      appliesWhen: { operator: "isNotEmpty", left: { kind: "path", path: "name" } } }))).toMatchObject({ message: expect.stringContaining("appliesWhen") });
    expect(await failure(define(t.manager, "create", { key: "f", kind: "formula", definition: { label: label("F"), formula: { text: "{X}" } } })))
      .toMatchObject({ message: expect.stringContaining("classification") });
    // The kind of a field never changes.
    const f = await ready(t, "f", formula("{X} + 1"));
    expect(await failure(define(t.manager, "update", { fieldId: f, kind: "stored", definition: number("F") }))).toMatchObject({ message: expect.stringContaining("kind never changes") });
    expect(await failure(define(t.manager, "update", { fieldId: f, definition: formula("{X} + 1", "F", { classification: { sensitivity: "internal" } }) })))
      .toMatchObject({ message: expect.stringContaining("classification never changes") });
  });

  test("a division by zero is an error of that record: null in the source, the code in extensionsMeta, no index row", async () => {
    const t = await tenant();
    await field(t.manager, "a", number("A"));
    await field(t.manager, "b", number("B"));
    const ratio = await ready(t, "ratio", formula("{A} / {B}", "Ratio"));
    await ready(t, "safe", formula("IF({B} = 0, 0, {A} / {B})", "Safe"));
    const bad = await created(t.writer, { a: 1, b: 0 });
    expect(bad.extensions).toMatchObject({ ratio: null, safe: 0 });
    expect(bad.extensionsMeta.ratio).toMatchObject({ error: "divideByZero" });
    expect((await source(bad.id))[ratio]).toBeNull();
    expect((await source(bad.id)).$meta).toEqual({ [ratio]: { error: "divideByZero" } });
    expect(await indexed(bad.id, ratio)).toEqual([]);
    const good = await created(t.writer, { a: 1, b: 4 });
    expect(good.extensions.ratio).toBe(0.25);
    // Fixed by the next write: the code goes.
    expect(await update(t.writer, bad.id, { extensions: { b: 2 } })).toMatchObject({ data: { extensions: { ratio: 0.5 } } });
    expect((await get(t.reader, bad.id))!.extensionsMeta.ratio!.error).toBeUndefined();
    expect((await source(bad.id)).$meta).toBeUndefined();
    // An errored record is excluded from a filter, as a missing value is.
    await created(t.writer, { a: 3, b: 0 });
    expect(await list(t.reader, { filter: { extensions: { ratio: { gte: 0 } } } }).then(ids)).toHaveLength(2);
  });

  test("a formula filters and sorts on the index column of its result type", async () => {
    const t = await tenant();
    await field(t.manager, "capacityKwh", number("Capacity kWh"));
    await ready(t, "double", formula("{Capacity kWh} * 2", "Double"));
    await ready(t, "size", formula('IF({Capacity kWh} > 5, "large", "small")', "Size"));
    const [a, b, c] = [await created(t.writer, { capacityKwh: 1 }), await created(t.writer, { capacityKwh: 7 }), await created(t.writer, { capacityKwh: 4 })];
    const none = await created(t.writer, {});
    expect(await list(t.reader, { filter: { extensions: { double: { gte: 8 } } } }).then(ids).then((found) => found.sort())).toEqual([b.id, c.id].sort());
    expect(await list(t.reader, { filter: { extensions: { size: { eq: "large" } } } }).then(ids)).toEqual([b.id]);
    expect(await list(t.reader, { sort: { field: "extensions.double", direction: "desc" } }).then(ids)).toEqual([b.id, c.id, a.id, none.id]);
    expect(await list(t.reader, { sort: { field: "extensions.double", direction: "asc" } }).then(ids)).toEqual([none.id, a.id, c.id, b.id]);
  });

  test("a new or changed formula is backfilled over every record: resumable, idempotent, never left updating", async () => {
    const t = await tenant();
    await field(t.manager, "x", number("X"));
    const records = [await created(t.writer, { x: 1 }), await created(t.writer, { x: 2 }), await created(t.writer, { x: 3 })];
    const triple = await field(t.manager, "triple", formula("{X} * 3", "Triple"), "formula");
    const started = await listed(t, "triple");
    expect(started).toMatchObject({ state: "updating", backfill: { state: "queued", processed: 0, total: 3 } });
    // A record written while the backfill is pending is computed at once.
    const fresh = await created(t.writer, { x: 10 });
    expect(fresh.extensions.triple).toBe(30);

    const backfillId = started.backfill!.id;
    const first = await withDbSession(fixture.worker.db, t.manager, (trx) => runBackfillBatch(trx, t.manager, backfillId, 2));
    expect(first).toMatchObject({ state: "running", processed: 2, more: true });
    // Every record up to the cursor is computed, none after it (ids are random, so `fresh` may be among the first two).
    const valueOf = async (record: Row) => (await source(record.id))[triple];
    const done = records.filter((record) => record.id <= first.cursor!);
    expect(await Promise.all(done.map(valueOf))).not.toContain(undefined);
    expect(await Promise.all(records.filter((record) => record.id > first.cursor!).map(valueOf))).toEqual(records.filter((record) => record.id > first.cursor!).map(() => undefined));
    // Resumes after the cursor; running it again changes nothing.
    await drainJobs();
    expect(await listed(t, "triple")).toMatchObject({ state: "ready", backfill: { state: "done", processed: 4 } });
    expect((await Promise.all(records.map((record) => get(t.reader, record.id)))).map((row) => row!.extensions.triple)).toEqual([3, 6, 9]);
    expect(await withDbSession(fixture.worker.db, t.manager, (trx) => runBackfillBatch(trx, t.manager, backfillId)))
      .toMatchObject({ state: "done", more: false, processed: 4 });
    expect(await indexed(records[1]!.id, triple)).toEqual([{ value_number: "6", value_text: null }]);

    // A changed formula recomputes every record and every formula that reads it.
    await ready(t, "plus", formula("{Triple} + 1", "Plus"));
    expect(await define(t.manager, "update", { fieldId: triple, definition: formula("{X} * 4", "Triple") })).toMatchObject({ state: "updating", version: 2 });
    await drainJobs();
    expect((await Promise.all(records.map((record) => get(t.reader, record.id)))).map((row) => [row!.extensions.triple, row!.extensions.plus]))
      .toEqual([[4, 5], [8, 9], [12, 13]]);
    // A new label only prints the text again: no backfill.
    const plus = (await listed(t, "plus")).fieldId;
    expect(await define(t.manager, "update", { fieldId: triple, definition: formula("{X} * 4", "Times four") })).toMatchObject({ state: "ready", version: 3 });
    expect((await listed(t, "plus")).definition.formula.text).toBe("{Times four} + 1");

    // A batch that fails (here: the worker lost its write grant) is rolled
    // back and leaves the field suspended, never updating.
    expect(await define(t.manager, "update", { fieldId: plus, definition: formula("{Times four} + 2", "Plus") })).toMatchObject({ state: "updating" });
    await privileged(sql`revoke update (extension_values) on erp.extensible_assets from openshapeforge_worker`);
    try {
      await drainJobs();
    } finally {
      await privileged(sql`grant update (extension_values) on erp.extensible_assets to openshapeforge_worker`);
    }
    expect((await source(records[0]!.id))[plus]).toBe(5);
    expect(await listed(t, "plus")).toMatchObject({ state: "suspended", backfill: { state: "failed" } });
    expect((await get(t.reader, records[0]!.id))!.extensionsMeta.plus).toMatchObject({ suspended: true });
    // Saving it again starts over.
    expect(await define(t.manager, "update", { fieldId: plus, definition: formula("{Times four} + 2", "Plus") })).toMatchObject({ state: "updating" });
    await drainJobs();
    expect(await listed(t, "plus")).toMatchObject({ state: "ready", backfill: { state: "done" } });
    expect((await get(t.reader, records[0]!.id))!.extensions.plus).toBe(6);
  });

  test("a snapshot freezes the formula's value and its text and result type", async () => {
    const t = await tenant();
    await field(t.manager, "x", number("X"));
    const double = await ready(t, "double", formula("{X} * 2", "Double"));
    const record = await created(t.writer, { x: 21 });
    const snapshot = await withDbSession(fixture.app.db, t.reader, async (trx) => {
      const row = (await sql<{ row: Record<string, unknown> }>`select to_jsonb(a.*) as row from erp.extensible_assets a where id = ${record.id}::uuid`.execute(trx)).rows[0]!.row;
      return extensionSnapshot(trx, t.reader, ENTITY, row);
    });
    expect(snapshot.extensions[double]).toBe(42);
    expect(snapshot.extensionDefinitions[double]).toEqual({ version: 1, key: "double", label: label("Double"), osfType: "number",
      kind: "formula", formula: { text: "{X} * 2", resultType: "number" } });
    expect(JSON.stringify(snapshot)).not.toContain("\"ast\"");
  });

  test("MCP: a formula is read-only — never in the create or update input, marked readOnly where a list filters", async () => {
    const t = await tenant();
    await field(t.manager, "x", number("X"));
    await ready(t, "double", formula("{X} * 2", "Double"));
    await primeSessionExtensions(fixture.app.db, t.writer);
    const tool = (operation: string) => catalog.tools.find((candidate) => candidate.entity === ENTITY && candidate.operation === operation)!;
    for (const operation of ["create", "update"]) {
      const schema = withExtensionTool(tool(operation), fixture.table, t.writer).inputSchema as { properties: Record<string, any> };
      const extensions = operation === "create" ? schema.properties.extensions : schema.properties.values.properties.extensions;
      expect(extensions).toMatchObject({ additionalProperties: false, description: expect.stringContaining("read-only, so never accepted here: double") });
      expect(Object.keys(extensions.properties)).toEqual(["x"]);
    }
    const described = describeTool(tool("list"), undefined, fixture.table, t.writer) as unknown as { inputSchema: { properties: Record<string, any> } };
    expect(described.inputSchema.properties.filter.properties.extensions.properties.double).toMatchObject({ readOnly: true });
    expect(described.inputSchema.properties.sortField.enum).toContain("extensions.double");
    const tables = new Map([[fixture.table.name, fixture.table]]);
    await expect(invokeTool(withExtensionTool(tool("create"), fixture.table, t.writer), undefined, fixture.table, tables, fixture.app.db, t.writer,
      { name: "MCP", extensions: { double: 4 } })).rejects.toThrow();
    const made = await invokeTool(withExtensionTool(tool("create"), fixture.table, t.writer), undefined, fixture.table, tables, fixture.app.db, t.writer,
      { name: "MCP", extensions: { x: 4 } }) as unknown as { structuredContent?: { data: { extensions: Record<string, unknown> } } };
    expect(made.structuredContent?.data.extensions).toMatchObject({ x: 4, double: 8 });
  });

  test("RLS: another tenant sees neither the records, the values nor the index of a formula", async () => {
    const a = await tenant();
    const b = await tenant();
    await field(a.manager, "x", number("X"));
    const double = await ready(a, "double", formula("{X} * 2", "Double"));
    const record = await created(a.writer, { x: 5 });
    expect(await get(b.reader, record.id)).toBeNull();
    expect(await list(b.reader, {}).then(ids)).toEqual([]);
    const seen = await withDbSession(fixture.app.db, b.writer, async (trx) => (await sql<{ n: string }>`select count(*)::text as n
      from ${sql.table(VALUES_TABLE)} where field_id = ${double}::uuid`.execute(trx)).rows[0]!.n);
    expect(seen).toBe("0");
    expect(((await define(b.manager, "list")) as { items: unknown[] }).items).toEqual([]);
    // Tenant B may define a formula of the same key over its own fields only.
    expect(await failure(define(b.manager, "create", { key: "double", kind: "formula", definition: formula("{X} * 2", "Double") })))
      .toMatchObject({ data: { errors: [expect.objectContaining({ code: "unknownField" })] } });
  });

  test("a result that would not fit the index is an error code, never a database error; a constant one is refused", async () => {
    const t = await tenant();
    await field(t.manager, "d", typed("date", "D"));
    await field(t.manager, "n", number("N"));
    await field(t.manager, "note", typed("string", "Note"));
    // A formula without field references gives every record the same error: refused when saved, with that code.
    expect(await failure(define(t.manager, "create", { key: "long", kind: "formula", definition: formula(`"${"x".repeat(3000)}"`, "Long") })))
      .toMatchObject({ code: "VALIDATION", data: { errors: [expect.objectContaining({ code: "textTooLong" })] } });
    expect(await failure(define(t.manager, "create", { key: "far", kind: "formula", definition: formula("DATEADD(CREATED_TIME(), 8000, 'years')", "Far") })))
      .toMatchObject({ data: { errors: [expect.objectContaining({ code: "invalidDate" })] } });
    const later = await ready(t, "later", formula("DATEADD({D}, {N}, 'years')", "Later"));
    const twice = await ready(t, "twice", formula("{Note} & {Note}", "Twice"));
    const sum = await ready(t, "sum", formula("{N} + 0.2", "Sum"));
    expect((await created(t.writer, { d: "2026-01-01", n: 1 })).extensions.later).toBe("2027-01-01");
    // Year 10026 has no place in a date column.
    const far = await created(t.writer, { d: "2026-01-01", n: 8000, note: "x".repeat(600) });
    expect(far.extensions).toMatchObject({ later: null, twice: null });
    expect(far.extensionsMeta).toMatchObject({ later: { error: "invalidDate" }, twice: { error: "textTooLong" } });
    expect(await indexed(far.id, later)).toEqual([]);
    expect(await indexed(far.id, twice)).toEqual([]);
    // The index holds the number as written, not its binary approximation.
    const decimal = await created(t.writer, { n: 0.1 });
    expect(decimal.extensions.sum).toBe(0.3);
    expect(await indexed(decimal.id, sum)).toEqual([{ value_number: "0.3", value_text: null }]);
    expect(await list(t.reader, { filter: { extensions: { sum: { eq: 0.3 } } } }).then(ids)).toEqual([decimal.id]);
  });

  test("retention and setNull compute the formulas over the value they change, in the same transaction", async () => {
    const t = await tenant();
    const note = await field(t.manager, "note", typed("string", "Note", { retention: { days: 30 } }));
    await field(t.manager, "links", typed(ENTITY, "Links", { cardinality: "collection", onDelete: "setNull" }));
    const copy = await ready(t, "copy", formula('IF({Note} = BLANK(), "none", {Note})', "Copy"));
    const old = await created(t.writer, { note: "kept beyond retention" });
    expect(old.extensions.copy).toBe("kept beyond retention");
    await privileged(sql`update erp.extensible_assets set created_at = now() - interval '40 days' where id = ${old.id}::uuid`);
    expect(await withDbSession(fixture.worker.db, t.manager, (trx) => applyExtensionRetention(trx, t.manager, ENTITY))).toEqual({ cleared: 1, retained: true });
    expect((await source(old.id))[note]).toBeUndefined();
    expect((await get(t.reader, old.id))!.extensions).toMatchObject({ note: null, copy: "none" });
    expect(await indexed(old.id, copy)).toEqual([{ value_number: null, value_text: "none" }]);
    expect(await list(t.reader, { filter: { extensions: { copy: { eq: "kept beyond retention" } } } }).then(ids)).toEqual([]);
    // setNull goes through the same write: the record's formulas stay what its values say.
    const target = await created(t.writer, undefined, "Target");
    const linked = await created(t.writer, { links: [target.id], note: "linked" });
    const removed = await executeEntityOperation(fixture.app.db, t.writer, { operation: { id: `${ENTITY}.delete`, intent: "delete" }, input: { id: target.id, confirmed: true, expectedVersion: String(target.updated_at) } });
    expect(removed).toMatchObject({ data: { deleted: true } });
    expect((await get(t.reader, linked.id))!.extensions).toMatchObject({ links: null, copy: "linked" });
    expect(await indexed(linked.id, copy)).toEqual([{ value_number: null, value_text: "linked" }]);
  });

  test("a changed result type types every reader again: refused with the reader's name, or the reader follows", async () => {
    const t = await tenant();
    await field(t.manager, "a", number("A"));
    const f = await ready(t, "f", formula("{A} + 1", "F"));
    const g = await ready(t, "g", formula("{F} * 2", "G"));
    const same = await ready(t, "same", formula("{F}", "Same"));
    const record = await created(t.writer, { a: 4 });
    expect(record.extensions).toMatchObject({ f: 5, g: 10, same: 5 });
    const refused = await failure(define(t.manager, "update", { fieldId: f, definition: formula('"abc"', "F") }));
    expect(refused).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("'G' reads this formula and could no longer be computed"),
      data: { errors: [expect.objectContaining({ code: "typeMismatch", params: expect.objectContaining({ field: "G" }) })] } });
    expect((await listed(t, "f")).definition.formula.resultType).toBe("number");
    // Without G, the reader that only passes F on becomes text with it, and is computed again.
    await define(t.manager, "deprecate", { fieldId: g });
    expect(await define(t.manager, "update", { fieldId: f, definition: formula('"x" & {A}', "F") })).toMatchObject({ state: "updating" });
    expect(await listed(t, "same")).toMatchObject({ state: "updating", definition: { osfType: "string", formula: { resultType: "text" } } });
    await drainJobs();
    expect(await listed(t, "same")).toMatchObject({ state: "ready" });
    expect((await get(t.reader, record.id))!.extensions).toMatchObject({ f: "x4", same: "x4" });
    expect(await indexed(record.id, same)).toEqual([{ value_number: null, value_text: "x4" }]);
    // G was deprecated over a number: its restore checks it again, and refuses.
    expect(await failure(define(t.manager, "restore", { fieldId: g }))).toMatchObject({ code: "VALIDATION",
      data: { errors: [expect.objectContaining({ code: "typeMismatch" })] } });
    expect((await listed(t, "g")).state).toBe("deprecated");
  });

  test("a deprecated reader counts toward formulaDepth, and a restore is checked as a save", async () => {
    const t = await tenant();
    await field(t.manager, "a", number("A"));
    const f1 = await ready(t, "f1", formula("{A} + 1", "F1"));
    await ready(t, "f2", formula("{F1} + 1", "F2"));
    await ready(t, "f3", formula("{F2} + 1", "F3"));
    const x = await ready(t, "x", formula("{F3} + 1", "X"));
    await ready(t, "g1", formula("{A} + 1", "G1"));
    await ready(t, "g2", formula("{G1} + 1", "G2"));
    const deepen = () => define(t.manager, "update", { fieldId: f1, definition: formula("{G2} + 1", "F1") });
    expect(await failure(deepen())).toMatchObject({ data: { errors: [expect.objectContaining({ code: "depthExceeded" })] } });
    await define(t.manager, "deprecate", { fieldId: x });
    // Deprecated, X still reads F3: deepening F1 is refused as before, naming X.
    expect(await failure(deepen())).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("'X' reads this formula and would be 6 formulas deep") });
    expect(await define(t.manager, "restore", { fieldId: x })).toMatchObject({ state: "updating" });
    await drainJobs();
    expect((await created(t.writer, { a: 1 })).extensions).toMatchObject({ f1: 2, f2: 3, f3: 4, x: 5 });
  });

  test("a stored field reads as a reader sees it: a record without a value reads the default", async () => {
    const t = await tenant();
    const old = await created(t.writer, {});
    const x = await field(t.manager, "x", number("X", { defaultValue: 10 }));
    expect((await get(t.reader, old.id))!.extensions.x).toBe(10);
    await ready(t, "twice", formula("{X} * 2", "Twice"));
    expect((await source(old.id))[x]).toBeUndefined();
    expect((await get(t.reader, old.id))!.extensions.twice).toBe(20);
    expect((await created(t.writer, { x: 3 })).extensions.twice).toBe(6);
    // A new default is a new input: the formulas over it are computed again.
    await define(t.manager, "update", { fieldId: x, definition: number("X", { defaultValue: 7 }) });
    await drainJobs();
    expect((await get(t.reader, old.id))!.extensions).toMatchObject({ x: 7, twice: 14 });
  });

  test("an error code does not stop a backfill; a database failure suspends the field until it is saved again or rebuilt", async () => {
    const t = await tenant();
    await field(t.manager, "d", typed("date", "D"));
    await field(t.manager, "n", number("N"));
    const f = await ready(t, "f", formula("{N} + 1", "F"));
    const near = await created(t.writer, { d: "2026-01-01", n: 1 });
    const beyond = await created(t.writer, { d: "2026-01-01", n: 9000 });
    // One record per batch: the record beyond year 9999 gets its code, the others their date.
    await define(t.manager, "update", { fieldId: f, definition: formula("DATEADD({D}, {N}, 'years')", "F") });
    const backfillId = (await listed(t, "f")).backfill!.id;
    for (let batch = 0; batch < 5; batch += 1) {
      const result = await withDbSession(fixture.worker.db, t.manager, (trx) => runBackfillBatch(trx, t.manager, backfillId, 1));
      expect(result.state).not.toBe("failed");
      if (!result.more) break;
    }
    expect(await listed(t, "f")).toMatchObject({ state: "ready", backfill: { state: "done", processed: 2 } });
    expect((await get(t.reader, near.id))!.extensions.f).toBe("2027-01-01");
    expect((await get(t.reader, beyond.id))!.extensionsMeta.f).toMatchObject({ error: "invalidDate" });

    // A snapshot freezes an error code as one, and a value only from a ready definition.
    const snapshot = (id: string) => withDbSession(fixture.app.db, t.reader, async (trx) => {
      const row = (await sql<{ row: Record<string, unknown> }>`select to_jsonb(a.*) as row from erp.extensible_assets a where id = ${id}::uuid`.execute(trx)).rows[0]!.row;
      return extensionSnapshot(trx, t.reader, ENTITY, row);
    });
    expect((await snapshot(beyond.id)).extensions[f]).toEqual({ error: "invalidDate" });
    expect((await snapshot(near.id)).extensions[f]).toBe("2027-01-01");

    // A database failure (the worker lost its write grant) suspends the field.
    await define(t.manager, "update", { fieldId: f, definition: formula("DATEADD({D}, {N}, 'days')", "F") });
    expect((await snapshot(near.id)).extensions[f]).toEqual({ unavailable: "updating" });
    await privileged(sql`revoke update (extension_values) on erp.extensible_assets from openshapeforge_worker`);
    try {
      await drainJobs();
    } finally {
      await privileged(sql`grant update (extension_values) on erp.extensible_assets to openshapeforge_worker`);
    }
    expect(await listed(t, "f")).toMatchObject({ state: "suspended", backfill: { state: "failed" } });
    expect((await get(t.reader, near.id))!.extensionsMeta.f).toMatchObject({ suspended: true });
    // The flag is the definition's, never stored per record.
    expect(JSON.stringify(await source(near.id))).not.toContain("suspended");
    expect((await snapshot(near.id)).extensions[f]).toEqual({ unavailable: "suspended" });
    expect(await list(t.reader, { filter: { extensions: { f: { gte: "2027-01-01" } } } }))
      .toMatchObject({ error: { code: "BAD_USER_INPUT", message: expect.stringContaining("suspended") } });
    expect(await list(t.reader, { sort: { field: "extensions.f", direction: "asc" } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    // rebuildIndex resumes it as a formula backfill.
    await define(t.manager, "rebuildIndex", { fieldId: f });
    expect((await listed(t, "f")).state).toBe("updating");
    await drainJobs();
    expect(await listed(t, "f")).toMatchObject({ state: "ready", backfill: { state: "done" } });
    expect((await get(t.reader, near.id))!.extensions.f).toBe("2026-01-02");
    expect(await list(t.reader, { filter: { extensions: { f: { gte: "2026-01-02" } } } }).then(ids)).toContain(near.id);
  });

  test("a formula reads no platform-written field: updatedAt and the publication state are out of scope", async () => {
    const t = await tenant();
    expect(await failure(define(t.manager, "create", { key: "touched", kind: "formula", definition: formula("YEAR({updatedAt})", "Touched") })))
      .toMatchObject({ data: { errors: [expect.objectContaining({ code: "outOfScope", start: 5, end: 16 })] } });
    expect(await ready(t, "made", formula("YEAR({createdAt})", "Made"))).toBeString();
  });
});
