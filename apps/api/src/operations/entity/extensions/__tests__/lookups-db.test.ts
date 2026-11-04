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
import { createGeneratedEntity, createGeneratedEntityForTable, updateGeneratedEntity, updateGeneratedEntityForTable } from "../../mutations.js";
import { executeEntityOperation } from "../../runtime.js";
import { EXTENSION_BACKFILL_KIND, extensionBackfillJobHandler } from "../backfill.js";
import { executeFieldDefinitionAction, type FieldDefinitionAction } from "../definitions.js";
import {
  EXTENSION_RECOMPUTE_KIND,
  EXTENSION_REVALIDATE_KIND,
  extensionRecomputeJobHandler,
  extensionRevalidateJobHandler,
  journalRecompute,
  propagateRecordChange,
  proveExtensionStaleness,
  revalidateLinkedFields,
  revalidateLinkedFieldsOfEveryTenant,
  runRecomputeBatch,
  sweepExtensionRecomputes,
} from "../linked.js";
import { __setExtensionRegistryForTests, extensionRegistry } from "../registry.js";
import { extensionSnapshot } from "../snapshot.js";
import { loadExtensionFieldsFor } from "../store.js";
import { createExtensionFixture, ENTITY, MANAGER_ROLE, READER_ROLE, sessionFor, TARGET_ENTITY, WRITER_ROLE, type ExtensionFixture } from "./fixture.js";

