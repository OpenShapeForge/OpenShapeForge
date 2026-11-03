// SPDX-License-Identifier: BUSL-1.1
/**
 * Tenant fields end to end on a scratch database (contract fase 1a): the
 * definition Operations and their validation, the write and read paths with
 * per-key redaction, uniqueness, reference authorization, RLS, structured
 * query, per-key audit, referencedBy, the deletion guard, orphans, and the
 * lifecycle backfills under the real worker role.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { withDbSession } from "../../../../db/session.js";
import { composeJobHandlers } from "../../../../jobs/handlers.js";
import { processJobBatch } from "../../../../jobs/worker.js";
import { executeEntityOperation } from "../../runtime.js";
import { serializeEntityRow } from "../../serialize-result.js";
import { executeFieldDefinitionAction, executeReferencedBy, type FieldDefinitionAction } from "../definitions.js";
import { findExtensionReferenceOrphans } from "../references.js";
import { EXTENSION_BACKFILL_KIND, EXTENSION_RETENTION_KIND, applyExtensionRetention, extensionBackfillJobHandler, extensionRetentionJobHandler, runBackfillBatch } from "../backfill.js";
import { catalog } from "../../../../mcp/catalog.js";
import { describeTool } from "../../../../mcp/entity-tool-projection.js";
import { invokeTool } from "../../../../mcp/entity-tool-invocation.js";
import { hasExtensibleEntities, primeSessionExtensions, withExtensionTool } from "../../../../mcp/extension-schemas.js";
import { renderTypeDefinition } from "../../../../graphql/generated-entity-schema.js";
import { createModuleSessionCapability, ModulePlatformRuntime } from "../../../../modules/platform.js";
import { bindOperationHandlers, invokeOperation, type OperationContract } from "../../../runtime.js";
import { createExtensionFixture, MANAGER_ROLE, READER_ROLE, sessionFor, WRITER_ROLE, type ExtensionFixture } from "./fixture.js";

let fixture: ExtensionFixture;
const tenantA = randomUUID();
const tenantB = randomUUID();
const manager = sessionFor(tenantA, [MANAGER_ROLE, WRITER_ROLE, READER_ROLE]);
const writer = sessionFor(tenantA, [WRITER_ROLE]);
const reader = sessionFor(tenantA, [READER_ROLE]);
const writerB = sessionFor(tenantB, [WRITER_ROLE, MANAGER_ROLE]);
const fields: Record<string, string> = {};
const silent = { info() {}, warn() {}, error() {} };
const handlers = composeJobHandlers([{ name: "test-extensions", jobHandlers: {
  [EXTENSION_BACKFILL_KIND]: extensionBackfillJobHandler, [EXTENSION_RETENTION_KIND]: extensionRetentionJobHandler,
} }]);

type Session = ReturnType<typeof sessionFor>;
const define = (session: Session, action: FieldDefinitionAction, input: Record<string, unknown> = {}) =>
  withDbSession(fixture.app.db, session, (trx) => executeFieldDefinitionAction(trx, session, "Task", action, input));
const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { operationError?: { code: string; message: string } }).operationError ?? error; }
  throw new Error("expected a refusal");
};
const label = (nl: string) => ({ nl, en: nl });

async function createTask(session: Session, extensions?: Record<string, unknown>, title = "Taak") {
  return executeEntityOperation(fixture.app.db, session, {
    operation: { id: "Task.create", intent: "create" },
    input: { values: { title, type: "follow_up", status: "open", ...(extensions ? { extensions } : {}) } },
  });
}
async function created(session: Session, extensions?: Record<string, unknown>, title?: string) {
  const result = await createTask(session, extensions, title);
  if ("error" in result || !result.data) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.data as Record<string, unknown> & { id: string; extensions: Record<string, unknown>; extensionsMeta: Record<string, Record<string, unknown>> };
}
async function update(session: Session, id: string, values: Record<string, unknown>) {
  return executeEntityOperation(fixture.app.db, session, { operation: { id: "Task.update", intent: "update" }, input: { id, values } });
}
async function get(session: Session, id: string) {
  const result = await executeEntityOperation(fixture.app.db, session, { operation: { id: "Task.get", intent: "get" }, input: { id } });
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return result.data as (Record<string, unknown> & { extensions: Record<string, unknown>; extensionsMeta: Record<string, Record<string, unknown>> }) | null;
}
async function remove(session: Session, row: { id: string; updated_at?: unknown }) {
  return executeEntityOperation(fixture.app.db, session, { operation: { id: "Task.delete", intent: "delete" },
    input: { id: row.id, confirmed: true, expectedVersion: String(row.updated_at) } });
}
async function list(session: Session, input: Record<string, unknown>) {
  return executeEntityOperation(fixture.app.db, session, { operation: { id: "Task.list", intent: "list" }, input });
}
const ids = (result: Awaited<ReturnType<typeof list>>) => {
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return (result.data as { items: Array<{ data: { id: string } }> }).items.map((item) => item.data.id);
};
async function indexRows(recordId: string, fieldId?: string) {
  return (await sql<Record<string, unknown>>`select * from erp.tasks_field_values where record_id = ${recordId}::uuid
    ${fieldId ? sql`and field_id = ${fieldId}::uuid` : sql``} order by field_id, ordinal`.execute(fixture.privileged.db)).rows;
}
async function drainJobs() {
  for (let round = 0; round < 50; round += 1) {
    const { processed } = await processJobBatch(fixture.worker.db, handlers, silent, { kinds: [EXTENSION_BACKFILL_KIND] });
    if (!processed) return;
  }
}

describe("tenant fields on an extensible entity", () => {
  beforeAll(async () => {
    fixture = await createExtensionFixture("main");
    await fixture.addTenants(tenantA, tenantB);
  }, 180_000);
  afterAll(async () => { await fixture?.close(); });

  test("definitions are validated, authorized and limited", async () => {
    expect(await failure(define(writer, "create", { key: "x", definition: { osfType: "string", classification: { sensitivity: "public" } } })))
      .toMatchObject({ code: "FORBIDDEN" });
    expect(await failure(define(manager, "create", { key: "f", kind: "formula", definition: { osfType: "number", classification: { sensitivity: "public" } } })))
      .toMatchObject({ code: "NOT_AVAILABLE" });
    expect(await failure(define(manager, "create", { key: "x", definition: { osfType: "string" } })))
      .toMatchObject({ code: "VALIDATION", message: expect.stringContaining("classification") });
    expect(await failure(define(manager, "create", { key: "x", definition: { osfType: "iban", classification: { sensitivity: "pii" } } })))
      .toMatchObject({ code: "VALIDATION", message: expect.stringContaining("not available") });
    expect(await failure(define(manager, "create", { key: "x", definition: { osfType: "string", cardinality: "collection", classification: { sensitivity: "public" } } })))
      .toMatchObject({ message: expect.stringContaining("Only references and static options") });
    expect(await failure(define(manager, "create", { key: "Bad", definition: { osfType: "string", classification: { sensitivity: "public" } } })))
      .toMatchObject({ code: "VALIDATION" });
    expect(await failure(define(manager, "create", { key: "x", definition: { osfType: "string", classification: { sensitivity: "public" } },
      appliesWhen: { operator: "equals", left: { kind: "path", path: "nope" }, right: { kind: "literal", value: 1 } } })))
      .toMatchObject({ message: expect.stringContaining("nope") });

    const options = { type: "static", items: [{ value: "batterij", label: label("Batterij") }, { value: "kit", label: label("Kit") }] };
    const specs: Array<[string, Record<string, unknown>, unknown?]> = [
      ["soort", { osfType: "string", label: label("Soort"), options, classification: { sensitivity: "public" } }],
      ["capaciteit", { osfType: "measurement", label: label("Capaciteit"), classification: { sensitivity: "public" } }],
      ["aantal", { osfType: "integer", label: label("Aantal"), defaultValue: 1, classification: { sensitivity: "public" } }],
      ["bsn", { osfType: "string", label: label("BSN"), classification: { sensitivity: "bsn" } }],
      ["sku", { osfType: "string", label: label("SKU"), unique: true, classification: { sensitivity: "internal" } }],
      ["links", { osfType: "Task", label: label("Gekoppeld"), cardinality: "collection", onDelete: "setNull", classification: { sensitivity: "public" } }],
      ["parent", { osfType: "Task", label: label("Hoofdtaak"), onDelete: "restrict", classification: { sensitivity: "public" } }],
      ["accu", { osfType: "number", label: label("Accu kWh"), required: true, classification: { sensitivity: "public" } },
        { operator: "equals", left: { kind: "path", path: "extensions.soort" }, right: { kind: "literal", value: "batterij" } }],
    ];
    for (const [key, definition, appliesWhen] of specs) {
      const record = await define(manager, "create", { key, definition, ...(appliesWhen ? { appliesWhen } : {}) }) as { fieldId: string; version: number; state: string };
      expect(record).toMatchObject({ key, version: 1, state: "ready", kind: "stored" });
      fields[key] = record.fieldId;
    }
    expect(await failure(define(manager, "create", { key: "soort", definition: { osfType: "string", classification: { sensitivity: "public" } } })))
      .toMatchObject({ code: expect.stringMatching(/CONFLICT|LIMIT_EXCEEDED/) });
    const ninth = await define(manager, "create", { key: "negende", definition: { osfType: "string", classification: { sensitivity: "public" } } }) as { fieldId: string };
    expect(await failure(define(manager, "create", { key: "tiende", definition: { osfType: "string", classification: { sensitivity: "public" } } })))
      .toMatchObject({ code: "LIMIT_EXCEEDED" });
    // A deleted field frees its slot (and needs no backfill work: no record has it).
    await define(manager, "deprecate", { fieldId: ninth.fieldId });
    await define(manager, "delete", { fieldId: ninth.fieldId, confirmAffectedRecords: 0 });
    const listed = await define(reader, "list") as { items: Array<{ key: string; position: number }> };
    expect(listed.items.map((item) => item.key)).toEqual(specs.map(([key]) => key));
    // Tenant B sees none of tenant A's definitions.
    expect(await define(writerB, "list")).toEqual({ items: [] });
  });

  test("writes are validated against the tenant definitions and read back per key", async () => {
    const battery = await created(writer, { soort: "batterij", accu: 13.5, capaciteit: { value: 10, unit: "kWh" }, bsn: "123456782", sku: "A-1" }, "Accu");
    expect(battery.extensions).toMatchObject({ soort: "batterij", accu: 13.5, capaciteit: { value: 10, unit: "kWh" }, bsn: "123456782", sku: "A-1", aantal: 1 });
    expect(battery.extensionsMeta.accu).toEqual({ applicable: true });
    expect(battery.extension_values).toBeUndefined();
    const serialized = serializeEntityRow(fixture.table, battery);
    expect(serialized.extensions).toEqual(battery.extensions);
    expect(serialized.extensionValues).toBeUndefined();

    const missing = await createTask(writer, { soort: "batterij" });
    expect(missing).toMatchObject({ error: { code: "VALIDATION", violations: [expect.objectContaining({ field: "extensions.accu", code: "REQUIRED" })] } });
    const kit = await created(writer, { soort: "kit" }, "Kit");
    expect(kit.extensionsMeta.accu).toEqual({ applicable: false });
    expect(kit.extensions.accu).toBeNull();
    expect(await createTask(writer, { kleur: "rood" })).toMatchObject({ error: { code: "VALIDATION", violations: [expect.objectContaining({ code: "UNKNOWN_FIELD" })] } });
    expect(await createTask(writer, { aantal: 1.5 })).toMatchObject({ error: { code: "VALIDATION", violations: [expect.objectContaining({ field: "extensions.aantal" })] } });
    expect(await createTask(writer, { extensionValues: {} } as never)).toMatchObject({ error: { code: "VALIDATION" } });
    expect(await executeEntityOperation(fixture.app.db, writer, { operation: { id: "Task.create", intent: "create" },
      input: { values: { title: "raw", type: "follow_up", status: "open", extensionValues: { [fields.bsn!]: "x" } } } })).toMatchObject({ error: {} });

    // Index rows are written with the record, by type.
    const rows = await indexRows(battery.id);
    expect(rows.find((row) => row.field_id === fields.accu)).toMatchObject({ value_number: "13.5", ordinal: 0 });
    expect(rows.find((row) => row.field_id === fields.capaciteit)).toMatchObject({ value_number: "10", value_text: "kWh" });
    expect(rows.find((row) => row.field_id === fields.bsn)).toMatchObject({ value_text: "123456782" });

    // Redaction per key: a reader without a write grant sees no classified value.
    expect((await get(reader, battery.id))!.extensions).toMatchObject({ bsn: null, sku: "A-1", accu: 13.5 });
    expect((await get(writer, battery.id))!.extensions.bsn).toBe("123456782");

    // An extension-only update is a change: the version moves, the index follows.
    const updated = await update(writer, battery.id, { extensions: { accu: 14 } });
    if ("error" in updated || !updated.data) throw new Error(JSON.stringify(updated));
    expect((updated.data as { extensions: Record<string, unknown> }).extensions.accu).toBe(14);
    expect((updated.data as { updated_at?: unknown }).updated_at).not.toEqual(battery.updated_at);
    expect((await indexRows(battery.id, fields.accu))[0]).toMatchObject({ value_number: "14" });
    // Clearing an applicable required field is refused; clearing an optional one is not.
    expect(await update(writer, battery.id, { extensions: { accu: null } })).toMatchObject({ error: { code: "VALIDATION" } });
    const cleared = await update(writer, battery.id, { extensions: { capaciteit: null } });
    expect("error" in cleared).toBe(false);
    expect(await indexRows(battery.id, fields.capaciteit)).toEqual([]);
    // Tenant B cannot read or write tenant A's record.
    expect(await get(writerB, battery.id)).toBeNull();
    expect(await update(writerB, battery.id, { extensions: { accu: 1 } })).toMatchObject({ data: null });
  });

  test("uniqueness is claimed per tenant and released by update and delete", async () => {
    const first = await created(writer, { sku: "U-1" });
    expect(await createTask(writer, { sku: "U-1" })).toMatchObject({ error: { code: "CONFLICT" } });
    // Another tenant has its own namespace (and no definitions at all).
    expect(await createTask(writerB, { sku: "U-1" })).toMatchObject({ error: { code: "VALIDATION" } });
    const moved = await update(writer, first.id, { extensions: { sku: "U-2" } });
    expect("error" in moved).toBe(false);
    expect((await sql`select value_text from erp.tasks_field_unique_values where record_id = ${first.id}::uuid`.execute(fixture.privileged.db)).rows)
      .toEqual([{ value_text: "U-2" }]);
    const second = await created(writer, { sku: "U-1" });
    expect(await createTask(writer, { sku: "U-2" })).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await remove(writer, (moved as unknown as { data: { id: string; updated_at: unknown } }).data)).toMatchObject({ data: { deleted: true } });
    expect((await created(writer, { sku: "U-2" })).extensions.sku).toBe("U-2");
    expect(second.extensions.sku).toBe("U-1");
  });

  test("references are authorized against the real target row", async () => {
    const target = await created(writer, undefined, "Doel");
    const foreign = await created(writerB, undefined, "Vreemd");
    expect(await createTask(writer, { parent: foreign.id })).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await createTask(writer, { parent: randomUUID() })).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await createTask(writer, { parent: "not-a-uuid" })).toMatchObject({ error: { code: "VALIDATION" } });
    const child = await created(writer, { parent: target.id, links: [target.id] }, "Kind");
    expect(child.extensions).toMatchObject({ parent: target.id, links: [target.id] });
    expect((await indexRows(child.id, fields.links))[0]).toMatchObject({ value_ref_id: target.id, ordinal: 0 });
  });

  test("structured query filters and sorts through the index, never on classified keys", async () => {
    const tag = randomUUID().slice(0, 8);
    const a = await created(writer, { soort: "batterij", accu: 5, capaciteit: { value: 3, unit: "kWh" } }, `Q-${tag}-a`);
    const b = await created(writer, { soort: "batterij", accu: 20 }, `Q-${tag}-b`);
    const c = await created(writer, { soort: "kit" }, `Q-${tag}-c`);
    const d = await created(writer, { soort: "batterij", accu: 20, links: [a.id, c.id] }, `Q-${tag}-d`);
    const scope = { title: `Q-${tag}` };
    expect(ids(await list(reader, { filter: { ...scope, extensions: { soort: { eq: "batterij" } } }, limit: 50 })).sort()).toEqual([a.id, b.id, d.id].sort());
    expect(ids(await list(reader, { filter: { ...scope, extensions: { accu: { gte: 10 } } } })).sort()).toEqual([b.id, d.id].sort());
    expect(ids(await list(reader, { filter: { ...scope, extensions: { capaciteit: { gt: 1 } } } }))).toEqual([a.id]);
    expect(ids(await list(reader, { filter: { ...scope, extensions: { accu: { isNull: true } } } }))).toEqual([c.id]);
    expect(ids(await list(reader, { filter: { ...scope, extensions: { links: { contains: c.id } } } }))).toEqual([d.id]);
    expect(ids(await list(reader, { filter: { ...scope, or: [{ extensions: { soort: { eq: "kit" } } }, { extensions: { accu: { lt: 6 } } }] } })).sort()).toEqual([a.id, c.id].sort());
    expect(await list(reader, { filter: { ...scope, extensions: { links: { eq: c.id } } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    // A classified key is never a filter or sort key, even for a writer who may read it.
    expect(await list(writer, { filter: { extensions: { bsn: { eq: "123456782" } } } })).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await list(writer, { sort: { field: "extensions.bsn", direction: "asc" } })).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await list(writer, { filter: { extensions: { nope: { eq: 1 } } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    // limits.filtersPerQuery counts predicates over the whole tree (limit 3).
    expect(await list(reader, { filter: { extensions: { accu: { gte: 1, lte: 100 } }, and: [{ extensions: { soort: { eq: "kit" } } }, { extensions: { aantal: { eq: 1 } } }] } }))
      .toMatchObject({ error: { code: "BAD_USER_INPUT", message: expect.stringContaining("at most 3") } });
    // Sort: nulls last, id as tiebreaker.
    const sorted = ids(await list(reader, { filter: scope, sort: { field: "extensions.accu", direction: "desc" } }));
    expect(sorted).toEqual([...[b.id, d.id].sort(), a.id, c.id]);
    expect(await list(reader, { sort: { field: "extensions.links" } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    // Tenant B's query sees nothing of tenant A, by filter or by sort.
    expect(await list(writerB, { filter: { extensions: { soort: { eq: "batterij" } } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    expect(ids(await list(writerB, { filter: scope }))).toEqual([]);
    // Nor do the side tables leak through RLS to another tenant's session.
    const leaked = await withDbSession(fixture.app.db, writerB, async (trx) => ({
      values: (await sql<{ n: string }>`select count(*)::text as n from erp.tasks_field_values`.execute(trx)).rows[0]!.n,
      claims: (await sql<{ n: string }>`select count(*)::text as n from erp.tasks_field_unique_values`.execute(trx)).rows[0]!.n,
      definitions: (await sql<{ n: string }>`select count(*)::text as n from platform.extension_field_definitions`.execute(trx)).rows[0]!.n,
    }));
    expect(leaked).toEqual({ values: "0", claims: "0", definitions: "0" });
  });

  test("audit is per key with definition versions, and classified keys never appear raw", async () => {
    const task = await created(writer, { bsn: "999999990", accu: 1, soort: "batterij" }, "Audit");
    await update(writer, task.id, { extensions: { accu: 2, bsn: "111222333" } });
    const events = (await sql<{ event_type: string; payload: Record<string, any> }>`select event_type, payload from platform.entity_events
      where aggregate_id = ${task.id} order by sequence`.execute(fixture.privileged.db)).rows;
    const extension = events.filter((event) => event.event_type === "extensionsChanged");
    expect(extension).toHaveLength(2);
    expect(extension[1]!.payload.audit).toMatchObject({
      entityType: "Task",
      before: { "extensions.accu": 1, "extensions.bsn": "[REDACTED]" },
      after: { "extensions.accu": 2, "extensions.bsn": "[REDACTED]" },
      changedFields: ["extensions.accu", "extensions.bsn"],
      definitionVersions: { "extensions.accu": 1, "extensions.bsn": 1 },
    });
    const rowEvents = events.filter((event) => event.event_type !== "extensionsChanged");
    expect(rowEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of rowEvents) {
      expect(event.payload.audit.after.extensionValues ?? "[REDACTED]").toBe("[REDACTED]");
    }
    expect(JSON.stringify(events)).not.toContain("999999990");
    expect(JSON.stringify(events)).not.toContain("111222333");
  });

  test("referencedBy counts per source field, per reader and per tenant", async () => {
    const target = await created(writer, undefined, "Referenced");
    await created(writer, { parent: target.id });
    await created(writer, { parent: target.id, links: [target.id] });
    const referenced = await withDbSession(fixture.app.db, reader, (trx) => executeReferencedBy(trx, reader, "Task", { id: target.id }));
    expect(referenced.items.sort((x, y) => x.fieldKey.localeCompare(y.fieldKey))).toEqual([
      { entity: "Task", fieldId: fields.links!, fieldKey: "links", label: label("Gekoppeld"), count: 1 },
      { entity: "Task", fieldId: fields.parent!, fieldKey: "parent", label: label("Hoofdtaak"), count: 2 },
    ]);
    const other = await withDbSession(fixture.app.db, writerB, (trx) => executeReferencedBy(trx, writerB, "Task", { id: target.id }));
    expect(other.items).toEqual([]);
    const outsider = sessionFor(tenantA, ["Nothing.At.All"]);
    expect(await failure(withDbSession(fixture.app.db, outsider, (trx) => executeReferencedBy(trx, outsider, "Task", { id: target.id }))))
      .toMatchObject({ code: "FORBIDDEN" });
  });

  test("the deletion guard restricts or unlinks, and orphans are reported", async () => {
    const restricted = await created(writer, undefined, "Restricted");
    const linked = await created(writer, undefined, "Linked");
    const source = await created(writer, { parent: restricted.id, links: [linked.id, restricted.id] }, "Source");
    const refused = await remove(writer, restricted);
    expect(refused).toMatchObject({ error: { code: "OPERATION_REFUSED", message: expect.stringContaining("parent") } });
    const removed = await remove(writer, linked);
    expect(removed).toMatchObject({ data: { deleted: true } });
    expect((await get(writer, source.id))!.extensions.links).toEqual([restricted.id]);
    expect((await indexRows(source.id, fields.links)).map((row) => row.value_ref_id)).toEqual([restricted.id]);

    const ghost = randomUUID();
    await sql`insert into erp.tasks_field_values (tenant_id, record_id, field_id, ordinal, value_ref_id)
      values (${tenantA}::uuid, ${source.id}::uuid, ${fields.parent!}::uuid, 1, ${ghost}::uuid)`.execute(fixture.privileged.db);
    const orphans = await withDbSession(fixture.app.db, writer, (trx) => findExtensionReferenceOrphans(trx, writer));
    expect(orphans).toEqual([{ entity: "Task", fieldKey: "parent", recordId: source.id, targetEntity: "Task", targetId: ghost }]);
    expect(await withDbSession(fixture.app.db, writerB, (trx) => findExtensionReferenceOrphans(trx, writerB))).toEqual([]);
    await sql`delete from erp.tasks_field_values where value_ref_id = ${ghost}::uuid`.execute(fixture.privileged.db);
  });

  test("lifecycle: rename, widening retype as a backfill under the worker role, refusals", async () => {
    const task = await created(writer, { aantal: 3 }, "Lifecycle");
    const renamed = await define(manager, "update", { fieldId: fields.aantal, key: "stuks" }) as { version: number; state: string };
    expect(renamed).toMatchObject({ key: "stuks", version: 2, state: "ready" });
    expect((await get(writer, task.id))!.extensions).toMatchObject({ stuks: 3 });
    expect((await get(writer, task.id))!.extensions.aantal).toBeUndefined();

    const widened = await define(manager, "update", { fieldId: fields.aantal, definition: { osfType: "number", label: label("Stuks"), defaultValue: 1, classification: { sensitivity: "public" } } }) as { state: string; backfill: { id: string; state: string; total: number } };
    expect(widened).toMatchObject({ state: "updating", version: 3, backfill: { state: "queued" } });
    expect(widened.backfill.total).toBeGreaterThan(0);
    expect(await failure(define(manager, "update", { fieldId: fields.aantal, key: "andere" }))).toMatchObject({ code: "CONFLICT" });
    await drainJobs();
    const after = await define(reader, "list") as { items: Array<{ fieldId: string; state: string; backfill?: { state: string; processed: number } }> };
    expect(after.items.find((item) => item.fieldId === fields.aantal)).toMatchObject({ state: "ready", backfill: { state: "done" } });
    expect((await created(writer, { stuks: 2.5 })).extensions.stuks).toBe(2.5);

    expect(await failure(define(manager, "update", { fieldId: fields.aantal, definition: { osfType: "date", classification: { sensitivity: "public" } } })))
      .toMatchObject({ message: expect.stringContaining("not a widening change") });
    expect(await failure(define(manager, "update", { fieldId: fields.sku, definition: { osfType: "string", unique: true, classification: { sensitivity: "internal" },
      options: { type: "static", items: [{ value: "A-1", label: label("A-1") }] } } })))
      .toMatchObject({ message: expect.stringContaining("not among the options") });
    // A value used twice blocks turning unique on, and says which.
    await created(writer, { soort: "kit" }); await created(writer, { soort: "kit" });
    const duplicate = await failure(define(manager, "update", { fieldId: fields.soort, definition: {
      osfType: "string", label: label("Soort"), unique: true, classification: { sensitivity: "public" },
      options: { type: "static", items: [{ value: "batterij", label: label("Batterij") }, { value: "kit", label: label("Kit") }] } } })) as { code: string; detail?: string };
    expect(duplicate).toMatchObject({ code: "CONFLICT" });
    // Without duplicates, unique is switched on by a backfill that claims every value.
    const claimed = await created(writer, { soort: "batterij", accu: 1, stuks: 77 });
    const unique = await define(manager, "update", { fieldId: fields.aantal, definition: { osfType: "number", label: label("Stuks"),
      defaultValue: 1, unique: true, classification: { sensitivity: "public" } } }) as { state: string; backfill?: { state: string } };
    expect(unique).toMatchObject({ state: "updating", backfill: { state: "queued" } });
    await drainJobs();
    expect((await sql`select record_id from erp.tasks_field_unique_values where field_id = ${fields.aantal!}::uuid and value_text = '77'`
      .execute(fixture.privileged.db)).rows).toEqual([{ record_id: claimed.id }]);
    expect(await createTask(writer, { stuks: 77 })).toMatchObject({ error: { code: "CONFLICT" } });
  });

  test("lifecycle: deprecate, restore and delete with a confirmed, resumable, idempotent backfill", async () => {
    const records = [await created(writer, { bsn: "1" }), await created(writer, { bsn: "2" }), await created(writer, { bsn: "3" })];
    expect(await failure(define(manager, "delete", { fieldId: fields.bsn, confirmAffectedRecords: 0 }))).toMatchObject({ message: expect.stringContaining("deprecated") });
    await define(manager, "deprecate", { fieldId: fields.bsn });
    expect(await createTask(writer, { bsn: "4" })).toMatchObject({ error: { violations: [expect.objectContaining({ code: "DEPRECATED_FIELD" })] } });
    expect((await get(writer, records[0]!.id))!.extensions.bsn).toBe("1");
    expect((await get(writer, records[0]!.id))!.extensionsMeta.bsn).toMatchObject({ deprecated: true });
    expect(((await define(reader, "list")) as { items: Array<{ key: string }> }).items.map((item) => item.key)).not.toContain("bsn");
    expect(((await define(reader, "list", { includeDeprecated: true })) as { items: Array<{ key: string }> }).items.map((item) => item.key)).toContain("bsn");
    await define(manager, "restore", { fieldId: fields.bsn });
    await define(manager, "deprecate", { fieldId: fields.bsn });

    const { count } = await define(manager, "affectedRecords", { fieldId: fields.bsn }) as { count: number };
    expect(count).toBeGreaterThanOrEqual(3);
    expect(await failure(define(manager, "delete", { fieldId: fields.bsn, confirmAffectedRecords: count + 1 }))).toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    const { backfillId } = await define(manager, "delete", { fieldId: fields.bsn, confirmAffectedRecords: count }) as { backfillId: string };
    // Hidden from readers at once, though the source still carries the key.
    expect((await get(writer, records[0]!.id))!.extensions.bsn).toBeUndefined();

    // A batch that does not commit leaves nothing behind; the next one resumes.
    await withDbSession(fixture.app.db, manager, async (trx) => {
      await runBackfillBatch(trx, manager, backfillId, 1);
      await sql`select 1/0`.execute(trx);
    }).catch(() => undefined);
    const first = await withDbSession(fixture.worker.db, manager, (trx) => runBackfillBatch(trx, manager, backfillId, 1));
    expect(first).toMatchObject({ state: "running", processed: 1, more: true });
    await drainJobs();
    const state = await sql<{ state: string; processed: number }>`select state, processed from platform.extension_field_backfills where id = ${backfillId}::uuid`.execute(fixture.privileged.db);
    expect(state.rows[0]).toMatchObject({ state: "done", processed: count });
    const remaining = await sql<{ n: string }>`select count(*)::text as n from erp.tasks where extension_values ? ${fields.bsn!}`.execute(fixture.privileged.db);
    expect(remaining.rows[0]!.n).toBe("0");
    expect(await sql`select 1 from erp.tasks_field_values where field_id = ${fields.bsn!}::uuid`.execute(fixture.privileged.db).then((r) => r.rows)).toEqual([]);
    // Idempotent: running it again changes nothing.
    expect(await withDbSession(fixture.worker.db, manager, (trx) => runBackfillBatch(trx, manager, backfillId)))
      .toMatchObject({ state: "done", more: false, processed: count });
    // The key is free again.
    expect(await define(manager, "create", { key: "bsn", definition: { osfType: "string", classification: { sensitivity: "pii" } } })).toMatchObject({ key: "bsn", version: 1 });
  });

  test("retention clears expired values from source and index", async () => {
    const field = await define(manager, "update", { fieldId: fields.sku, definition: { osfType: "string", label: label("SKU"), unique: true,
      classification: { sensitivity: "internal" }, retention: { days: 30, from: "createdAt" } } }) as { fieldId: string };
    const old = await created(writer, { sku: "R-old" });
    const fresh = await created(writer, { sku: "R-new" });
    await sql`update erp.tasks set created_at = now() - interval '40 days' where id = ${old.id}::uuid`.execute(fixture.privileged.db);
    const result = await withDbSession(fixture.worker.db, manager, (trx) => applyExtensionRetention(trx, manager, "Task"));
    expect(result.cleared).toBeGreaterThanOrEqual(1);
    expect((await get(writer, old.id))!.extensions.sku).toBeNull();
    expect((await get(writer, fresh.id))!.extensions.sku).toBe("R-new");
    expect(await indexRows(old.id, field.fieldId)).toEqual([]);
    expect((await sql`select 1 from erp.tasks_field_unique_values where record_id = ${old.id}::uuid`.execute(fixture.privileged.db)).rows).toEqual([]);
  });

  test("MCP: the listed schema and the dispatch agree on this tenant's fields", async () => {
    expect(hasExtensibleEntities()).toBe(true);
    await primeSessionExtensions(fixture.app.db, writer);
    const listTool = catalog.tools.find((tool) => tool.entity === "Task" && tool.operation === "list")!;
    const described = describeTool(listTool, undefined, fixture.table, writer) as unknown as { inputSchema: { properties: Record<string, any> } };
    expect(Object.keys(described.inputSchema.properties.filter.properties.extensions.properties)).toContain("accu");
    expect(described.inputSchema.properties.filter.properties.extensions.properties.bsn).toBeUndefined();
    expect(described.inputSchema.properties.sortField.enum).toContain("extensions.accu");
    expect(described.inputSchema.properties.sortField.enum).not.toContain("extensions.links");
    // Tenant B has no fields: its schema is the static one.
    await primeSessionExtensions(fixture.app.db, writerB);
    const other = describeTool(listTool, undefined, fixture.table, writerB) as unknown as { inputSchema: { properties: Record<string, any> } };
    expect(other.inputSchema.properties.filter.properties.extensions.properties).toEqual({});

    const createTool = { ...listTool, name: "task_create", operation: "create", operationId: "Task.create",
      inputSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, type: { type: "string" }, status: { type: "string" } } } } as typeof listTool;
    const enriched = withExtensionTool(createTool, fixture.table, writer);
    const extensions = (enriched.inputSchema as { properties: Record<string, any> }).properties.extensions;
    expect(extensions.properties.accu).toMatchObject({ type: ["number", "string"] });
    expect(extensions.properties.soort.enum).toEqual(["batterij", "kit"]);
    const tables = new Map([[fixture.table.name, fixture.table]]);
    const args = { title: "MCP", type: "follow_up", status: "open", extensions: { soort: "kit", stuks: 4 } };
    await expect(invokeTool(createTool, undefined, fixture.table, tables, fixture.app.db, writer, args)).rejects.toMatchObject({ code: "BAD_USER_INPUT" });
    const created = await invokeTool(enriched, undefined, fixture.table, tables, fixture.app.db, writer, args) as unknown as { structuredContent?: { data: { extensions: Record<string, unknown> } } };
    expect(created.structuredContent?.data.extensions).toMatchObject({ soort: "kit", stuks: 4 });
    const listed = await invokeTool(withExtensionTool(listTool, fixture.table, writer), undefined, fixture.table, tables, fixture.app.db, writer,
      { filter: { title: "MCP", extensions: { stuks: { eq: 4 } } }, sortField: "extensions.stuks" }) as unknown as { structuredContent?: { data: { items: unknown[] } } };
    expect(listed.structuredContent?.data.items).toHaveLength(1);
  });

  test("GraphQL: the type, inputs and filter carry extensions as JSON, never the source column", () => {
    const sdl = renderTypeDefinition(fixture.table);
    expect(sdl).toMatch(/type Task \{[\s\S]*extensions: JSON[\s\S]*extensionsMeta: JSON/);
    expect(sdl).toMatch(/input TaskFilter \{[\s\S]*extensions: JSON/);
    expect(sdl).toMatch(/input CreateTaskInput \{[\s\S]*extensions: JSON/);
    expect(sdl).toMatch(/input UpdateTaskInput \{[\s\S]*extensions: JSON/);
    expect(sdl).not.toContain("extensionValues");
  });

  test("the synthesized Operations dispatch to the native handler and notify MCP of a change", async () => {
    // The shape packages/compiler/src/extension-operations.ts emits.
    const contract = (action: string, data: "read" | "write" | "delete", roles: string[]): OperationContract => ({
      key: `Task.fieldDefinitions.${action}`, plugin: "osf-extensions", handler: `fieldDefinitions.${action}`, intent: "invoke",
      target: { entityId: "task", entityName: "Task", scope: "collection" },
      title: action, description: action, auth: { mode: "session", roles }, tenancy: { mode: "required" },
      idempotency: { mode: "none" }, effects: { data, external: "none" },
      inputSchema: { type: "object" }, outputSchema: { type: "object" }, errors: [],
      transports: { rest: { method: "POST", path: `/api/tasks/field-definitions/${action}`, response: { kind: "json" } },
        mcp: { enabled: false }, graphql: { enabled: true, kind: data === "read" ? "query" : "mutation" }, typescript: { enabled: false } },
    } as OperationContract);
    const bound = bindOperationHandlers([], [contract("create", "write", [MANAGER_ROLE]), contract("list", "read", [READER_ROLE])], { pluginOperations: "absent" });
    const platform = new ModulePlatformRuntime(fixture.app.db);
    const calls: string[] = [];
    for (const [name, tenant] of [["a", tenantA], ["b", tenantB]] as const) {
      platform.registerServer({
        server: {} as never, session: createModuleSessionCapability(sessionFor(tenant, [READER_ROLE]) as never), liveNotifications: true,
        notifyToolsChanged: async () => { calls.push(name); }, notifyResourcesChanged: async () => undefined,
        authorize: async () => ({ allowed: false, code: "NOT_FOUND" }), resolveInvocationSources: async () => ({ sources: [], unavailable: [] }),
        callTool: async () => ({ result: { content: [] } }),
      } as never);
    }
    const result = await invokeOperation(bound.get("Task.fieldDefinitions.create")!, {
      key: "viaRest", definition: { osfType: "boolean", classification: { sensitivity: "public" } },
    }, { db: fixture.app.db, platform: platform.services, transport: "rest", session: manager as never });
    expect(result).toMatchObject({ value: { key: "viaRest", state: "ready" } });
    await Promise.resolve();
    expect(calls).toEqual(["a"]);
    await expect(invokeOperation(bound.get("Task.fieldDefinitions.create")!, { key: "nope", definition: {} },
      { db: fixture.app.db, platform: platform.services, transport: "rest", session: writer as never })).rejects.toBeDefined();
    expect(() => bindOperationHandlers([], [{ ...contract("create", "read", [MANAGER_ROLE]) }], { pluginOperations: "absent" })).toThrow(/unsupported or incomplete binding/);
  });
});
