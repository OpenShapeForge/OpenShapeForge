// SPDX-License-Identifier: BUSL-1.1
/**
 * Lookups and rollups end to end on a scratch database: the authorization
 * proof when a definition is saved (and again when the contract or a tenant's
 * profiles change), the graph across two entities, the synchronous recompute
 * up to `limits.syncFanOut` (3 in the test composition) and the journal
 * beyond it, the deletion rules of a target and tenant isolation. Every test
 * runs in a tenant of its own, so the field limit (10) holds per test.
 * Functional only: a handful of records, never a load.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import manifest from "../../../../generated/db/manifest.json" with { type: "json" };
import { runMigrationChain } from "../../../../db/migration-chain.js";
import { withDbSession } from "../../../../db/session.js";
import { composeJobHandlers } from "../../../../jobs/handlers.js";
import { processJobBatch, withJobWorkerSession } from "../../../../jobs/worker.js";
import { getGeneratedCrudTables } from "../../catalog.js";
import { executeCollectionMutation } from "../../collection-mutations.js";
import { createGeneratedEntity, updateGeneratedEntity, updateGeneratedEntityForTable } from "../../mutations.js";
import { executeEntityOperation } from "../../runtime.js";
import { EXTENSION_BACKFILL_KIND, extensionBackfillJobHandler } from "../backfill.js";
import { executeFieldDefinitionAction, type FieldDefinitionAction } from "../definitions.js";
import {
  EXTENSION_RECOMPUTE_KIND,
  EXTENSION_REVALIDATE_KIND,
  extensionRecomputeJobHandler,
  extensionRevalidateJobHandler,
  proveExtensionStaleness,
  revalidateLinkedFields,
  revalidateLinkedFieldsOfEveryTenant,
  runRecomputeBatch,
  sweepExtensionRecomputes,
} from "../linked.js";
import { __setExtensionRegistryForTests } from "../registry.js";
import { extensionSnapshot } from "../snapshot.js";
import { createExtensionFixture, ENTITY, MANAGER_ROLE, READER_ROLE, sessionFor, TARGET_ENTITY, WRITER_ROLE, type ExtensionFixture } from "./fixture.js";

const GROUP = "ExtensibleAssetGroup";
const EDITION = "ExtensibleAssetEdition";
let fixture: ExtensionFixture;
const silent = { info() {}, warn() {}, error() {} };
const handlers = composeJobHandlers([{ name: "test-lookups", jobHandlers: {
  [EXTENSION_BACKFILL_KIND]: extensionBackfillJobHandler,
  [EXTENSION_RECOMPUTE_KIND]: extensionRecomputeJobHandler,
  [EXTENSION_REVALIDATE_KIND]: extensionRevalidateJobHandler,
} }]);

type Session = ReturnType<typeof sessionFor>;
type Row = Record<string, unknown> & { id: string; updated_at: string; extensions: Record<string, unknown>; extensionsMeta: Record<string, Record<string, unknown>> };
const label = (text: string) => ({ en: text, nl: text });
const pub = { classification: { sensitivity: "public" } };
const number = (text: string) => ({ osfType: "number", label: label(text), ...pub });
const text = (name: string, extra: Record<string, unknown> = {}) => ({ osfType: "string", label: label(name), ...pub, ...extra });
const reference = (target: string, text: string, extra: Record<string, unknown> = {}) => ({ osfType: target, label: label(text), ...pub, ...extra });
const lookup = (via: string, field: string, text = "Lookup") => ({ label: label(text), ...pub, lookup: { via, field } });
const rollup = (spec: Record<string, unknown>, text = "Rollup") => ({ label: label(text), ...pub, rollup: spec });
const formula = (source: string, name: string) => ({ label: label(name), ...pub, formula: { text: source } });

async function tenant() {
  const id = randomUUID();
  await fixture.addTenants(id);
  return { id, manager: sessionFor(id, [MANAGER_ROLE, WRITER_ROLE, READER_ROLE]), writer: sessionFor(id, [WRITER_ROLE]), reader: sessionFor(id, [READER_ROLE]),
    security: sessionFor(id, ["Organization.Security.Manage"]) };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

const define = (session: Session, action: FieldDefinitionAction, input: Record<string, unknown> = {}, entity = ENTITY) =>
  withDbSession(fixture.app.db, session, (trx) => executeFieldDefinitionAction(trx, session, entity, action, input));
const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) {
    return (error as { operationError?: { code: string; message: string } }).operationError ?? error;
  }
  throw new Error("expected a refusal");
};
async function drainJobs() {
  for (let round = 0; round < 50; round += 1) {
    // The recompute journal debounces; a test does not wait it out.
    await sql`update platform.jobs set available_at = now() where kind = ${EXTENSION_RECOMPUTE_KIND} and status = 'queued'`.execute(fixture.privileged.db);
    const { processed } = await processJobBatch(fixture.worker.db, handlers, silent, { kinds: [EXTENSION_BACKFILL_KIND, EXTENSION_RECOMPUTE_KIND, EXTENSION_REVALIDATE_KIND] });
    if (!processed) return;
  }
}
async function field(t: Tenant, key: string, definition: Record<string, unknown>, kind?: string, entity = ENTITY) {
  const created = await define(t.manager, "create", { key, definition, ...(kind ? { kind } : {}) }, entity) as { fieldId: string };
  await drainJobs();
  return created.fieldId;
}
const listed = async (t: Tenant, key: string, entity = ENTITY) => ((await define(t.manager, "list", { includeDeprecated: true }, entity)) as {
  items: Array<{ fieldId: string; key: string; state: string; definition: Record<string, any>; backfill?: { state: string; error?: { code: string; message: string } } }>;
}).items.find((item) => item.key === key)!;

async function create(session: Session, entity: string, values: Record<string, unknown>): Promise<Row> {
  const result = await executeEntityOperation(fixture.app.db, session, { operation: { id: `${entity}.create`, intent: "create" }, input: { values } });
  if ("error" in result || !result.data) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.data as Row;
}
async function get(session: Session, id: string, entity = ENTITY): Promise<Row> {
  const result = await executeEntityOperation(fixture.app.db, session, { operation: { id: `${entity}.get`, intent: "get" }, input: { id } });
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return result.data as Row;
}
async function update(session: Session, entity: string, id: string, values: Record<string, unknown>) {
  const current = await get(session, id, entity);
  const result = await executeEntityOperation(fixture.app.db, session, { operation: { id: `${entity}.update`, intent: "update" },
    input: { id, values, expectedVersion: String(current.updated_at) } });
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return result.data as Row;
}
const remove = async (session: Session, entity: string, id: string) =>
  executeEntityOperation(fixture.app.db, session, { operation: { id: `${entity}.delete`, intent: "delete" },
    input: { id, confirmed: true, expectedVersion: String((await get(session, id, entity)).updated_at) } });
async function list(session: Session, filter?: Record<string, unknown>) {
  const result = await executeEntityOperation(fixture.app.db, session, { operation: { id: `${ENTITY}.list`, intent: "list" }, input: filter ? { filter } : {} });
  if ("error" in result) return result;
  return (result.data as { items: Array<{ data: Row }> }).items.map((item) => item.data);
}
const privileged = <T>(query: ReturnType<typeof sql<T>>) => query.execute(fixture.privileged.db).then((result) => result.rows);
const journal = (tenantId: string) => privileged(sql<{ field_id: string; target_id: string; generation: number }>`
  select field_id::text as field_id, target_id::text as target_id, generation from platform.extension_field_recomputes
  where tenant_id = ${tenantId}::uuid order by created_at`);
const anyTable = (entity: string) => getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === entity)!;
const tableOf = (entity: string) => getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === entity && !table.subtype)!;
const parts = (session: Session, action: "insert" | "update" | "remove", request: Record<string, unknown>) =>
  executeCollectionMutation(fixture.app.db, session, { entityName: ENTITY, field: "parts", action }, request as never);
/** A write that names no version: concurrent tests must not fail on the optimistic check they are not about. */
const write = (session: Session, entity: string, id: string, { extensions, ...values }: Record<string, unknown>) =>
  updateGeneratedEntity(fixture.app.db, session, { table: anyTable(entity).name, id, values, ...(extensions ? { extensions: extensions as Record<string, unknown> } : {}) });