const GROUP = "ExtensibleAssetGroup";
const EDITION = "ExtensibleAssetEdition";
const MEMBER = "ExtensibleAssetMember";
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
/** A member of an asset: the record a rollup steps from. */
const member = async (session: Session, values: Record<string, unknown>) => (await createGeneratedEntityForTable(fixture.app.db, session, tableOf(MEMBER), values)) as { id: string };
const editMember = (session: Session, id: string, values: Record<string, unknown>) => updateGeneratedEntityForTable(fixture.app.db, session, tableOf(MEMBER), id, values);
/** An owned child's delete, as the owner's collection Operation runs it. */
const removeMember = (session: Session, id: string) => withDbSession(fixture.app.db, session, async (trx) => {
  const row = await sql<{ row: Record<string, unknown> }>`delete from erp.extensible_asset_members where id = ${id}::uuid returning to_jsonb(extensible_asset_members.*) as row`.execute(trx);
  await propagateRecordChange(trx, session, tableOf(MEMBER), { before: row.rows[0]!.row });
});
const refusal = (t: Tenant, key: string, spec: Record<string, unknown>, entity = ENTITY) =>
  failure(define(t.manager, "create", { key, kind: "rollup", definition: rollup({ collection: "members", ...spec }) }, entity));
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
/** Run with a foreign key as only a handwritten manifest has it: `on delete set null`. */
async function withSetNullKey<T>(table: string, column: string, target: string, run: () => Promise<T>): Promise<T> {
  const [key] = await privileged(sql<{ name: string; definition: string }>`select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
    where contype = 'f' and conrelid = ${table}::regclass and confrelid = ${target}::regclass
      and (select attnum from pg_attribute where attrelid = conrelid and attname = ${column}) = any(conkey)`);
  const alter = (action: string) => sql.raw(`alter table ${table} ${action}`).execute(fixture.privileged.db);
  await alter(`drop constraint "${key!.name}"`);
  await alter(`add constraint "${key!.name}" foreign key (${column}) references ${target} (id) on delete set null`);
  try {
    return await run();
  } finally {
    await alter(`drop constraint "${key!.name}"`);
    // Not valid: other tests of this database leave orphans on purpose.
    await alter(`add constraint "${key!.name}" ${key!.definition} not valid`);
  }
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

  test("four concurrent children under one parent: no deadlock over the rounds, and the rollup counts every one", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "weight", number("Weight"));
    await field(t, "members", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "countAll" }, "Members"), "rollup", GROUP);
    await field(t, "total", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "sum", of: "extensions.weight" }, "Total"), "rollup", GROUP);
    const group = await create(t.writer, GROUP, { name: "G" });
    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.allSettled([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `c${round}.${n}`, extensions: { group: group.id, weight: 2 } })));
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    }
    expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ members: 20, total: 40 });
  }, 60_000);

  test("a parent against its children, in both directions along the graph: no deadlock over the rounds", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "weight", number("Weight"));
    await field(t, "groupName", lookup("extensions.group", "name", "Group name"), "lookup");
    await field(t, "total", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "sum", of: "extensions.weight" }, "Total"), "rollup", GROUP);
    for (let round = 0; round < 6; round += 1) {
      const group = await create(t.writer, GROUP, { name: "before" });
      const one = await create(t.writer, ENTITY, { name: "one", extensions: { group: group.id, weight: 1 } });
      const two = await create(t.writer, ENTITY, { name: "two", extensions: { group: group.id, weight: 1 } });
      const results = await Promise.allSettled([
        write(t.writer, GROUP, group.id, { name: "after" }),
        write(t.writer, ENTITY, one.id, { extensions: { weight: 5 } }),
        write(t.writer, ENTITY, two.id, { extensions: { weight: 5 } }),
        create(t.writer, ENTITY, { name: "three", extensions: { group: group.id, weight: 5 } }),
      ]);
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
      await drainJobs();
      expect((await get(t.reader, group.id, GROUP)).extensions.total).toBe(15);
      expect((await get(t.reader, one.id)).extensions.groupName).toBe("after");
      expect((await get(t.reader, two.id)).extensions.groupName).toBe("after");
    }
  }, 60_000);

  test("a lookup's own write waits for a write of its target, so the value it stores is never the older one", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(t.writer, TARGET_ENTITY, { name: "old" });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const held = new Promise<void>((resolve) => { locked = resolve; });
    const writer = fixture.privileged.db.transaction().execute(async (trx) => {
      await sql`update erp.extensible_asset_locations set name = 'new' where id = ${location.id}::uuid`.execute(trx);
      locked();
      await hold;
    });
    await held;
    const asset = create(t.writer, ENTITY, { name: "A", extensions: { place: location.id } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await writer;
    expect((await asset).extensions.placeName).toBe("new");
  });

  test("a job that fails stays in the journal: a deadlock is a retry, and the row is done once the batch goes through", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(t.writer, TARGET_ENTITY, { name: "before" });
    const assets = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `a${n}`, extensions: { place: location.id } })));
    await update(t.writer, TARGET_ENTITY, location.id, { name: "after" });
    const repair = await failWrites("erp.extensible_assets", "40P01");
    try {
      await sql`update platform.jobs set available_at = now() where tenant_id = ${t.id}::uuid and kind = ${EXTENSION_RECOMPUTE_KIND}`.execute(fixture.privileged.db);
      await processJobBatch(fixture.worker.db, handlers, silent, { kinds: [EXTENSION_RECOMPUTE_KIND] });
    } finally {
      await repair();
    }
    expect(await jobs(t.id)).toMatchObject([{ status: "queued", attempts: 1, error: expect.stringContaining("40P01") }]);
    expect(await journal(t.id)).toHaveLength(1);
    await drainJobs();
    expect(await journal(t.id)).toEqual([]);
    for (const asset of assets) expect((await get(t.reader, asset.id)).extensions.placeName).toBe("after");
  });

  test("a journal row whose job died gets a new one: from the next write of the target, or from the sweep", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(t.writer, TARGET_ENTITY, { name: "v0" });
    const assets = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `a${n}`, extensions: { place: location.id } })));
    await update(t.writer, TARGET_ENTITY, location.id, { name: "v1" });
    const bury = () => sql`update platform.jobs set status = 'dead', completed_at = now() where tenant_id = ${t.id}::uuid and kind = ${EXTENSION_RECOMPUTE_KIND} and status = 'queued'`.execute(fixture.privileged.db);
    await bury();
    expect(await withJobWorkerSession(fixture.worker.db, (trx) => sql`select 1 from platform.extension_field_recomputes`.execute(trx)).then((result) => result.rows.length)).toBeGreaterThan(0);

    await update(t.writer, TARGET_ENTITY, location.id, { name: "v2" });
    expect((await jobs(t.id)).map((job) => job.status)).toEqual(["dead", "queued"]);
    await bury();
    expect(await withJobWorkerSession(fixture.worker.db, sweepExtensionRecomputes)).toBe(1);
    expect((await jobs(t.id)).map((job) => job.status)).toEqual(["dead", "dead", "queued"]);
    // A row with a live job is left alone.
    expect(await withJobWorkerSession(fixture.worker.db, sweepExtensionRecomputes)).toBe(0);
    await drainJobs();
    expect(await journal(t.id)).toEqual([]);
    for (const asset of assets) expect((await get(t.reader, asset.id)).extensions.placeName).toBe("v2");
  });

  test("a job carries the session that asked for it, not a stand-in", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    await field(t, "named", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "count", of: "extensions.placeName" }), "rollup", GROUP);
    const location = await create(t.writer, TARGET_ENTITY, { name: "v0" });
    const groups = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, GROUP, { name: `g${n}` })));
    for (const group of groups) await create(t.writer, ENTITY, { name: "a", extensions: { place: location.id, group: group.id } });
    await sql`update erp.extensible_asset_locations set name = 'v1' where id = ${location.id}::uuid`.execute(fixture.privileged.db);
    await sql`update erp.extensible_assets set extension_values = extension_values - ${(await listed(t, "placeName")).fieldId} where tenant_id = ${t.id}::uuid`.execute(fixture.privileged.db);
    await update({ ...t.writer, credential: "api-key" } as unknown as Session, TARGET_ENTITY, location.id, { name: "v2" });
    expect((await jobs(t.id))[0]!.actor_session).toMatchObject({ credential: "api-key", roles: [WRITER_ROLE] });
    // What the job leaves to the journal in its turn is asked for by the same session.
    await sql`update platform.jobs set available_at = now() where tenant_id = ${t.id}::uuid and kind = ${EXTENSION_RECOMPUTE_KIND}`.execute(fixture.privileged.db);
    await processJobBatch(fixture.worker.db, handlers, silent, { kinds: [EXTENSION_RECOMPUTE_KIND], batchSize: 1 });
    const open = await jobs(t.id);
    expect(open.length).toBeGreaterThan(1);
    for (const job of open) expect(job.actor_session).toMatchObject({ credential: "api-key" });
  });

  test("a pass runs to its end while the target keeps being written, and a new pass settles the latest generation", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    const placeName = await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(t.writer, TARGET_ENTITY, { name: "v0" });
    const assets = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => create(t.writer, ENTITY, { name: `a${n}`, extensions: { place: location.id } })));
    const ordered = assets.map((asset) => asset.id).sort();
    const value = async (id: string) => (await get(t.reader, id)).extensions.placeName;
    const row = async () => (await privileged(sql<{ id: string }>`select id::text as id from platform.extension_field_recomputes
      where tenant_id = ${t.id}::uuid and field_id = ${placeName}::uuid`))[0]!.id;
    const batch = async () => {
      const id = await row();
      return withDbSession(fixture.worker.db, t.writer, (trx) => runRecomputeBatch(trx, t.writer, id, 2));
    };
    await update(t.writer, TARGET_ENTITY, location.id, { name: "v1" });
    expect(await batch()).toMatchObject({ done: false, processed: 2 });
    await update(t.writer, TARGET_ENTITY, location.id, { name: "v2" });
    expect(await batch()).toMatchObject({ done: false, processed: 2 });
    await update(t.writer, TARGET_ENTITY, location.id, { name: "v3" });
    expect(await batch()).toMatchObject({ done: false, processed: 2 });
    // The back of the first pass was reached, though a write came between every batch.
    expect(await value(ordered[5]!)).toBe("v3");
    expect(await value(ordered[0]!)).toBe("v1");
    expect(await batch()).toMatchObject({ done: false, processed: 0 });
    for (let run = 0; run < 3; run += 1) expect(await batch()).toMatchObject({ done: false, processed: 2 });
    expect(await batch()).toMatchObject({ done: true, processed: 0 });
    expect(await journal(t.id)).toEqual([]);
    for (const id of ordered) expect(await value(id)).toBe("v3");
  });

  test("a stale read asks the journal for the targets of its page only", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const mine = await create(t.writer, TARGET_ENTITY, { name: "mine" });
    const other = await create(t.writer, TARGET_ENTITY, { name: "other" });
    const row = await create(t.writer, ENTITY, { name: "on the page", extensions: { place: mine.id } });
    await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `a${n}`, extensions: { place: other.id } })));
    await update(t.writer, TARGET_ENTITY, other.id, { name: "other 2" });
    expect(await journal(t.id)).toHaveLength(1);
    const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    await withDbSession(fixture.app.db, t.reader, async (trx) => {
      const executor = trx.getExecutor();
      const recording = new Proxy(executor, { get(target, name, receiver) {
        if (name === "executeQuery") return (query: { sql: string; parameters: readonly unknown[] }) => { statements.push(query); return (target.executeQuery as (query: unknown) => unknown)(query); };
        const value = Reflect.get(target, name, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const spying = new Proxy(trx, { get(target, name) { return name === "getExecutor" ? () => recording : Reflect.get(target, name); } }) as unknown as Transaction<never>;
      const { loadExtensionFieldsFor } = await import("../store.js");
      const { extensionRegistry } = await import("../registry.js");
      const fields = await loadExtensionFieldsFor(trx, t.reader, ENTITY, extensionRegistry.entity(ENTITY)!);
      const stored = (await sql<{ row: Record<string, unknown> }>`select to_jsonb(a.*) as row from erp.extensible_assets a where id = ${row.id}::uuid`.execute(trx)).rows[0]!.row;
      await proveExtensionStaleness(spying as never, t.reader, fields, [stored]);
    });
    const read = statements.find((statement) => statement.sql.includes("extension_field_recomputes"))!;
    expect(read.sql).toContain("target_id = any");
    expect(JSON.stringify(read.parameters)).toContain(mine.id);
    expect(JSON.stringify(read.parameters)).not.toContain(other.id);
  });

  test("a source under a profile: refused when saved, suspended when it comes later, and redacted for its readers", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await manage(t, ENTITY);
    expect(await failure(define(t.manager, "create", { key: "placeName", kind: "lookup", definition: lookup("extensions.place", "name") })))
      .toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(`manages the reads of ${ENTITY}`) });

    const later = await tenant();
    await field(later, "place", reference(TARGET_ENTITY, "Place"));
    await field(later, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(later.writer, TARGET_ENTITY, { name: "Depot" });
    const asset = await create(later.writer, ENTITY, { name: "A", extensions: { place: location.id } });
    await manage(later, ENTITY);
    await adminWrite(later);
    expect((await listed(later, "placeName")).state).toBe("suspended");
    expect((await listed(later, "placeName")).backfill?.error).toMatchObject({ code: "AUTHORIZATION_PROOF_LOST" });
    const read = await withDbSession(fixture.privileged.db, later.reader, async (trx) => {
      const { loadExtensionFieldsFor } = await import("../store.js");
      const { extensionRegistry } = await import("../registry.js");
      const { projectExtensionRow } = await import("../read.js");
      await loadExtensionFieldsFor(trx, later.reader, ENTITY, extensionRegistry.entity(ENTITY)!);
      const stored = (await sql<{ row: Record<string, unknown> }>`select to_jsonb(a.*) as row from erp.extensible_assets a where id = ${asset.id}::uuid`.execute(trx)).rows[0]!.row;
      return projectExtensionRow(tableOf(ENTITY), later.reader, stored as never) as Row;
    });
    expect(read.extensions.placeName).toBeNull();
    expect(read.extensionsMeta.placeName).toMatchObject({ suspended: true });
  });

  test("a record the writer's row policies hide still follows a write of its target", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    const placeName = await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(t.writer, TARGET_ENTITY, { name: "before" });
    const asset = await create(t.writer, ENTITY, { name: "hidden", extensions: { place: location.id } });
    await sql`create policy hidden_from_writers on erp.extensible_assets as restrictive for all using (app.bypass_rls() or name <> 'hidden')`.execute(fixture.privileged.db);
    try {
      await update(t.writer, TARGET_ENTITY, location.id, { name: "after" });
    } finally {
      await sql`drop policy hidden_from_writers on erp.extensible_assets`.execute(fixture.privileged.db);
    }
    expect((await get(t.reader, asset.id)).extensions.placeName).toBe("after");
    expect(await privileged(sql<{ value_text: string }>`select value_text from erp.extensible_assets_field_values
      where record_id = ${asset.id}::uuid and field_id = ${placeName}::uuid`)).toEqual([{ value_text: "after" }]);
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

  test("a recompute from another record leaves a published head published; its own write puts it back to draft", async () => {
    const t = await tenant();
    await field(t, "locationName", lookup("location", "name", "Location name"), "lookup", EDITION);
    await field(t, "edition", reference(EDITION, "Edition"));
    await field(t, "assets", rollup({ collection: `${ENTITY}.extensions.edition`, aggregate: "countAll" }, "Assets"), "rollup", EDITION);
    const location = await create(t.writer, TARGET_ENTITY, { name: "North" });
    const edition = await create(t.writer, EDITION, { name: "E", location: location.id });
    const status = async () => (await privileged(sql<{ lifecycle_status: string }>`select lifecycle_status from erp.extensible_asset_editions where id = ${edition.id}::uuid`))[0]!.lifecycle_status;
    const publish = () => sql`update erp.extensible_asset_editions set lifecycle_status = 'published' where id = ${edition.id}::uuid`.execute(fixture.privileged.db);
    await publish();
    await update(t.writer, TARGET_ENTITY, location.id, { name: "South" });
    expect((await get(t.reader, edition.id, EDITION)).extensions.locationName).toBe("South");
    expect(await status()).toBe("published");
    await create(t.writer, ENTITY, { name: "A", extensions: { edition: edition.id } });
    expect((await get(t.reader, edition.id, EDITION)).extensions.assets).toBe(1);
    expect(await status()).toBe("published");
    await write(t.writer, EDITION, edition.id, { name: "E2" });
    expect(await status()).toBe("draft");
  });

  test("a classified or field-policed relation carries no lookup and no rollup, and the worker cannot read it", async () => {
    const t = await tenant();
    for (const [via, entity] of [["confidentialLocation", GROUP], ["restrictedLocation", EDITION]] as const) {
      const refused = await failure(define(t.manager, "create", { key: "behind", kind: "lookup", definition: lookup(via, "name") }, entity));
      expect(refused).toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/classified|field policy/) });
    }
    for (const collection of ["auditedParts", "restrictedParts"]) {
      const refused = await failure(define(t.manager, "create", { key: `r${collection.length}`, kind: "rollup", definition: rollup({ collection, aggregate: "countAll" }) }));
      expect(refused).toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/classified|field policy/) });
    }
    const worker = async (table: string, column: string) => (await privileged(sql<{ held: boolean }>`select has_column_privilege('openshapeforge_worker', ${table}, ${column}, 'select') as held`))[0]!.held;
    expect(await worker("erp.extensible_asset_groups", "location_id")).toBe(true);
    expect(await worker("erp.extensible_asset_groups", "confidential_location_id")).toBe(false);
    expect(await worker("erp.extensible_asset_editions", "restricted_location_id")).toBe(false);
    expect(await worker("erp.extensible_asset_parts", "audited_asset_id")).toBe(false);
  });

  test("a lost proof suspends the whole graph: formulas and readers on other entities turn null, no filter, no snapshot value", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name", "Place name"), "lookup");
    await field(t, "shout", formula('{Place name} & "!"', "Shout"), "formula");
    await field(t, "lead", reference(ENTITY, "Lead"), undefined, GROUP);
    await field(t, "leadShout", lookup("extensions.lead", "extensions.shout", "Lead shout"), "lookup", GROUP);
    const location = await create(t.writer, TARGET_ENTITY, { name: "Depot" });
    const asset = await create(t.writer, ENTITY, { name: "A", extensions: { place: location.id } });
    const group = await create(t.writer, GROUP, { name: "G", extensions: { lead: asset.id } });
    expect(group.extensions.leadShout).toBe("Depot!");

    await manage(t, TARGET_ENTITY);
    await adminWrite(t);
    for (const [key, entity] of [["placeName", ENTITY], ["shout", ENTITY], ["leadShout", GROUP]] as const) {
      const item = await listed(t, key, entity);
      expect(item.state).toBe("suspended");
      expect(item.backfill?.error).toMatchObject({ code: "AUTHORIZATION_PROOF_LOST" });
    }
    const read = await get(t.reader, asset.id);
    expect(read.extensions).toMatchObject({ placeName: null, shout: null });
    expect(read.extensionsMeta.shout).toMatchObject({ suspended: true });
    expect((await get(t.reader, group.id, GROUP)).extensions.leadShout).toBeNull();
    expect(await list(t.reader, { extensions: { shout: { eq: "Depot!" } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    const frozen = await withDbSession(fixture.app.db, t.reader, async (trx) => {
      const row = (await sql<{ row: Record<string, unknown> }>`select to_jsonb(a.*) as row from erp.extensible_assets a where id = ${asset.id}::uuid`.execute(trx)).rows[0]!.row;
      return extensionSnapshot(trx, t.reader, ENTITY, row);
    });
    expect(frozen.extensions[(await listed(t, "shout")).fieldId]).toEqual({ unavailable: "suspended" });
    // A formula over it cannot be saved to read what the lost proof hides, and rebuildIndex is no way back.
    expect(await failure(define(t.manager, "create", { key: "again", kind: "formula", definition: formula('{Place name} & "?"', "Again") })))
      .toMatchObject({ code: "FORBIDDEN" });
    expect(await failure(define(t.manager, "rebuildIndex", { fieldId: (await listed(t, "shout")).fieldId }))).toMatchObject({ code: "CONFLICT" });
    // The source keeps the value, for when it is saved again.
    expect((await privileged(sql<{ value: string }>`select extension_values->>${(await listed(t, "placeName")).fieldId} as value from erp.extensible_assets where id = ${asset.id}::uuid`))[0]!.value).toBe("Depot");
  });

  test("another reason to suspend keeps the last value, along the graph as well", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "size", number("Size"), undefined, GROUP);
    const twice = await field(t, "twice", formula("{Size} * 2", "Twice"), "formula", GROUP);
    await field(t, "groupTwice", lookup("extensions.group", "extensions.twice", "Group twice"), "lookup");
    const group = await create(t.writer, GROUP, { name: "G", extensions: { size: 4 } });
    const asset = await create(t.writer, ENTITY, { name: "A", extensions: { group: group.id } });
    await sql`update platform.extension_field_definitions set state = 'suspended', suspended_reason = 'FORMULA_BACKFILL_FAILED'
      where tenant_id = ${t.id}::uuid and field_id = ${twice}::uuid and is_current`.execute(fixture.privileged.db);
    await withDbSession(fixture.app.db, t.manager, (trx) => revalidateLinkedFields(trx, t.manager));
    const reader = await listed(t, "groupTwice");
    expect(reader.state).toBe("suspended");
    expect(reader.backfill?.error).toMatchObject({ code: "DEPENDENCY_SUSPENDED" });
    const read = await get(t.reader, asset.id);
    expect(read.extensions.groupTwice).toBe(8);
    expect(read.extensionsMeta.groupTwice).toMatchObject({ suspended: true });
    expect((await get(t.reader, group.id, GROUP)).extensions.twice).toBe(8);
  });

  test("one budget per write along the whole chain: a lookup's records, then the parents of their rollups through the journal", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "placeName", lookup("extensions.place", "name", "Place name"), "lookup");
    await field(t, "names", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "arrayUnique", of: "extensions.placeName" }, "Names"), "rollup", GROUP);
    const location = await create(t.writer, TARGET_ENTITY, { name: "Old" });
    const groups = await Promise.all([1, 2, 3].map((n) => create(t.writer, GROUP, { name: `g${n}` })));
    const assets = [];
    for (const group of groups) assets.push(await create(t.writer, ENTITY, { name: "A", extensions: { place: location.id, group: group.id } }));
    await update(t.writer, TARGET_ENTITY, location.id, { name: "New" });
    // Three records in the transaction, which is the whole budget; the rest waits in the journal.
    for (const asset of assets) expect((await get(t.reader, asset.id)).extensions.placeName).toBe("New");
    const open = await journal(t.id);
    expect(open.map((row) => row.target_id).sort()).toEqual(groups.map((group) => group.id).sort());
    const stale = await get(t.reader, groups[0]!.id, GROUP);
    expect(stale.extensions.names).toBe("Old");
    expect(stale.extensionsMeta.names).toMatchObject({ stale: true });
    await drainJobs();
    expect(await journal(t.id)).toEqual([]);
    for (const group of groups) expect((await get(t.reader, group.id, GROUP)).extensions.names).toBe("New");
  });

  test("a delete has the same budget: setNull beyond it goes through the journal, stale until the worker ran", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place", { onDelete: "setNull" }));
    await field(t, "placeName", lookup("extensions.place", "name", "Place name"), "lookup");
    const location = await create(t.writer, TARGET_ENTITY, { name: "Gone" });
    const assets = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `a${n}`, extensions: { place: location.id } })));
    expect(await remove(t.writer, TARGET_ENTITY, location.id)).not.toHaveProperty("error");
    expect(await journal(t.id)).toHaveLength(1);
    expect((await get(t.reader, assets[0]!.id)).extensionsMeta.placeName).toMatchObject({ stale: true });
    await drainJobs();
    expect(await journal(t.id)).toEqual([]);
    for (const asset of assets) expect((await get(t.reader, asset.id)).extensions).toMatchObject({ place: null, placeName: null });
  });

  test("a delete of a target over an authored relation beyond the budget: the journal finds its records by the empty reference", async () => {
    const t = await tenant();
    await field(t, "locationName", lookup("location", "name", "Location name"), "lookup", GROUP);
    const location = await create(t.writer, TARGET_ENTITY, { name: "Gone" });
    const groups = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, GROUP, { name: `g${n}`, location: location.id })));
    await sql`alter table erp.extensible_asset_groups drop constraint if exists extensible_asset_groups_location_id_fkey`.execute(fixture.privileged.db);
    const removed = await remove(t.writer, TARGET_ENTITY, location.id);
    if ("error" in removed) throw new Error(JSON.stringify(removed));
    expect(await journal(t.id)).toHaveLength(1);
    await sql`update erp.extensible_asset_groups set location_id = null where tenant_id = ${t.id}::uuid`.execute(fixture.privileged.db);
    await drainJobs();
    expect(await journal(t.id)).toEqual([]);
    for (const group of groups) expect((await get(t.reader, group.id, GROUP)).extensions.locationName).toBeNull();
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

  test("a change of what a field means for every record reaches its readers on other entities", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    const size = await field(t, "size", number("Size"), undefined, GROUP);
    const twice = await field(t, "twice", formula("{Size} * 2", "Twice"), "formula", GROUP);
    await field(t, "groupSize", lookup("extensions.group", "extensions.size", "Group size"), "lookup");
    await field(t, "groupTwice", lookup("extensions.group", "extensions.twice", "Group twice"), "lookup");
    const group = await create(t.writer, GROUP, { name: "G", extensions: { size: null } });
    const assets = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `a${n}`, extensions: { group: group.id } })));
    expect(assets[0]!.extensions.groupSize).toBeNull();
    await sql`update erp.extensible_asset_groups set extension_values = extension_values - ${size} where id = ${group.id}::uuid`.execute(fixture.privileged.db);
    await define(t.manager, "update", { fieldId: size, definition: { osfType: "number", label: label("Size"), ...pub, defaultValue: 7 } }, GROUP);
    await drainJobs();
    for (const asset of assets) expect((await get(t.reader, asset.id)).extensions).toMatchObject({ groupSize: 7, groupTwice: 14 });
    await define(t.manager, "update", { fieldId: twice, definition: formula("{Size} * 3", "Twice") }, GROUP);
    await drainJobs();
    for (const asset of assets) expect((await get(t.reader, asset.id)).extensions.groupTwice).toBe(21);
  });

  test("a formula retyped along a change cannot sit under a lookup: the change is refused, naming the lookup", async () => {
    const t = await tenant();
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "size", number("Size"), undefined, GROUP);
    const base = await field(t, "base", formula("{Size} * 2", "Base"), "formula", GROUP);
    await field(t, "same", formula("{Base}", "Same"), "formula", GROUP);
    await field(t, "groupSame", lookup("extensions.group", "extensions.same", "Group same"), "lookup");
    expect(await failure(define(t.manager, "update", { fieldId: base, definition: formula('{Size} & ""', "Base") }, GROUP)))
      .toMatchObject({ code: "CONFLICT", message: expect.stringContaining(`${ENTITY}.groupSame`) });
    expect((await listed(t, "base", GROUP)).definition.formula.resultType).toBe("number");
  });

  test("a tenant that cannot be proven is suspended, fail closed; the chain goes on and reports it", async () => {
    const broken = await tenant();
    const healthy = await tenant();
    for (const t of [broken, healthy]) {
      await field(t, "place", reference(TARGET_ENTITY, "Place"));
      await field(t, "placeName", lookup("extensions.place", "name", "Place name"), "lookup");
      await field(t, "shout", formula('{Place name} & "!"', "Shout"), "formula");
    }
    let failed = false;
    const report = await revalidateLinkedFieldsOfEveryTenant((tenantId, work) => fixture.privileged.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.bypass_rls', 'true', true)`.execute(trx);
      if (tenantId === broken.id && !failed) { failed = true; throw new Error("injected"); }
      return work(trx);
    }), [broken.id, healthy.id]);
    expect(report).toEqual({ suspended: 2, failedTenants: [broken.id] });
    expect((await listed(broken, "placeName")).state).toBe("suspended");
    expect((await listed(broken, "placeName")).backfill?.error).toMatchObject({ code: "AUTHORIZATION_PROOF_LOST" });
    expect((await listed(broken, "shout")).state).toBe("suspended");
    expect((await listed(healthy, "placeName")).state).toBe("ready");
    const fieldId = (await listed(broken, "placeName")).fieldId;
    expect(await privileged(sql<{ aggregate_type: string }>`select aggregate_type from platform.entity_events
      where tenant_id = ${broken.id}::uuid and aggregate_id = ${fieldId} and event_type = 'updated'
      order by sequence desc limit 1`)).toEqual([{ aggregate_type: `${ENTITY}FieldDefinition` }]);
  });

  test("what a migration suspends is in its result and in an event of the field definition", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    const placeName = await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const registry = structuredClone((manifest as unknown as { extensionRegistry: Record<string, any> }).extensionRegistry);
    registry.readAccess[TARGET_ENTITY] = { ...registry.readAccess[TARGET_ENTITY], rowPolicy: "rowScope" };
    const events = () => privileged(sql<{ count: string }>`select count(*)::text as count from platform.entity_events
      where tenant_id = ${t.id}::uuid and aggregate_type = ${`${ENTITY}FieldDefinition`} and aggregate_id = ${placeName}`).then((rows) => Number(rows[0]!.count));
    const before = await events();
    const restore = __setExtensionRegistryForTests(registry as never);
    try {
      const result = await fixture.privileged.db.connection().execute((connection) => runMigrationChain(connection));
      expect(result.linkedFieldsSuspended).toBeGreaterThanOrEqual(1);
      expect(result.linkedFieldsFailedTenants).toEqual([]);
    } finally {
      restore();
      // The chain granted the worker what that contract let it reach; the tests after this one run under the real one.
      await fixture.privileged.db.connection().execute((connection) => runMigrationChain(connection));
    }
    expect(await events()).toBeGreaterThan(before);
    expect((await listed(t, "placeName")).state).toBe("suspended");
  }, 120_000);

  test("direct SQL on the authorization model reaches the proof: a trigger places the revalidation", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    await fixture.privileged.db.transaction().execute(async (trx) => {
      await sql`alter table erp.authorization_operation_policies disable trigger authorization_content_guard`.execute(trx);
      await sql`insert into erp.authorization_operation_policies (tenant_id, operation_id, entity_type, managed)
        values (${t.id}::uuid, ${`${TARGET_ENTITY}.list`}, ${TARGET_ENTITY}, true)`.execute(trx);
      await sql`alter table erp.authorization_operation_policies enable trigger authorization_content_guard`.execute(trx);
    });
    expect((await listed(t, "placeName")).state).toBe("ready");
    expect(await privileged(sql<{ count: string }>`select count(*)::text as count from platform.jobs
      where tenant_id = ${t.id}::uuid and kind = ${EXTENSION_REVALIDATE_KIND} and status = 'queued'`)).toEqual([{ count: "1" }]);
    await drainJobs();
    const item = await listed(t, "placeName");
    expect(item.state).toBe("suspended");
    expect(item.backfill?.error).toMatchObject({ code: "AUTHORIZATION_PROOF_LOST" });
    expect(await privileged(sql<{ status: string }>`select status from platform.jobs where tenant_id = ${t.id}::uuid and kind = ${EXTENSION_REVALIDATE_KIND}`))
      .toEqual([{ status: "done" }]);
  });

  test("a write of the authorization model takes the graph lock before it looks for lookups, so none is saved past it", async () => {
    const t = await tenant();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const held = new Promise<void>((resolve) => { locked = resolve; });
    const designer = fixture.privileged.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`osf-extensions-graph:${t.id}`}, 0))`.execute(trx);
      locked();
      await hold;
    });
    await held;
    let written = false;
    const write = adminWrite(t).then(() => { written = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(written).toBe(false);
    release();
    await designer;
    await write;
    expect(written).toBe(true);
  });

  test("a write through a subtype is a write of its base, and a managed subtype is a managed base", async () => {
    const t = await tenant();
    const roles = ["Relations.RelationGroups.ReadWrite", "Relations.All.Read"];
    const registry = structuredClone((manifest as unknown as { extensionRegistry: Record<string, any> }).extensionRegistry);
    registry.readAccess[ENTITY] = { ...registry.readAccess[ENTITY], roles: ["Relations.All.Read"] };
    const restore = __setExtensionRegistryForTests(registry as never);
    try {
      await field(t, "team", reference("RelationGroup", "Team"));
      await field(t, "teamName", lookup("extensions.team", "name", "Team name"), "lookup");
      const writer = sessionFor(t.id, [...roles, WRITER_ROLE]);
      const team = await create(writer, "Team", { name: "Blue" });
      const asset = await create(writer, ENTITY, { name: "A", extensions: { team: team.id } });
      expect(asset.extensions.teamName).toBe("Blue");
      await write(writer, "Team", team.id, { name: "Red" });
      expect((await get(t.reader, asset.id)).extensions.teamName).toBe("Red");

      await manage(t, "Team");
      await adminWrite(t);
      expect((await listed(t, "teamName")).state).toBe("suspended");
    } finally {
      restore();
    }
  });

  test("rebuildIndex is the way back from a write behind the runtime: it computes lookups again and settles their journal", async () => {
    const t = await tenant();
    await field(t, "place", reference(TARGET_ENTITY, "Place"));
    const placeName = await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
    const location = await create(t.writer, TARGET_ENTITY, { name: "Stored" });
    const assets = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `a${n}`, extensions: { place: location.id } })));
    await update(t.writer, TARGET_ENTITY, location.id, { name: "Journaled" });
    expect(await journal(t.id)).toHaveLength(1);
    await sql`update erp.extensible_asset_locations set name = 'Raw' where id = ${location.id}::uuid`.execute(fixture.privileged.db);
    await define(t.manager, "rebuildIndex", { fieldId: placeName });
    expect(await journal(t.id)).toEqual([]);
    await drainJobs();
    for (const asset of assets) expect((await get(t.reader, asset.id)).extensions.placeName).toBe("Raw");
    expect(await privileged(sql<{ value_text: string }>`select value_text from erp.extensible_assets_field_values
      where record_id = ${assets[0]!.id}::uuid and field_id = ${placeName}::uuid`)).toEqual([{ value_text: "Raw" }]);
  });

  test("a deadlock in a formula backfill is a retry, not a suspended field", async () => {
    const t = await tenant();
    await create(t.writer, ENTITY, { name: "A" });
    await field(t, "size", number("Size"));
    const created = await define(t.manager, "create", { key: "twice", kind: "formula", definition: formula("{Size} * 2", "Twice") }) as { fieldId: string };
    const repair = await failWrites("erp.extensible_assets", "40P01");
    try {
      await processJobBatch(fixture.worker.db, handlers, silent, { kinds: [EXTENSION_BACKFILL_KIND] });
    } finally {
      await repair();
    }
    expect((await listed(t, "twice")).state).toBe("updating");
    expect(await privileged(sql<{ status: string }>`select status from platform.jobs where tenant_id = ${t.id}::uuid and kind = ${EXTENSION_BACKFILL_KIND} order by sequence desc limit 1`))
      .toEqual([{ status: "queued" }]);
    await sql`update platform.jobs set available_at = now() where tenant_id = ${t.id}::uuid`.execute(fixture.privileged.db);
    await drainJobs();
    expect((await listed(t, "twice")).state).toBe("ready");
    void created;
  });
  describe("a rollup whose `of` follows one relation of the child", () => {
    /** One asset of three members, with what a test needs of them. */
    async function bundle(t: Tenant, capacities: Array<number | null>) {
      const asset = await create(t.writer, ENTITY, { name: "Bundle" });
      const locations = await Promise.all(capacities.map((capacity, n) => create(t.writer, TARGET_ENTITY, { name: `L${n}`, ...(capacity === null ? {} : { capacity }) })));
      const members = [];
      for (const location of locations) members.push(await member(t.writer, { asset: asset.id, location: location.id }));
      return { asset, locations, members };
    }

    test("every aggregate over the members reads the target's column; a member without a target counts as a record, without a value", async () => {
      const t = await tenant();
      const specs = { total: "sum", largest: "max", smallest: "min", mean: "avg", counted: "count" } as const;
      for (const [key, aggregate] of Object.entries(specs)) await field(t, key, rollup({ collection: "members", aggregate, of: "location.capacity" }, key), "rollup");
      await field(t, "memberCount", rollup({ collection: "members", aggregate: "countAll" }, "Members"), "rollup");
      await field(t, "places", rollup({ collection: "members", aggregate: "arrayUnique", of: "location.name" }, "Places"), "rollup");
      const stored = await listed(t, "total");
      expect(stored.definition).toMatchObject({ osfType: "number", rollup: { collection: "members", aggregate: "sum", of: "location.capacity", resultType: "number" } });

      const empty = await create(t.writer, ENTITY, { name: "Empty" });
      expect(empty.extensions).toMatchObject({ total: 0, counted: 0, memberCount: 0 });
      expect(empty.extensions.mean ?? null).toBeNull();

      const { asset } = await bundle(t, [10, 2, 6, null]);
      await member(t.writer, { asset: asset.id });
      expect((await get(t.reader, asset.id)).extensions).toMatchObject({ total: 18, largest: 10, smallest: 2, mean: 6, counted: 3, memberCount: 5, places: "L0, L1, L2, L3" });
      const filtered = await list(t.reader, { extensions: { total: { eq: 18 } } }) as Row[];
      expect(filtered.map((row) => row.id)).toEqual([asset.id]);
      // A condition still reads the member's own fields.
      await field(t, "big", rollup({ collection: "members", aggregate: "sum", of: "location.capacity",
        where: { kind: "rule", operator: "greaterThan", left: { kind: "path", path: "quantity" }, right: { kind: "literal", value: 1 } } }, "Big"), "rollup");
      expect((await get(t.reader, asset.id)).extensions.big).toBe(0);
    });

    test("a write of the target reaches the parents through the child; a move, a delete and a new foreign key of the child reach them as well", async () => {
      const t = await tenant();
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      const { asset, locations, members } = await bundle(t, [10, 2]);
      const other = await create(t.writer, ENTITY, { name: "Other" });
      const third = await create(t.writer, TARGET_ENTITY, { name: "Third", capacity: 100 });
      expect((await get(t.reader, asset.id)).extensions.total).toBe(12);

      await update(t.writer, TARGET_ENTITY, locations[0]!.id, { capacity: 20 });
      expect((await get(t.reader, asset.id)).extensions.total).toBe(22);
      // What the rollup does not read recomputes nothing.
      const before = (await get(t.reader, asset.id)).updated_at;
      await update(t.writer, TARGET_ENTITY, locations[0]!.id, { name: "Renamed" });
      expect((await get(t.reader, asset.id)).updated_at).toBe(before);

      await editMember(t.writer, members[0]!.id, { location: third.id });
      expect((await get(t.reader, asset.id)).extensions.total).toBe(102);
      // The old target is no longer read, the new one is.
      await update(t.writer, TARGET_ENTITY, locations[0]!.id, { capacity: 1000 });
      expect((await get(t.reader, asset.id)).extensions.total).toBe(102);
      await update(t.writer, TARGET_ENTITY, third.id, { capacity: 50 });
      expect((await get(t.reader, asset.id)).extensions.total).toBe(52);

      await editMember(t.writer, members[0]!.id, { asset: other.id });
      expect((await get(t.reader, asset.id)).extensions.total).toBe(2);
      expect((await get(t.reader, other.id)).extensions.total).toBe(50);

      await editMember(t.writer, members[1]!.id, { location: null });
      expect((await get(t.reader, asset.id)).extensions.total).toBe(0);

      await removeMember(t.writer, members[0]!.id);
      expect((await get(t.reader, other.id)).extensions.total).toBe(0);
    });

    test("a tenant field of the target, through an authored relation", async () => {
      const t = await tenant();
      await field(t, "kwh", number("Kwh"), undefined, GROUP);
      await field(t, "doubled", formula("{Kwh} * 2", "Doubled"), "formula", GROUP);
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "group.extensions.kwh" }, "Total"), "rollup");
      await field(t, "totalDoubled", rollup({ collection: "members", aggregate: "max", of: "group.extensions.doubled" }, "Most"), "rollup");
      expect((await listed(t, "total")).definition.rollup.of).toBe("group.extensions.kwh");
      const stored = await privileged(sql<{ of: string }>`select definition->'rollup'->>'of' as of from platform.extension_field_definitions
        where tenant_id = ${t.id}::uuid and key = 'total' and is_current`);
      expect(stored[0]!.of).toBe(`group.extensions.${(await listed(t, "kwh", GROUP)).fieldId}`);

      const asset = await create(t.writer, ENTITY, { name: "Bundle" });
      const one = await create(t.writer, GROUP, { name: "One", extensions: { kwh: 3 } });
      const two = await create(t.writer, GROUP, { name: "Two", extensions: { kwh: 4 } });
      await member(t.writer, { asset: asset.id, group: one.id });
      await member(t.writer, { asset: asset.id, group: two.id });
      expect((await get(t.reader, asset.id)).extensions).toMatchObject({ total: 7, totalDoubled: 8 });
      await update(t.writer, GROUP, one.id, { extensions: { kwh: 5 } });
      expect((await get(t.reader, asset.id)).extensions).toMatchObject({ total: 9, totalDoubled: 10 });
      // A default counts for a target that exists, not for a member without one.
      await define(t.manager, "update", { fieldId: (await listed(t, "kwh", GROUP)).fieldId, definition: { ...number("Kwh"), defaultValue: 1 } }, GROUP);
      await drainJobs();
      await member(t.writer, { asset: asset.id });
      await member(t.writer, { asset: asset.id, group: (await create(t.writer, GROUP, { name: "Three" })).id });
      await drainJobs();
      expect((await get(t.reader, asset.id)).extensions.total).toBe(10);
    });

    test("back to the source's own entity: membership between records of one entity, and a cycle stays refused", async () => {
      const t = await tenant();
      await field(t, "kwh", number("Kwh"));
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "item.extensions.kwh" }, "Total"), "rollup");
      await field(t, "names", rollup({ collection: "members", aggregate: "arrayUnique", of: "item.name" }, "Names"), "rollup");
      const module = await create(t.writer, ENTITY, { name: "Module", extensions: { kwh: 4 } });
      const bundled = await create(t.writer, ENTITY, { name: "Bundle", extensions: { kwh: 1 } });
      await member(t.writer, { asset: bundled.id, item: module.id });
      await member(t.writer, { asset: bundled.id, item: module.id });
      expect((await get(t.reader, bundled.id)).extensions).toMatchObject({ total: 8, names: "Module" });
      await update(t.writer, ENTITY, module.id, { name: "Cell", extensions: { kwh: 5 } });
      expect((await get(t.reader, bundled.id)).extensions).toMatchObject({ total: 10, names: "Cell" });
      expect((await get(t.reader, module.id)).extensions.total).toBe(0);
      await field(t, "self", formula("{Total} + 1", "Self"), "formula");
      const circular = await failure(define(t.manager, "update", { fieldId: (await listed(t, "total")).fieldId,
        definition: rollup({ collection: "members", aggregate: "sum", of: "item.extensions.self" }, "Total") }));
      expect(circular).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("circular reference") });
    });

    test("a tenant reference of an extensible child, as the collection and as the step; deleting its target follows the reference's rule", async () => {
      const t = await tenant();
      await field(t, "group", reference(GROUP, "Group"));
      await field(t, "kept", reference(TARGET_ENTITY, "Kept", { onDelete: "restrict" }));
      await field(t, "loose", reference(TARGET_ENTITY, "Loose", { onDelete: "setNull" }));
      await field(t, "held", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "sum", of: "extensions.kept.capacity" }, "Held"), "rollup", GROUP);
      await field(t, "free", rollup({ collection: `${ENTITY}.extensions.group`, aggregate: "sum", of: "extensions.loose.capacity" }, "Free"), "rollup", GROUP);
      expect((await listed(t, "free", GROUP)).definition.rollup).toMatchObject({ collection: `${ENTITY}.extensions.group`, of: "extensions.loose.capacity" });
      const group = await create(t.writer, GROUP, { name: "G" });
      const kept = await create(t.writer, TARGET_ENTITY, { name: "K", capacity: 3 });
      const loose = await create(t.writer, TARGET_ENTITY, { name: "L", capacity: 4 });
      const asset = await create(t.writer, ENTITY, { name: "A", extensions: { group: group.id, kept: kept.id, loose: loose.id } });
      expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ held: 3, free: 4 });

      await update(t.writer, TARGET_ENTITY, loose.id, { capacity: 5 });
      expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ free: 5 });
      expect(await remove(t.writer, TARGET_ENTITY, kept.id)).toMatchObject({ error: { code: "OPERATION_REFUSED" } });
      expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ held: 3 });
      expect(await remove(t.writer, TARGET_ENTITY, loose.id)).not.toHaveProperty("error");
      expect((await get(t.reader, asset.id)).extensions.loose).toBeNull();
      expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ free: 0 });
      // A new value of the reference on the child reaches the parent.
      const again = await create(t.writer, TARGET_ENTITY, { name: "Again", capacity: 8 });
      await update(t.writer, ENTITY, asset.id, { extensions: { loose: again.id } });
      expect((await get(t.reader, group.id, GROUP)).extensions).toMatchObject({ free: 8 });
    });

    test("deleting a target over an authored relation: its foreign key refuses, and nothing changes", async () => {
      const t = await tenant();
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      const { asset, locations } = await bundle(t, [7]);
      expect(await remove(t.writer, TARGET_ENTITY, locations[0]!.id)).toHaveProperty("error");
      expect((await get(t.reader, asset.id)).extensions.total).toBe(7);
    });

    test("refused with the reason: more than one step, what the step cannot reach, a path in where", async () => {
      const t = await tenant();
      const refusals: Array<[Record<string, unknown>, RegExp]> = [
        [{ aggregate: "sum", of: "group.location.capacity" }, /follows more than one relation/],
        [{ aggregate: "sum", of: "extensions.place.location.capacity" }, /follows more than one relation/],
        [{ aggregate: "count", of: "location.contactEmail" }, /contactEmail is classified/],
        [{ aggregate: "count", of: "confidentialLocation.name" }, /is classified; what it points at/],
        [{ aggregate: "count", of: "restrictedLocation.name" }, /protected by a field policy/],
        [{ aggregate: "sum", of: "location.certifiedCapacity" }, /ExtensibleAssetLocation\.update writes it/],
        [{ aggregate: "count", of: "location.nothing" }, /nothing is not a field of ExtensibleAssetLocation/],
        [{ aggregate: "count", of: "nothing.name" }, /neither a tenant reference field .* nor a single relation of ExtensibleAssetMember/],
        // An owned child holds no tenant fields, so no tenant reference to step along.
        [{ aggregate: "count", of: "extensions.place.name" }, /ExtensibleAssetMember has no tenant fields/],
        [{ aggregate: "count", where: { kind: "rule", operator: "isNotEmpty", left: { kind: "path", path: "location.name" } } }, /rollup\.where: location\.name follows a relation/],
        [{ aggregate: "sum", of: "location.name" }, /sum needs a number field/],
      ];
      for (const [spec, message] of refusals) {
        expect(await refusal(t, "refused", spec)).toMatchObject({ code: "VALIDATION", message: expect.stringMatching(message) });
      }
    });

    test("a role that reads the source and not the target is refused, by name, whatever the owner lends the child", async () => {
      const t = await tenant();
      const refused = await refusal(t, "hours", { aggregate: "sum", of: "booking.hours" });
      expect(refused).toMatchObject({ code: "FORBIDDEN", data: { reason: "AUTHORIZATION_NARROWER" } });
      const message = (refused as { message: string }).message;
      expect(message).toContain("ExtensibleAssetBooking is readable for Test.Bookings.Read");
      expect(message).toContain("ExtensibleAsset also for General.All.Read");
    });

    test("an authorization profile on the target refuses it; one that comes later suspends it, redacted, and whatever reads it with it", async () => {
      const t = await tenant();
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      await field(t, "twice", formula("{Total} * 2", "Twice"), "formula");
      const { asset } = await bundle(t, [4]);
      await manage(t, TARGET_ENTITY);
      expect((await listed(t, "total")).state).toBe("ready");
      await adminWrite(t);
      const suspended = await listed(t, "total");
      expect(suspended.state).toBe("suspended");
      expect(suspended.backfill?.error).toMatchObject({ code: "AUTHORIZATION_PROOF_LOST", message: expect.stringContaining(`reads of ${TARGET_ENTITY}`) });
      expect((await listed(t, "twice")).state).toBe("suspended");
      const read = await get(t.reader, asset.id);
      expect(read.extensions).toMatchObject({ total: null, twice: null });
      expect(read.extensionsMeta.total).toMatchObject({ suspended: true });
      expect(await list(t.reader, { extensions: { total: { eq: 4 } } })).toHaveProperty("error");
      // The stored value stays until its designer decides, and saving it is proven anew.
      expect((await privileged(sql<{ value: string }>`select extension_values->>${suspended.fieldId} as value from erp.extensible_assets where id = ${asset.id}::uuid`))[0]!.value).toBe("4");
      expect(await failure(define(t.manager, "update", { fieldId: suspended.fieldId, definition: rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Again") })))
        .toMatchObject({ code: "FORBIDDEN", data: { reason: "AUTHORIZATION_NARROWER" } });
      expect(await failure(define(t.manager, "create", { key: "fresh", kind: "rollup", definition: rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }) })))
        .toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(TARGET_ENTITY) });
    });

    test("a change of the compiled contract suspends it at revalidation: the step's target and its relation count, not only the child", async () => {
      const t = await tenant();
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      await field(t, "parts", rollup({ collection: "members", aggregate: "countAll" }, "Parts"), "rollup");
      const registry = structuredClone((manifest as unknown as { extensionRegistry: Record<string, any> }).extensionRegistry);
      registry.readAccess[TARGET_ENTITY] = { ...registry.readAccess[TARGET_ENTITY], rowPolicy: "rowScope" };
      const restore = __setExtensionRegistryForTests(registry as never);
      try {
        const suspended = await withDbSession(fixture.app.db, t.manager, (trx) => revalidateLinkedFields(trx, t.manager));
        expect(suspended.map((item) => item.key)).toEqual(["total"]);
        expect(suspended[0]!.reason).toContain(`the rows of ${TARGET_ENTITY} are narrowed by rowScope`);
      } finally {
        restore();
      }
      expect((await listed(t, "parts")).state).toBe("ready");
    });

    test("beyond syncFanOut a write of the target leaves one journal row, stale on every parent until the worker ran", async () => {
      const t = await tenant();
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      const totalId = (await listed(t, "total")).fieldId;
      const shared = await create(t.writer, TARGET_ENTITY, { name: "Shared", capacity: 1 });
      const parents = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `p${n}` })));
      const elsewhere = await create(t.writer, ENTITY, { name: "Elsewhere" });
      for (const parent of parents) await member(t.writer, { asset: parent.id, location: shared.id });
      await update(t.writer, TARGET_ENTITY, shared.id, { capacity: 2 });
      expect(await journal(t.id)).toMatchObject([{ field_id: totalId, target_id: shared.id }]);
      for (const parent of parents) {
        const read = await get(t.reader, parent.id);
        expect(read.extensions.total).toBe(1);
        expect(read.extensionsMeta.total).toMatchObject({ stale: true });
      }
      expect((await get(t.reader, elsewhere.id)).extensionsMeta?.total ?? {}).not.toHaveProperty("stale");
      // Further writes coalesce.
      await update(t.writer, TARGET_ENTITY, shared.id, { capacity: 3 });
      expect(await journal(t.id)).toMatchObject([{ target_id: shared.id, generation: 2 }]);
      await drainJobs();
      expect(await journal(t.id)).toEqual([]);
      for (const parent of parents) {
        const read = await get(t.reader, parent.id);
        expect(read.extensions.total).toBe(3);
        expect(read.extensionsMeta?.total ?? {}).not.toHaveProperty("stale");
      }
    });

    test("one journal row on a target of the source's own entity serves the parents that reach it and the record itself", async () => {
      const t = await tenant();
      await field(t, "kwh", number("Kwh"));
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "item.extensions.kwh" }, "Total"), "rollup");
      const shared = await create(t.writer, ENTITY, { name: "Shared", extensions: { kwh: 1 } });
      const parents = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `p${n}` })));
      for (const parent of parents) await member(t.writer, { asset: parent.id, item: shared.id });
      await update(t.writer, ENTITY, shared.id, { extensions: { kwh: 2 } });
      expect(await journal(t.id)).toHaveLength(1);
      await drainJobs();
      for (const parent of parents) expect((await get(t.reader, parent.id)).extensions.total).toBe(2);
      // The same row key, left by a write of a child, is about the record itself.
      await sql`update erp.extensible_assets_field_values set value_number = 7 where record_id = ${shared.id}::uuid and field_id = ${(await listed(t, "kwh")).fieldId}::uuid`.execute(fixture.privileged.db);
      await withDbSession(fixture.app.db, t.writer, async (trx) => {
        const set = await loadExtensionFieldsFor(trx, t.writer, ENTITY, extensionRegistry.entity(ENTITY)!);
        await journalRecompute(trx, t.writer, { entity: ENTITY, field: set.byKey.get("total")!, targetEntity: ENTITY, targetId: parents[0]!.id });
      });
      await drainJobs();
      expect((await get(t.reader, parents[0]!.id)).extensions.total).toBe(7);
    });

    test("a journal row that names a parent recomputes that parent, not what reaches a target", async () => {
      const t = await tenant();
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      const shared = await create(t.writer, TARGET_ENTITY, { name: "Shared", capacity: 1 });
      const [first, second] = await Promise.all([1, 2].map((n) => create(t.writer, ENTITY, { name: `p${n}` })));
      await member(t.writer, { asset: first!.id, location: shared.id });
      await member(t.writer, { asset: second!.id, location: shared.id });
      await sql`update erp.extensible_asset_locations set capacity = 8 where id = ${shared.id}::uuid`.execute(fixture.privileged.db);
      await withDbSession(fixture.app.db, t.writer, async (trx) => {
        const set = await loadExtensionFieldsFor(trx, t.writer, ENTITY, extensionRegistry.entity(ENTITY)!);
        await journalRecompute(trx, t.writer, { entity: ENTITY, field: set.byKey.get("total")!, targetEntity: ENTITY, targetId: first!.id });
      });
      await drainJobs();
      expect((await get(t.reader, first!.id)).extensions.total).toBe(8);
      expect((await get(t.reader, second!.id)).extensions.total).toBe(1);
    });

    test("rebuildIndex brings back what a write behind the runtime left, over the step", async () => {
      const t = await tenant();
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      const { asset, locations } = await bundle(t, [3]);
      await sql`update erp.extensible_asset_locations set capacity = 9 where id = ${locations[0]!.id}::uuid`.execute(fixture.privileged.db);
      expect((await get(t.reader, asset.id)).extensions.total).toBe(3);
      await define(t.manager, "rebuildIndex", { fieldId: (await listed(t, "total")).fieldId });
      await drainJobs();
      expect((await get(t.reader, asset.id)).extensions.total).toBe(9);
    });

    test("the target's tenant is the child's: another tenant sees nothing, and a foreign key across tenants reads nothing", async () => {
      const a = await tenant();
      const b = await tenant();
      await field(a, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      await field(a, "kwh", number("Kwh"), undefined, GROUP);
      await field(a, "perGroup", rollup({ collection: "members", aggregate: "sum", of: "group.extensions.kwh" }, "Per group"), "rollup");
      const { asset, locations } = await bundle(a, [5]);
      const groupOfA = await create(a.writer, GROUP, { name: "A", extensions: { kwh: 2 } });
      await member(a.writer, { asset: asset.id, group: groupOfA.id });
      expect((await get(a.reader, asset.id)).extensions).toMatchObject({ total: 5, perGroup: 2 });
      expect(((await define(b.manager, "list")) as { items: unknown[] }).items).toEqual([]);
      expect(await list(b.reader)).toEqual([]);
      expect((await executeEntityOperation(fixture.app.db, b.reader, { operation: { id: `${ENTITY}.get`, intent: "get" }, input: { id: asset.id } }) as { data?: unknown }).data ?? null).toBeNull();
      // B's member cannot name A's record, by its write path or its foreign key.
      await field(b, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      await field(b, "kwh", number("Kwh"), undefined, GROUP);
      await field(b, "perGroup", rollup({ collection: "members", aggregate: "sum", of: "group.extensions.kwh" }, "Per group"), "rollup");
      const own = await create(b.writer, ENTITY, { name: "B" });
      expect(await member(b.writer, { asset: own.id, location: locations[0]!.id }).then(() => "written", () => "refused")).toBe("refused");
      // A row that got there past every constraint is read by nothing: the join names the child's tenant.
      await fixture.privileged.db.transaction().execute(async (trx) => {
        await sql`set local session_replication_role = replica`.execute(trx);
        await sql`insert into erp.extensible_asset_members (tenant_id, asset_id, location_id, group_id)
          values (${b.id}::uuid, ${own.id}::uuid, ${locations[0]!.id}::uuid, ${groupOfA.id}::uuid)`.execute(trx);
      });
      await define(b.manager, "rebuildIndex", {});
      await drainJobs();
      expect((await get(b.reader, own.id)).extensions).toMatchObject({ total: 0, perGroup: 0 });
      // A write in A finds no parent of B.
      await update(a.writer, TARGET_ENTITY, locations[0]!.id, { capacity: 6 });
      expect((await get(a.reader, asset.id)).extensions.total).toBe(6);
      expect((await get(b.reader, own.id)).extensions.total).toBe(0);
    });

    /** Update a location in a transaction of its own and keep it open until the returned function is called. */
    async function holdCapacity(id: string, capacity: number) {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const held = new Promise<void>((resolve) => { locked = resolve; });
      const writer = fixture.privileged.db.transaction().execute(async (trx) => {
        await sql`update erp.extensible_asset_locations set capacity = ${capacity} where id = ${id}::uuid`.execute(trx);
        locked();
        await hold;
      });
      await held;
      return async () => { release(); await writer; };
    }

    test("a child's write that names a new target waits for a write of it, so a parent never keeps the older value", async () => {
      const t = await tenant();
      await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      const asset = await create(t.writer, ENTITY, { name: "A" });
      const location = await create(t.writer, TARGET_ENTITY, { name: "L", capacity: 1 });
      const current = await member(t.writer, { asset: asset.id });
      const release = await holdCapacity(location.id, 2);
      const moved = editMember(t.writer, current.id, { location: location.id });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await release();
      await moved;
      expect((await get(t.reader, asset.id)).extensions.total).toBe(2);
    });

    test("a collection write locks the new target in the one order, before the parent's row", async () => {
      const t = await tenant();
      await field(t, "total", rollup({ collection: "parts", aggregate: "sum", of: "location.capacity" }, "Total"), "rollup");
      const asset = await create(t.writer, ENTITY, { name: "A" });
      const location = await create(t.writer, TARGET_ENTITY, { name: "L", capacity: 1 });
      const expectedVersion = String(asset.updated_at);
      const release = await holdCapacity(location.id, 2);
      const inserted = parts(t.writer, "insert", { id: asset.id, expectedVersion, values: { quantity: 1, location: location.id } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const free = await sql<{ id: string }>`select id from erp.extensible_assets where id = ${asset.id}::uuid for no key update nowait`.execute(fixture.privileged.db).then(() => true, () => false);
      await release();
      await inserted;
      expect(free).toBe(true);
      expect((await get(t.reader, asset.id)).extensions.total).toBe(2);
    });
  });

  describe("the classification floor", () => {
    const internal = { classification: { sensitivity: "internal" } };
    const tooLow = (reads: string) => ({ code: "VALIDATION", message: expect.stringContaining(`it reads ${reads}, which is internal`),
      violations: [expect.objectContaining({ field: "definition.classification", code: "CLASSIFICATION_TOO_LOW" })], data: { reason: "CLASSIFICATION_TOO_LOW" } });
    const save = (t: Tenant, key: string, kind: string, definition: Record<string, unknown>, entity = ENTITY) =>
      failure(define(t.manager, "create", { key, kind, definition }, entity));

    test("a formula is at least as sensitive as the tenant field, the authored field or the computed field it reads", async () => {
      const t = await tenant();
      await field(t, "cost", { ...number("Cost"), ...internal });
      expect(await save(t, "double", "formula", formula("{Cost} * 2", "Double"))).toMatchObject(tooLow("cost"));
      expect(await save(t, "weighted", "formula", formula("spec.unitCost * 2", "Weighted"))).toMatchObject(tooLow("spec.unitCost"));
      await field(t, "double", { ...formula("{Cost} * 2", "Double"), ...internal }, "formula");
      // Along the chain: what reads an internal computed field is internal too.
      expect(await save(t, "quadruple", "formula", formula("{Double} * 2", "Quadruple"))).toMatchObject(tooLow("double"));
      expect((await listed(t, "double")).state).toBe("ready");
      // Higher than the input is no refusal, and classified inputs stay out altogether.
      await field(t, "secret", { ...number("Secret"), classification: { sensitivity: "confidential" } });
      expect(await save(t, "shown", "formula", { ...formula("{Secret} * 2", "Shown"), ...internal })).toMatchObject({ code: "VALIDATION" });
    });

    test("a lookup: the field it reads and the reference it follows", async () => {
      const t = await tenant();
      await field(t, "secretName", { ...text("Secret name"), ...internal }, undefined, GROUP);
      await field(t, "group", reference(GROUP, "Group"));
      await field(t, "hiddenGroup", { ...reference(GROUP, "Hidden group"), ...internal });
      await field(t, "groupName", text("Group name"), undefined, GROUP);
      expect(await save(t, "shown", "lookup", lookup("extensions.group", "extensions.secretName"))).toMatchObject(tooLow(`${GROUP}.secretName`));
      expect(await save(t, "through", "lookup", lookup("extensions.hiddenGroup", "extensions.groupName"))).toMatchObject(tooLow(`${ENTITY}.hiddenGroup`));
      await field(t, "kept", { ...lookup("extensions.group", "extensions.secretName"), ...internal }, "lookup");
      expect((await listed(t, "kept")).state).toBe("ready");
      expect(await save(t, "onward", "formula", formula("{Lookup} & \"!\"", "Onward"))).toMatchObject(tooLow("kept"));
    });

    test("a rollup: the field of the child, where, the step and the reference it counts through", async () => {
      const t = await tenant();
      const big = { kind: "rule", operator: "greaterThan", left: { kind: "path", path: "unitCost" }, right: { kind: "literal", value: 2 } };
      expect(await save(t, "total", "rollup", rollup({ collection: "parts", aggregate: "sum", of: "unitCost" }))).toMatchObject(tooLow("ExtensibleAssetPart.unitCost"));
      expect(await save(t, "dear", "rollup", rollup({ collection: "parts", aggregate: "countAll", where: big }))).toMatchObject(tooLow("ExtensibleAssetPart.unitCost"));
      await field(t, "secret", { ...number("Secret"), ...internal }, undefined, GROUP);
      expect(await save(t, "stepped", "rollup", rollup({ collection: "members", aggregate: "sum", of: "group.extensions.secret" }))).toMatchObject(tooLow(`${GROUP}.secret`));
      await field(t, "hidden", { ...reference(ENTITY, "Hidden"), ...internal }, undefined, GROUP);
      expect(await save(t, "groups", "rollup", rollup({ collection: `${GROUP}.extensions.hidden`, aggregate: "countAll" }))).toMatchObject(tooLow(`${GROUP}.hidden`));
      await field(t, "total", { ...rollup({ collection: "parts", aggregate: "sum", of: "unitCost" }), ...internal }, "rollup");
      const asset = await create(t.writer, ENTITY, { name: "A" });
      await parts(t.writer, "insert", { id: asset.id, expectedVersion: String(asset.updated_at), values: { quantity: 1, unitCost: 7 } });
      expect((await get(t.reader, asset.id)).extensions.total).toBe(7);
    });

    test("a field saved below what it reads is suspended by the revalidation, and redacted; so is what reads it", async () => {
      const t = await tenant();
      const cost = await field(t, "cost", number("Cost"));
      await field(t, "double", formula("{Cost} * 2", "Double"), "formula");
      const name = await field(t, "secretName", text("Secret name"), undefined, GROUP);
      await field(t, "group", reference(GROUP, "Group"));
      await field(t, "groupName", lookup("extensions.group", "extensions.secretName"), "lookup");
      const group = await create(t.writer, GROUP, { name: "G", extensions: { secretName: "x" } });
      const asset = await create(t.writer, ENTITY, { name: "A", extensions: { cost: 2, group: group.id } });
      expect((await get(t.reader, asset.id)).extensions).toMatchObject({ double: 4, groupName: "x" });
      // A definition of before the floor: only SQL can leave one now.
      await privileged(sql`update platform.extension_field_definitions set definition = jsonb_set(definition, '{classification,sensitivity}', '"internal"'), position = position + 100
        where tenant_id = ${t.id}::uuid and field_id in (${cost}::uuid, ${name}::uuid)`);
      const suspended = await withDbSession(fixture.app.db, t.manager, (trx) => revalidateLinkedFields(trx, t.manager));
      expect(suspended.map((item) => item.key).sort()).toEqual(["double", "groupName"]);
      expect(suspended.find((item) => item.key === "double")!.reason).toContain("it reads cost, which is internal");
      for (const key of ["double", "groupName"]) expect((await listed(t, key)).backfill?.error).toMatchObject({ code: "AUTHORIZATION_PROOF_LOST" });
      const read = await get(t.reader, asset.id);
      expect(read.extensions).toMatchObject({ double: null, groupName: null });
      expect(read.extensionsMeta.double).toMatchObject({ suspended: true });
    });
  });

  test("a lookup of text a JSON number cannot hold shows what a reader of the target sees", async () => {
    const t = await tenant();
    const price = await field(t, "price", number("Price"), undefined, GROUP);
    await field(t, "group", reference(GROUP, "Group"));
    await field(t, "groupPrice", lookup("extensions.group", "extensions.price"), "lookup");
    const group = await create(t.writer, GROUP, { name: "G", extensions: { price: 1 } });
    const asset = await create(t.writer, ENTITY, { name: "A", extensions: { group: group.id } });
    const exact = "9007199254740993.995";
    await privileged(sql`update erp.extensible_asset_groups set extension_values = jsonb_set(extension_values, ${`{${price}}`}::text[], to_jsonb(${exact}::text)) where id = ${group.id}::uuid`);
    await update(t.writer, ENTITY, asset.id, { extensions: { group: null } });
    await update(t.writer, ENTITY, asset.id, { extensions: { group: group.id } });
    expect((await get(t.reader, asset.id)).extensions.groupPrice).toBe(exact);
  });

  describe("a writer and the journal worker", () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    /** Until a backend of this database waits for a lock: the worker, for what the writer holds. */
    async function blocked() {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await privileged(sql<{ waiting: number }>`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`);
        if (row!.waiting) return;
        await sleep(25);
      }
      throw new Error("nothing came to wait");
    }
    const row = async (t: Tenant, fieldId: string) => (await privileged(sql<{ id: string }>`select id::text as id from platform.extension_field_recomputes
      where tenant_id = ${t.id}::uuid and field_id = ${fieldId}::uuid`))[0]!.id;
    const asJournal = async (trx: Transaction<never>, t: Tenant, fieldId: string, target: { entity: string; id: string }) => {
      const set = await loadExtensionFieldsFor(trx as never, t.writer, ENTITY, extensionRegistry.entity(ENTITY)!, { lock: "shared" });
      await journalRecompute(trx as never, t.writer, { entity: ENTITY, field: set.byId.get(fieldId)!, targetEntity: target.entity, targetId: target.id });
    };
    const batch = (t: Tenant, id: string) => withDbSession(fixture.worker.db, t.writer, (trx) => runRecomputeBatch(trx, t.writer, id));

    /**
     * A writer holds a record, as lockLinkedRecords leaves it, and a worker
     * comes for the same record on a batch of a row the writer journals next:
     * the order of a write is record, then row, and a worker's must be too.
     */
    async function collide(t: Tenant, fieldId: string, held: string, target: { entity: string; id: string }) {
      await withDbSession(fixture.app.db, t.writer, (trx) => asJournal(trx as never, t, fieldId, target));
      const id = await row(t, fieldId);
      let hold!: () => void, go!: () => void;
      const holding = new Promise<void>((resolve) => { hold = resolve; });
      const gate = new Promise<void>((resolve) => { go = resolve; });
      const writing = withDbSession(fixture.app.db, t.writer, async (trx) => {
        await sql`select id from erp.extensible_assets where id = ${held}::uuid for no key update`.execute(trx);
        hold();
        await gate;
        await asJournal(trx as never, t, fieldId, target);
      });
      await holding;
      const first = batch(t, id);
      await blocked();
      go();
      await writing;
      // The write came while the batch ran, so the row stays for a batch that sees it.
      expect(await first).toMatchObject({ done: false });
      for (let run = 0; run < 3 && (await journal(t.id)).length; run += 1) await batch(t, id);
      expect(await journal(t.id)).toEqual([]);
    }

    test("a rollup's row: the record itself", async () => {
      const t = await tenant();
      const total = await field(t, "total", rollup({ collection: "parts", aggregate: "sum", of: "quantity" }), "rollup");
      const asset = await create(t.writer, ENTITY, { name: "A" });
      await collide(t, total, asset.id, { entity: ENTITY, id: asset.id });
    });

    test("a rollup over its own entity whose step reaches the row's target: the record itself again", async () => {
      const t = await tenant();
      await field(t, "weight", number("Weight"));
      const total = await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "item.extensions.weight" }), "rollup");
      const asset = await create(t.writer, ENTITY, { name: "A" });
      await collide(t, total, asset.id, { entity: ENTITY, id: asset.id });
    });

    test("a lookup's row: a referring record", async () => {
      const t = await tenant();
      await field(t, "place", reference(TARGET_ENTITY, "Place"));
      const placeName = await field(t, "placeName", lookup("extensions.place", "name"), "lookup");
      const location = await create(t.writer, TARGET_ENTITY, { name: "L" });
      const asset = await create(t.writer, ENTITY, { name: "A", extensions: { place: location.id } });
      await sql`update erp.extensible_asset_locations set name = 'M' where id = ${location.id}::uuid`.execute(fixture.privileged.db);
      await collide(t, placeName, asset.id, { entity: TARGET_ENTITY, id: location.id });
      expect((await get(t.reader, asset.id)).extensions.placeName).toBe("M");
    });

    test("a database that gives up on a write answers a retryable conflict, and the write changed nothing", async () => {
      const t = await tenant();
      const asset = await create(t.writer, ENTITY, { name: "A" });
      for (const sqlstate of ["40P01", "40001"]) {
        const repair = await failWrites("erp.extensible_assets", sqlstate);
        const answer = await executeEntityOperation(fixture.app.db, t.writer, { operation: { id: `${ENTITY}.update`, intent: "update" },
          input: { id: asset.id, values: { name: "B" }, expectedVersion: String(asset.updated_at) } });
        await repair();
        expect(answer).toMatchObject({ error: { code: "CONFLICT", retryable: true } });
        expect((await get(t.reader, asset.id)).name).toBe("A");
      }
    });
  });

  describe("a write that comes back to its own record", () => {
    test("an update answers with the row as it stands, so the next write finds its version", async () => {
      const t = await tenant();
      await field(t, "weight", number("Weight"));
      await field(t, "parent", reference(ENTITY, "Parent"));
      await field(t, "total", rollup({ collection: `${ENTITY}.extensions.parent`, aggregate: "sum", of: "extensions.weight" }), "rollup");
      const asset = await create(t.writer, ENTITY, { name: "A", extensions: { weight: 1 } });
      const joined = await update(t.writer, ENTITY, asset.id, { extensions: { parent: asset.id } });
      expect(joined.extensions.total).toBe(1);
      const stored = await get(t.reader, asset.id);
      expect(joined.updated_at).toBe(stored.updated_at);
      const next = await executeEntityOperation(fixture.app.db, t.writer, { operation: { id: `${ENTITY}.update`, intent: "update" },
        input: { id: asset.id, values: { extensions: { weight: 4 } }, expectedVersion: String(joined.updated_at) } });
      expect(next).toMatchObject({ data: { extensions: { total: 4 } } });
    });

    test("a create as well: a child that looks up what its own create changed on its parent", async () => {
      const t = await tenant();
      await field(t, "parent", reference(ENTITY, "Parent"));
      await field(t, "count", rollup({ collection: `${ENTITY}.extensions.parent`, aggregate: "countAll" }), "rollup");
      await field(t, "siblings", lookup("extensions.parent", "extensions.count"), "lookup");
      const parent = await create(t.writer, ENTITY, { name: "P" });
      const child = await create(t.writer, ENTITY, { name: "C", extensions: { parent: parent.id } });
      expect(child.extensions.siblings).toBe(1);
      expect(child.updated_at).toBe((await get(t.reader, child.id)).updated_at);
    });
  });

  test("a foreign key of a handwritten manifest that sets null: a rollup's step keeps its value until a rebuild, as the documentation says", async () => {
    const t = await tenant();
    const total = await field(t, "total", rollup({ collection: "members", aggregate: "sum", of: "location.capacity" }), "rollup");
    const asset = await create(t.writer, ENTITY, { name: "A" });
    const location = await create(t.writer, TARGET_ENTITY, { name: "L", capacity: 5 });
    await member(t.writer, { asset: asset.id, location: location.id });
    expect((await get(t.reader, asset.id)).extensions.total).toBe(5);
    await withSetNullKey("erp.extensible_asset_members", "location_id", "erp.extensible_asset_locations", async () => {
      await remove(t.writer, TARGET_ENTITY, location.id);
      expect((await get(t.reader, asset.id)).extensions.total).toBe(5);
      await define(t.manager, "rebuildIndex", { fieldId: total });
      await drainJobs();
      expect((await get(t.reader, asset.id)).extensions.total).toBe(0);
    });
  });

  describe("removing an owned child through its collection", () => {
    const inserted = async (t: Tenant, asset: Row, values: Record<string, unknown>) =>
      (await parts(t.writer, "insert", { id: asset.id, expectedVersion: String((await get(t.reader, asset.id)).updated_at), values })).childId;
    const removed = async (t: Tenant, asset: Row, childId: string) =>
      parts(t.writer, "remove", { id: asset.id, expectedVersion: String((await get(t.reader, asset.id)).updated_at), childId });

    test("a tenant reference that restricts refuses it, naming what points at it", async () => {
      const t = await tenant();
      await field(t, "partOf", reference("ExtensibleAssetPart", "Part"));
      const asset = await create(t.writer, ENTITY, { name: "A" });
      const child = await inserted(t, asset, { quantity: 2 });
      const other = await create(t.writer, ENTITY, { name: "B", extensions: { partOf: child } });
      expect(await failure(removed(t, asset, child))).toMatchObject({ code: "OPERATION_REFUSED", message: expect.stringContaining(`by 1 ${ENTITY} record(s) through "partOf"`) });
      await update(t.writer, ENTITY, other.id, { extensions: { partOf: null } });
      await removed(t, asset, child);
      expect((await get(t.reader, asset.id)).id).toBe(asset.id);
    });

    test("a tenant reference that is set null leaves no orphan and no lookup through it", async () => {
      const t = await tenant();
      await field(t, "partOf", reference("ExtensibleAssetPart", "Part", { onDelete: "setNull" }));
      await field(t, "partQuantity", lookup("extensions.partOf", "quantity"), "lookup");
      const asset = await create(t.writer, ENTITY, { name: "A" });
      const child = await inserted(t, asset, { quantity: 2 });
      const other = await create(t.writer, ENTITY, { name: "B", extensions: { partOf: child } });
      expect(other.extensions.partQuantity).toBe(2);
      await removed(t, asset, child);
      expect((await get(t.reader, other.id)).extensions).toMatchObject({ partOf: null, partQuantity: null });
      const { findExtensionReferenceOrphans } = await import("../references.js");
      expect(await withDbSession(fixture.app.db, t.manager, (trx) => findExtensionReferenceOrphans(trx, t.manager))).toEqual([]);
    });

    test("more referring records than the budget go through the journal, in the same order of locks", async () => {
      const t = await tenant();
      await field(t, "partOf", reference("ExtensibleAssetPart", "Part", { onDelete: "setNull" }));
      const asset = await create(t.writer, ENTITY, { name: "A" });
      const child = await inserted(t, asset, { quantity: 2 });
      const others = await Promise.all([1, 2, 3, 4].map((n) => create(t.writer, ENTITY, { name: `B${n}`, extensions: { partOf: child } })));
      await removed(t, asset, child);
      expect(await journal(t.id)).toHaveLength(1);
      await drainJobs();
      for (const other of others) expect((await get(t.reader, other.id)).extensions.partOf).toBeNull();
    });

    test("an authored relation whose foreign key lets go: the lookup through it is computed again", async () => {
      const t = await tenant();
      await field(t, "partQuantity", lookup("part", "quantity"), "lookup", GROUP);
      const asset = await create(t.writer, ENTITY, { name: "A" });
      const child = await inserted(t, asset, { quantity: 2 });
      const group = await create(t.writer, GROUP, { name: "G", part: child });
      expect(group.extensions.partQuantity).toBe(2);
      await withSetNullKey("erp.extensible_asset_groups", "part_id", "erp.extensible_asset_parts", async () => {
        await removed(t, asset, child);
        expect((await get(t.reader, group.id, GROUP)).extensions.partQuantity).toBeNull();
      });
    });
  });
});