const jobs = (tenantId: string) => privileged(sql<{ status: string; attempts: number; actor_session: Record<string, unknown>; error: string | null }>`
  select status, attempts, actor_session, last_error::text as error from platform.jobs where tenant_id = ${tenantId}::uuid and kind = ${EXTENSION_RECOMPUTE_KIND} order by sequence`);
/** Fail every write of a table with one SQLSTATE until the returned function is called. */
async function failWrites(table: string, sqlstate: string) {
  const name = `fail_${randomUUID().replaceAll("-", "")}`;
  await sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'injected' using errcode = '${sqlstate}'; end $$`).execute(fixture.privileged.db);
  await sql.raw(`create trigger ${name} before update on ${table} for each row execute function ${name}()`).execute(fixture.privileged.db);
  return async () => {
    await sql.raw(`drop trigger ${name} on ${table}`).execute(fixture.privileged.db);
    await sql.raw(`drop function ${name}()`).execute(fixture.privileged.db);
  };
}
/** Manage one entity's reads under the tenant's profiles, past the ceiling's guard, then write the profile model the way an administrator does. */
async function manage(t: Tenant, entity: string) {
  await fixture.privileged.db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await sql`insert into erp.authorization_operation_policies (tenant_id, operation_id, entity_type, managed)
      values (${t.id}::uuid, ${`${entity}.list`}, ${entity}, true)`.execute(trx);
  });
}
const adminWrite = (t: Tenant) => createGeneratedEntity(fixture.app.db, t.security, { table: tableOf("AuthorizationOperationPolicy").name,
  values: { operationId: "Relation.list", entityType: "Relation", managed: false } });

describe("tenant lookups and rollups", () => {
  beforeAll(async () => {
    fixture = await createExtensionFixture("lookup");
  }, 180_000);
  afterAll(async () => { await fixture?.close(); });

  test("a rollup over an owned collection with the same roles: sum and count follow create, update, delete and a move", async () => {
    const t = await tenant();
    await field(t, "partQuantity", rollup({ collection: "parts", aggregate: "sum", of: "quantity" }, "Quantity"), "rollup");
    await field(t, "partCount", rollup({ collection: "parts", aggregate: "countAll" }, "Parts"), "rollup");
    await field(t, "bigParts", rollup({ collection: "parts", aggregate: "count", of: "quantity",
      where: { kind: "rule", operator: "greaterThan", left: { kind: "path", path: "quantity" }, right: { kind: "literal", value: 2 } } }, "Big parts"), "rollup");
    expect((await listed(t, "partQuantity")).definition).toMatchObject({ osfType: "number", rollup: { collection: "parts", aggregate: "sum", of: "quantity", resultType: "number" } });
    const one = await create(t.writer, ENTITY, { name: "One" });
    const two = await create(t.writer, ENTITY, { name: "Two" });
    expect(one.extensions).toMatchObject({ partQuantity: 0, partCount: 0, bigParts: 0 });

    const first = await parts(t.writer, "insert", { id: one.id, expectedVersion: String((await get(t.reader, one.id)).updated_at), values: { quantity: 2, kind: "cell" } });
    await parts(t.writer, "insert", { id: one.id, expectedVersion: String((await get(t.reader, one.id)).updated_at), values: { quantity: 5, kind: "frame" } });
    expect((await get(t.reader, one.id)).extensions).toMatchObject({ partQuantity: 7, partCount: 2, bigParts: 1 });
    await parts(t.writer, "update", { id: one.id, expectedVersion: String((await get(t.reader, one.id)).updated_at), childId: first.childId, values: { quantity: 3 } });
    expect((await get(t.reader, one.id)).extensions).toMatchObject({ partQuantity: 8, partCount: 2, bigParts: 2 });
    // A move: the old parent and the new one.
    await updateGeneratedEntityForTable(fixture.app.db, t.writer, tableOf("ExtensibleAssetPart"), first.childId, { asset: two.id });
    expect((await get(t.reader, one.id)).extensions).toMatchObject({ partQuantity: 5, partCount: 1 });
    expect((await get(t.reader, two.id)).extensions).toMatchObject({ partQuantity: 3, partCount: 1 });
    await parts(t.writer, "remove", { id: two.id, expectedVersion: String((await get(t.reader, two.id)).updated_at), childId: first.childId });
    expect((await get(t.reader, two.id)).extensions).toMatchObject({ partQuantity: 0, partCount: 0, bigParts: 0 });
    // Filterable as any number.
    const filtered = await list(t.reader, { extensions: { partQuantity: { eq: 5 } } }) as Row[];
    expect(filtered.map((row) => row.id)).toEqual([one.id]);
    // Computed, so never written by a caller.
    expect(await executeEntityOperation(fixture.app.db, t.writer, { operation: { id: `${ENTITY}.update`, intent: "update" },
      input: { id: one.id, values: { extensions: { partCount: 9 } }, expectedVersion: String((await get(t.reader, one.id)).updated_at) } }))
      .toMatchObject({ error: { code: "VALIDATION" } });
  });

  test("a rollup over a collection another role reads is refused, naming the role", async () => {
    const t = await tenant();
    const refused = await failure(define(t.manager, "create", { key: "booked", kind: "rollup", definition: rollup({ collection: "bookings", aggregate: "sum", of: "hours" }) }));
    expect(refused).toMatchObject({ code: "FORBIDDEN" });
    expect((refused as { message: string }).message).toContain("ExtensibleAssetBooking is readable for Test.Bookings.Read, ExtensibleAsset also for General.All.Read, General.All.ReadWrite");
  });

  test("a lookup through a tenant reference to an entity with the same roles follows its target; a classified target field is refused", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place", { onDelete: "restrict" }));
    const placeName = await field(t, "placeName", lookup("extensions.place", "name", "Place name"), "lookup");
    expect((await listed(t, "placeName")).definition).toMatchObject({ osfType: "string", lookup: { via: "extensions.place", field: "name", resultType: "text" } });
    const location = await create(t.writer, TARGET_ENTITY, { name: "Depot" });
    const asset = await create(t.writer, ENTITY, { name: "Asset", extensions: { place: location.id } });
    expect(asset.extensions.placeName).toBe("Depot");
    await update(t.writer, TARGET_ENTITY, location.id, { name: "Warehouse" });
    expect((await get(t.reader, asset.id)).extensions.placeName).toBe("Warehouse");
    const indexed = await privileged(sql<{ value_text: string }>`select value_text from erp.extensible_assets_field_values
      where record_id = ${asset.id}::uuid and field_id = ${placeName}::uuid`);
    expect(indexed).toEqual([{ value_text: "Warehouse" }]);
    // The record's own write: another reference, another value.
    const other = await create(t.writer, TARGET_ENTITY, { name: "Yard" });
    expect((await update(t.writer, ENTITY, asset.id, { extensions: { place: other.id } })).extensions.placeName).toBe("Yard");

    const classified = await failure(define(t.manager, "create", { key: "placeMail", kind: "lookup", definition: lookup("extensions.place", "contactEmail") }));
    expect(classified).toMatchObject({ code: "VALIDATION" });
    expect((classified as { message: string }).message).toContain("classified");
    // The reference a lookup follows cannot go while the lookup reads through it.
    const place = (await listed(t, "place")).fieldId;
    expect(await failure(define(t.manager, "deprecate", { fieldId: place }))).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("placeName") });
  });

  test("a lookup through an authored single relation of another extensible entity", async () => {
    const t = await tenant();
    await field(t, "locationName", lookup("location", "name", "Location name"), "lookup", GROUP);
    const location = await create(t.writer, TARGET_ENTITY, { name: "North" });
    const group = await create(t.writer, GROUP, { name: "G", location: location.id });
    expect(group.extensions.locationName).toBe("North");
    await update(t.writer, TARGET_ENTITY, location.id, { name: "South" });
    expect((await get(t.reader, group.id, GROUP)).extensions.locationName).toBe("South");
  });

  test("an authorization profile that narrows the target refuses the lookup; one switched on later suspends it", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(t.writer, TARGET_ENTITY, { name: "Depot" });
    const asset = await create(t.writer, ENTITY, { name: "Asset", extensions: { place: location.id } });

    // The target's reads come under managed access. The test entity's
    // Operations lie outside the application ceiling a profile may grant, so
    // that row is written directly, past the ceiling's guard trigger; the
    // generic write of the profile model that follows, on an Operation inside
    // the ceiling, is what revalidates (mutations.ts).
    await fixture.privileged.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`insert into erp.authorization_operation_policies (tenant_id, operation_id, entity_type, managed)
        values (${t.id}::uuid, ${`${TARGET_ENTITY}.list`}, ${TARGET_ENTITY}, true)`.execute(trx);
    });
    expect((await listed(t, "placeName")).state).toBe("ready");
    await createGeneratedEntity(fixture.app.db, t.security, { table: tableOf("AuthorizationOperationPolicy").name,
      values: { operationId: "Relation.list", entityType: "Relation", managed: false } });
    const suspended = await listed(t, "placeName");
    expect(suspended.state).toBe("suspended");
    expect(suspended.backfill?.error).toMatchObject({ code: "AUTHORIZATION_PROOF_LOST", message: expect.stringContaining("authorization profile") });
    // Target data a reader may no longer see: null, marked, and no filter. The source keeps it.
    const read = await get(t.reader, asset.id);
    expect(read.extensions.placeName).toBeNull();
    expect(read.extensionsMeta.placeName).toMatchObject({ suspended: true });
    expect((await privileged(sql<{ value: string }>`select extension_values->>${suspended.fieldId} as value from erp.extensible_assets where id = ${asset.id}::uuid`))[0]!.value).toBe("Depot");
    expect(await list(t.reader, { extensions: { placeName: { eq: "Depot" } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });

    // Saving it again while the profile manages the target is refused.
    const refused = await failure(define(t.manager, "update", { fieldId: suspended.fieldId, definition: lookup("extensions.place", "name", "Again") }));
    expect(refused).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("authorization profile") });
    expect(await failure(define(t.manager, "create", { key: "placeTwo", kind: "lookup", definition: lookup("extensions.place", "name") })))
      .toMatchObject({ code: "FORBIDDEN" });
  });

  test("fan-out: up to syncFanOut referring records in the write, beyond it through the journal, stale until the worker ran", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    await field(t, "shout", formula('{Lookup} & "!"', "Shout"), "formula");
    const small = await create(t.writer, TARGET_ENTITY, { name: "Small" });
    const large = await create(t.writer, TARGET_ENTITY, { name: "Large" });
    const few = await Promise.all([1, 2, 3].map((n) => create(t.writer, ENTITY, { name: `few ${n}`, extensions: { place: small.id } })));
    const many = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `many ${n}`, extensions: { place: large.id } })));

    await update(t.writer, TARGET_ENTITY, small.id, { name: "Tiny" });
    for (const row of few) expect((await get(t.reader, row.id)).extensions).toMatchObject({ placeName: "Tiny", shout: "Tiny!" });
    expect(await journal(t.id)).toEqual([]);

    const before = await privileged(sql<{ count: string }>`select count(*)::text as count from platform.entity_events
      where tenant_id = ${t.id}::uuid and event_type = 'updated' and aggregate_id = any(${`{${many.map((row) => row.id).join(",")}}`}::text[])`);
    await update(t.writer, TARGET_ENTITY, large.id, { name: "Huge" });
    expect(await journal(t.id)).toEqual([{ field_id: (await listed(t, "placeName")).fieldId, target_id: large.id, generation: 1 }]);
    const stale = await get(t.reader, many[0]!.id);
    expect(stale.extensions).toMatchObject({ placeName: "Large", shout: "Large!" });
    expect(stale.extensionsMeta.placeName).toMatchObject({ stale: true });
    expect(stale.extensionsMeta.shout).toMatchObject({ stale: true });
    expect((await list(t.reader) as Row[]).filter((row) => row.extensionsMeta.placeName?.stale).map((row) => row.id).sort())
      .toEqual(many.map((row) => row.id).sort());
    expect((await get(t.reader, few[0]!.id)).extensionsMeta.placeName?.stale).toBeUndefined();
    // A snapshot freezes no value the journal has yet to settle.
    const frozen = await withDbSession(fixture.app.db, t.reader, async (trx) => {
      const row = (await sql<{ row: Record<string, unknown> }>`select to_jsonb(a.*) as row from erp.extensible_assets a where id = ${many[0]!.id}::uuid`.execute(trx)).rows[0]!.row;
      return extensionSnapshot(trx, t.reader, ENTITY, row);
    });
    expect(frozen.extensions[(await listed(t, "placeName")).fieldId]).toEqual({ unavailable: "stale" });

    await drainJobs();
    expect(await journal(t.id)).toEqual([]);
    for (const row of many) {
      const read = await get(t.reader, row.id);
      expect(read.extensions).toMatchObject({ placeName: "Huge", shout: "Huge!" });
      expect(read.extensionsMeta.placeName?.stale).toBeUndefined();
    }
    // One realtime `updated` per recomputed record, so a screen refreshes.
    const after = await privileged(sql<{ count: string }>`select count(*)::text as count from platform.entity_events
      where tenant_id = ${t.id}::uuid and event_type = 'updated' and aggregate_id = any(${`{${many.map((row) => row.id).join(",")}}`}::text[])`);
    expect(Number(after[0]!.count) - Number(before[0]!.count)).toBe(4);
  });

  test("coalescing: ten quick writes of one target leave one open journal row", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(t.writer, TARGET_ENTITY, { name: "v0" });
    const assets = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `a${n}`, extensions: { place: location.id } })));
    for (let n = 1; n <= 10; n += 1) await update(t.writer, TARGET_ENTITY, location.id, { name: `v${n}` });
    const open = await journal(t.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.generation).toBe(10);
    const jobs = await privileged(sql<{ count: string }>`select count(*)::text as count from platform.jobs
      where tenant_id = ${t.id}::uuid and kind = ${EXTENSION_RECOMPUTE_KIND} and status = 'queued'`);
    expect(jobs[0]!.count).toBe("1");
    await drainJobs();
    for (const asset of assets) expect((await get(t.reader, asset.id)).extensions.placeName).toBe("v10");
  });

  test("the graph across two entities: a cycle is refused; a chain up to formulaDepth is accepted, deeper is refused", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "lead", reference(ENTITY, "Lead"), undefined, GROUP);
    await field(t, "x", number("X"));
    await field(t, "f1", formula("{X} + 1", "F1"), "formula");
    await field(t, "gl", lookup("extensions.lead", "extensions.f1", "GL"), "lookup", GROUP);
    await field(t, "g2", formula("{GL} + 1", "G2"), "formula", GROUP);
    const al = await field(t, "al", lookup("extensions.group", "extensions.g2", "AL"), "lookup");
    await field(t, "a5", formula("{AL} + 1", "A5"), "formula");
    const deeper = await failure(define(t.manager, "create", { key: "a6", kind: "formula", definition: formula("{A5} + 1", "A6") }));
    expect(deeper).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("the limit is 5") });

    const lead = await create(t.writer, ENTITY, { name: "Lead", extensions: { x: 10 } });
    const group = await create(t.writer, GROUP, { name: "G", extensions: { lead: lead.id } });
    expect(group.extensions).toMatchObject({ gl: 11, g2: 12 });
    const member = await create(t.writer, ENTITY, { name: "Member", extensions: { group: group.id } });
    expect(member.extensions).toMatchObject({ al: 12, a5: 13 });
    // A write at the start of the chain reaches its end, across both entities.
    await update(t.writer, ENTITY, lead.id, { extensions: { x: 20 } });
    expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ gl: 21, g2: 22 });
    expect((await get(t.reader, member.id)).extensions).toMatchObject({ al: 22, a5: 23 });

    // Group.gl reads Asset.f1; pointing f1 at Asset.al would close al → g2 → gl → f1 → al.
    const f1 = (await listed(t, "f1")).fieldId;
    const cycle = await failure(define(t.manager, "update", { fieldId: f1, definition: formula("{AL} + 1", "F1") }));
    expect(cycle).toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/circular reference|limit/) });
    // Taking away what the chain reads is refused with the names, across entities.
    expect(await failure(define(t.manager, "deprecate", { fieldId: f1 }))).toMatchObject({ code: "CONFLICT", message: expect.stringContaining(`${GROUP}.gl`) });
    void al;
  });

  test("a cycle between two entities through lookups alone is refused", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "lead", reference(ENTITY, "Lead"), undefined, GROUP);
    await field(t, "size", number("Size"), undefined, GROUP);
    const a = await field(t, "a", lookup("extensions.group", "extensions.size", "A"), "lookup");
    await field(t, "b", lookup("extensions.lead", "extensions.a", "B"), "lookup", GROUP);
    const refused = await failure(define(t.manager, "update", { fieldId: a, definition: lookup("extensions.group", "extensions.b", "A") }));
    expect(refused).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("circular reference") });
  });

  test("deleting a target: restrict refuses while a lookup reads it; setNull clears the lookup and recomputes the rollups", async () => {
    const t = await tenant();
    await field(t, "kept", reference(TARGET_ENTITY, "Kept", { onDelete: "restrict" }));
    await field(t, "keptName", lookup("extensions.kept", "name", "Kept name"), "lookup");
    const held = await create(t.writer, TARGET_ENTITY, { name: "Held" });
    await create(t.writer, ENTITY, { name: "Holder", extensions: { kept: held.id } });
    expect(await remove(t.writer, TARGET_ENTITY, held.id)).toMatchObject({ error: { code: "OPERATION_REFUSED" } });

    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "loose", reference(TARGET_ENTITY, "Loose", { onDelete: "setNull" }));
    await field(t, "looseName", lookup("extensions.loose", "name", "Loose name"), "lookup");
    await field(t, "placed", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "count", of: "extensions.looseName" }, "Placed"), "rollup", GROUP);
    await field(t, "members", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "countAll" }, "Members"), "rollup", GROUP);
    const group = await create(t.writer, GROUP, { name: "G" });
    const gone = await create(t.writer, TARGET_ENTITY, { name: "Gone" });
    const asset = await create(t.writer, ENTITY, { name: "A", extensions: { group: group.id, loose: gone.id } });
    expect(asset.extensions.looseName).toBe("Gone");
    expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ placed: 1, members: 1 });
    expect(await remove(t.writer, TARGET_ENTITY, gone.id)).not.toHaveProperty("error");
    expect((await get(t.reader, asset.id)).extensions).toMatchObject({ loose: null, looseName: null });
    expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ placed: 0, members: 1 });
    // Moving a member to no group recomputes the old one.
    await update(t.writer, ENTITY, asset.id, { extensions: { group: null } });
    expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ members: 0 });
  });

  test("tenant isolation: another tenant sees none of the definitions, values or journal rows", async () => {
    const a = await tenant();
    const b = await tenant();
    await field(a, "place", reference(TARGET_ENTITY, "Place"));
    await field(a, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(a.writer, TARGET_ENTITY, { name: "Mine" });
    await Promise.all([1, 2, 3, 4].map((n) => create(a.writer, ENTITY, { name: `a${n}`, extensions: { place: location.id } })));
    await update(a.writer, TARGET_ENTITY, location.id, { name: "Ours" });
    expect(await journal(a.id)).toHaveLength(1);
    expect(((await define(b.manager, "list")) as { items: unknown[] }).items).toEqual([]);
    expect(await list(b.reader)).toEqual([]);
    const seen = await withDbSession(fixture.app.db, b.reader, (trx) => sql<{ count: string }>`
      select (select count(*) from platform.extension_field_recomputes)::text as count`.execute(trx));
    expect(seen.rows[0]!.count).toBe("0");
    // A lookup of B cannot point at A's record.
    await field(b, "place", reference(TARGET_ENTITY, "Place"));
    expect(await executeEntityOperation(fixture.app.db, b.writer, { operation: { id: `${ENTITY}.create`, intent: "create" },
      input: { values: { name: "b", extensions: { place: location.id } } } })).toMatchObject({ error: { code: "FORBIDDEN" } });
    await drainJobs();
  });

  test("revalidation after a change of the compiled authorization contract suspends the definition", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    await field(t, "partCount", rollup({ collection: "parts", aggregate: "countAll" }), "rollup");
    const registry = structuredClone((manifest as unknown as { extensionRegistry: Record<string, any> }).extensionRegistry);
    // As if a new manifest gave the target a row scope.
    registry.readAccess[TARGET_ENTITY] = { ...registry.readAccess[TARGET_ENTITY], rowPolicy: "rowScope" };
    const restore = __setExtensionRegistryForTests(registry as never);
    try {
      const suspended = await withDbSession(fixture.app.db, t.manager, (trx) => revalidateLinkedFields(trx, t.manager));
      expect(suspended.map((item) => item.key)).toEqual(["placeName"]);
    } finally {
      restore();
    }
    const suspended = await listed(t, "placeName");
    expect(suspended.state).toBe("suspended");
    expect((await listed(t, "partCount")).state).toBe("ready");
    // Back under the contract, its designer saves it again: proven anew and computed.
    expect(await define(t.manager, "update", { fieldId: suspended.fieldId, definition: lookup("extensions.place", "name", "Again") }))
      .toMatchObject({ state: "updating" });
    await drainJobs();
    expect((await listed(t, "placeName")).state).toBe("ready");
  });

  test("a field's result type does not change under a lookup that reads it", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "size", number("Size"), undefined, GROUP);
    const twice = await field(t, "twice", formula("{Size} * 2", "Twice"), "formula", GROUP);
    await field(t, "groupTwice", lookup("extensions.group", "extensions.twice"), "lookup");
    expect(await failure(define(t.manager, "update", { fieldId: twice, definition: formula('{Size} & ""', "Twice") }, GROUP)))
      .toMatchObject({ code: "CONFLICT", message: expect.stringContaining(`${ENTITY}.groupTwice`) });
  });

  test("text beyond the bounds of a formula is that record's textTooLong, never a failed write of someone else", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "note", text("Note"), undefined, GROUP);
    await field(t, "groupNote", lookup("extensions.group", "extensions.note", "Group note"), "lookup");
    await field(t, "tag", text("Tag"));
    await field(t, "tags", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "arrayUnique", of: "extensions.tag" }, "Tags"), "rollup", GROUP);
    const group = await create(t.writer, GROUP, { name: "G", extensions: { note: "short" } });
    const asset = await create(t.writer, ENTITY, { name: "A", extensions: { group: group.id, tag: "x" } });
    expect(asset.extensions.groupNote).toBe("short");
    expect((await get(t.reader, group.id, GROUP)).extensions.tags).toBe("x");

    // Too many characters, and few enough characters but too many bytes.
    for (const long of ["a".repeat(1_001), "€".repeat(800)]) {
      await write(t.writer, GROUP, group.id, { extensions: { note: long } });
      const read = await get(t.reader, asset.id);
      expect(read.extensions.groupNote).toBeNull();
      expect(read.extensionsMeta.groupNote).toMatchObject({ error: "textTooLong" });
      await write(t.writer, ENTITY, asset.id, { extensions: { tag: long } });
      const parent = await get(t.reader, group.id, GROUP);
      expect(parent.extensions.tags).toBeNull();
      expect(parent.extensionsMeta.tags).toMatchObject({ error: "textTooLong" });
      await write(t.writer, ENTITY, asset.id, { extensions: { tag: "x" } });
      expect((await get(t.reader, group.id, GROUP)).extensions.tags).toBe("x");
    }
    await write(t.writer, GROUP, group.id, { extensions: { note: "short again" } });
    const again = await get(t.reader, asset.id);
    expect(again.extensions.groupNote).toBe("short again");
    expect(again.extensionsMeta.groupNote?.error).toBeUndefined();
  });

  test("a rollup is SQL: conditions, defaults and every aggregate as a reader would count them", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "weight", number("Weight"));
    const group = await create(t.writer, GROUP, { name: "G" });
    // Older than the field below: it holds no value, and reads the default.
    await create(t.writer, ENTITY, { name: "old", extensions: { group: group.id } });
    await field(t, "rated", { osfType: "number", label: label("Rated"), ...pub, defaultValue: 3 });
    await field(t, "tag", text("Tag"));
    await field(t, "due", { osfType: "date", label: label("Due"), ...pub });
    await field(t, "total", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "sum", of: "extensions.weight",
      where: { kind: "group", mode: "any", conditions: [
        { kind: "rule", operator: "equals", left: { kind: "path", path: "extensions.tag" }, right: { kind: "literal", value: "a" } },
        { kind: "rule", operator: "greaterThan", left: { kind: "path", path: "extensions.weight" }, right: { kind: "literal", value: 9 } },
      ] } }, "Total"), "rollup", GROUP);
    await field(t, "mean", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "avg", of: "extensions.rated" }, "Mean"), "rollup", GROUP);
    await field(t, "low", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "min", of: "extensions.weight" }, "Low"), "rollup", GROUP);
    await field(t, "named", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "count", of: "extensions.tag",
      where: { kind: "rule", operator: "notEquals", left: { kind: "path", path: "name" }, right: { kind: "literal", value: "skip" } } }, "Named"), "rollup", GROUP);
    await field(t, "tags", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "arrayUnique", of: "extensions.tag" }, "Tags"), "rollup", GROUP);
    await field(t, "firstDue", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "min", of: "extensions.due" }, "First due"), "rollup", GROUP);
    await field(t, "latest", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "max", of: "createdAt" }, "Latest"), "rollup", GROUP);
    await create(t.writer, ENTITY, { name: "one", extensions: { group: group.id, weight: 1, tag: "a", due: "2026-03-02" } });
    await create(t.writer, ENTITY, { name: "two", extensions: { group: group.id, weight: 2, tag: "b", due: "2026-01-15" } });
    await create(t.writer, ENTITY, { name: "skip", extensions: { group: group.id, weight: 10, tag: "a", rated: 7 } });
    await create(t.writer, ENTITY, { name: "none", extensions: { group: group.id } });
    expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ total: 11, mean: 3.8, low: 1, named: 2, tags: "a, b", firstDue: "2026-01-15",
      latest: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) });

    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ kind: "rule", operator: "contains", left: { kind: "path", path: "extensions.weight" }, right: { kind: "literal", value: "1" } }, "only text contains text"],
      [{ kind: "rule", operator: "greaterThan", left: { kind: "path", path: "extensions.weight" }, right: { kind: "literal", value: "many" } }, "no value of it"],
      [{ kind: "rule", operator: "equals", left: { kind: "path", path: "extensions.group" }, right: { kind: "literal", value: group.id } }, "a rollup reads one"],
    ];
    for (const [where, reason] of refusals) {
      expect(await failure(define(t.manager, "create", { key: "nope", kind: "rollup", definition: rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "countAll", where }) }, GROUP)))
        .toMatchObject({ code: "VALIDATION", message: expect.stringContaining(reason) });
    }
  });

  test("a default under appliesWhen is out of a rollup's reach, when the rollup is saved and when the field changes later", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "kind", { osfType: "string", label: label("Kind"), ...pub, options: { type: "static", items: [{ value: "a", label: label("A") }, { value: "b", label: label("B") }] } });
    const applies = { kind: "rule", operator: "equals", left: { kind: "path", path: "extensions.kind" }, right: { kind: "literal", value: "a" } };
    await define(t.manager, "create", { key: "conditional", definition: { osfType: "number", label: label("Conditional"), ...pub, defaultValue: 2 }, appliesWhen: applies });
    await field(t, "plain", number("Plain"));
    expect(await failure(define(t.manager, "create", { key: "sum", kind: "rollup", definition: rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "sum", of: "extensions.conditional" }) }, GROUP)))
      .toMatchObject({ code: "VALIDATION", message: expect.stringContaining("depends on appliesWhen") });
    await field(t, "sum", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "sum", of: "extensions.plain" }), "rollup", GROUP);
    const plain = (await listed(t, "plain")).fieldId;
    expect(await failure(define(t.manager, "update", { fieldId: plain, definition: { osfType: "number", label: label("Plain"), ...pub, defaultValue: 1 }, appliesWhen: applies })))
      .toMatchObject({ code: "CONFLICT", message: expect.stringContaining(`${GROUP}.sum`) });
  });
});
