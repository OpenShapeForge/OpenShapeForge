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
import { loadExtensionFields } from "../store.js";
import { extensionFilterCondition, extensionPredicateRank } from "../query.js";
import { EXTENSION_BACKFILL_KIND, EXTENSION_RETENTION_KIND, applyExtensionRetention, extensionBackfillJobHandler, extensionRetentionJobHandler, runBackfillBatch } from "../backfill.js";
import { catalog } from "../../../../mcp/catalog.js";
import { describeTool } from "../../../../mcp/entity-tool-projection.js";
import { invokeTool } from "../../../../mcp/entity-tool-invocation.js";
import { hasExtensibleEntities, primeSessionExtensions, withExtensionTool } from "../../../../mcp/extension-schemas.js";
import { renderTypeDefinition } from "../../../../graphql/generated-entity-schema.js";
import { createModuleSessionCapability, ModulePlatformRuntime } from "../../../../modules/platform.js";
import { bindOperationHandlers, invokeOperation, type OperationContract } from "../../../runtime.js";
import rawCatalog from "../../../../generated/operations/catalog.json" with { type: "json" };
import { createExtensionFixture, ENTITY, MANAGER_ROLE, READER_ROLE, sessionFor, TARGET_ENTITY, WRITER_ROLE, type ExtensionFixture } from "./fixture.js";

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
  withDbSession(fixture.app.db, session, (trx) => executeFieldDefinitionAction(trx, session, ENTITY, action, input));
const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { operationError?: { code: string; message: string } }).operationError ?? error; }
  throw new Error("expected a refusal");
};
const label = (nl: string) => ({ nl, en: nl });

async function createAsset(session: Session, extensions?: Record<string, unknown>, name = "Object") {
  return executeEntityOperation(fixture.app.db, session, {
    operation: { id: `${ENTITY}.create`, intent: "create" },
    input: { values: { name, ...(extensions ? { extensions } : {}) } },
  });
}
async function created(session: Session, extensions?: Record<string, unknown>, name?: string) {
  const result = await createAsset(session, extensions, name);
  if ("error" in result || !result.data) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.data as Record<string, unknown> & { id: string; extensions: Record<string, unknown>; extensionsMeta: Record<string, Record<string, unknown>> };
}
async function createLocation(session: Session, name: string) {
  const result = await executeEntityOperation(fixture.app.db, session, {
    operation: { id: `${TARGET_ENTITY}.create`, intent: "create" }, input: { values: { name } },
  });
  if ("error" in result || !result.data) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.data as Record<string, unknown> & { id: string; updated_at?: unknown };
}
/** The acceptance entity requires optimistic concurrency on update; a session that cannot read the row passes a stale version. */
async function update(session: Session, id: string, values: Record<string, unknown>) {
  const current = await get(session, id);
  const expectedVersion = current ? String(current.updated_at) : new Date(0).toISOString();
  return executeEntityOperation(fixture.app.db, session, { operation: { id: `${ENTITY}.update`, intent: "update" }, input: { id, values, expectedVersion } });
}
async function get(session: Session, id: string) {
  const result = await executeEntityOperation(fixture.app.db, session, { operation: { id: `${ENTITY}.get`, intent: "get" }, input: { id } });
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return result.data as (Record<string, unknown> & { extensions: Record<string, unknown>; extensionsMeta: Record<string, Record<string, unknown>> }) | null;
}
async function remove(session: Session, row: { id: string; updated_at?: unknown }) {
  return executeEntityOperation(fixture.app.db, session, { operation: { id: `${ENTITY}.delete`, intent: "delete" },
    input: { id: row.id, confirmed: true, expectedVersion: String(row.updated_at) } });
}
async function list(session: Session, input: Record<string, unknown>) {
  return executeEntityOperation(fixture.app.db, session, { operation: { id: `${ENTITY}.list`, intent: "list" }, input });
}
const ids = (result: Awaited<ReturnType<typeof list>>) => {
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return (result.data as { items: Array<{ data: { id: string } }> }).items.map((item) => item.data.id);
};
async function indexRows(recordId: string, fieldId?: string) {
  return (await sql<Record<string, unknown>>`select * from erp.extensible_assets_field_values where record_id = ${recordId}::uuid
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
      ["links", { osfType: ENTITY, label: label("Gekoppeld"), cardinality: "collection", onDelete: "setNull", classification: { sensitivity: "public" } }],
      ["parent", { osfType: ENTITY, label: label("Hoofdtaak"), onDelete: "restrict", classification: { sensitivity: "public" } }],
      ["plek", { osfType: TARGET_ENTITY, label: label("Plek"), onDelete: "restrict", classification: { sensitivity: "public" } }],
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
    // limits.fields is 10 on the acceptance entity.
    const last = await define(manager, "create", { key: "laatste", definition: { osfType: "string", classification: { sensitivity: "public" } } }) as { fieldId: string };
    expect(await failure(define(manager, "create", { key: "teveel", definition: { osfType: "string", classification: { sensitivity: "public" } } })))
      .toMatchObject({ code: "LIMIT_EXCEEDED" });
    // A deleted field frees its slot (and needs no backfill work: no record has it).
    await define(manager, "deprecate", { fieldId: last.fieldId });
    await define(manager, "delete", { fieldId: last.fieldId, confirmAffectedRecords: 0 });
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

    const missing = await createAsset(writer, { soort: "batterij" });
    expect(missing).toMatchObject({ error: { code: "VALIDATION", violations: [expect.objectContaining({ field: "extensions.accu", code: "REQUIRED" })] } });
    const kit = await created(writer, { soort: "kit" }, "Kit");
    expect(kit.extensionsMeta.accu).toEqual({ applicable: false });
    expect(kit.extensions.accu).toBeNull();
    expect(await createAsset(writer, { kleur: "rood" })).toMatchObject({ error: { code: "VALIDATION", violations: [expect.objectContaining({ code: "UNKNOWN_FIELD" })] } });
    expect(await createAsset(writer, { aantal: 1.5 })).toMatchObject({ error: { code: "VALIDATION", violations: [expect.objectContaining({ field: "extensions.aantal" })] } });
    expect(await createAsset(writer, { extensionValues: {} } as never)).toMatchObject({ error: { code: "VALIDATION" } });
    expect(await executeEntityOperation(fixture.app.db, writer, { operation: { id: `${ENTITY}.create`, intent: "create" },
      input: { values: { name: "raw", extensionValues: { [fields.bsn!]: "x" } } } })).toMatchObject({ error: {} });

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
    expect(await createAsset(writer, { sku: "U-1" })).toMatchObject({ error: { code: "CONFLICT" } });
    // Another tenant has its own namespace (and no definitions at all).
    expect(await createAsset(writerB, { sku: "U-1" })).toMatchObject({ error: { code: "VALIDATION" } });
    const moved = await update(writer, first.id, { extensions: { sku: "U-2" } });
    expect("error" in moved).toBe(false);
    expect((await sql`select value_text from erp.extensible_assets_field_unique_values where record_id = ${first.id}::uuid`.execute(fixture.privileged.db)).rows)
      .toEqual([{ value_text: "u-2" }]);
    const second = await created(writer, { sku: "U-1" });
    expect(await createAsset(writer, { sku: "U-2" })).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await remove(writer, (moved as unknown as { data: { id: string; updated_at: unknown } }).data)).toMatchObject({ data: { deleted: true } });
    expect((await created(writer, { sku: "U-2" })).extensions.sku).toBe("U-2");
    expect(second.extensions.sku).toBe("U-1");
  });

  test("references are authorized against the real target row", async () => {
    const target = await created(writer, undefined, "Doel");
    const foreign = await created(writerB, undefined, "Vreemd");
    expect(await createAsset(writer, { parent: foreign.id })).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await createAsset(writer, { parent: randomUUID() })).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await createAsset(writer, { parent: "not-a-uuid" })).toMatchObject({ error: { code: "VALIDATION" } });
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
    const scope = { name: `Q-${tag}` };
    expect(ids(await list(reader, { filter: { ...scope, extensions: { soort: { eq: "batterij" } } }, limit: 50 })).sort()).toEqual([a.id, b.id, d.id].sort());
    expect(ids(await list(reader, { filter: { ...scope, extensions: { accu: { gte: 10 } } } })).sort()).toEqual([b.id, d.id].sort());
    expect(ids(await list(reader, { filter: { ...scope, extensions: { capaciteit: { value: { gt: 1 }, unit: { eq: "kWh" } } } } }))).toEqual([a.id]);
    expect(ids(await list(reader, { filter: { ...scope, extensions: { accu: { isNull: true } } } }))).toEqual([c.id]);
    expect(ids(await list(reader, { filter: { ...scope, extensions: { links: { contains: c.id } } } }))).toEqual([d.id]);
    expect(ids(await list(reader, { filter: { ...scope, or: [{ extensions: { soort: { eq: "kit" } } }, { extensions: { accu: { lt: 6 } } }] } })).sort()).toEqual([a.id, c.id].sort());
    expect(await list(reader, { filter: { ...scope, extensions: { links: { eq: c.id } } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    // A reference compares by record id, as uuid, so the reference index serves it.
    expect(ids(await list(reader, { filter: { ...scope, extensions: { links: { contains: a.id.toUpperCase() } } } }))).toEqual([d.id]);
    expect(await list(reader, { filter: { ...scope, extensions: { links: { contains: "not-an-id" } } } })).toMatchObject({ error: { code: "VALIDATION" } });
    expect(await list(reader, { filter: { ...scope, extensions: { parent: { in: [a.id, "x"] } } } })).toMatchObject({ error: { code: "VALIDATION" } });
    expect(await list(reader, { filter: { ...scope, extensions: { parent: { startsWith: "0" } } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    expect(ids(await list(reader, { filter: { ...scope, extensions: { parent: { ne: a.id } } } }))).toEqual([]);
    // Predicates are ordered most selective first by operator, whatever the
    // order of the keys: equality, a range, a substring, "has no value".
    const shapes = { scalar: { column: "text" as const, collection: false }, flag: { column: "boolean" as const, collection: false }, many: { column: "ref" as const, collection: true } };
    expect([["eq"], ["in"], ["gte", "lt"], ["startsWith"], ["gt"], ["contains"], ["ne"]].map((operators) => extensionPredicateRank(shapes.scalar, operators)))
      .toEqual([0, 0, 1, 1, 2, 3, 5]);
    expect([extensionPredicateRank(shapes.flag, ["eq"]), extensionPredicateRank(shapes.many, ["contains"])]).toEqual([4, 0]);
    // Definitions are proven per transaction; the condition is built inside one.
    const order = (filter: Record<string, unknown>) => withDbSession(fixture.app.db, reader, async (trx) => {
      await loadExtensionFields(trx, reader, fixture.table);
      const compiled = extensionFilterCondition(fixture.table, reader, filter).compile(fixture.app.db);
      return compiled.parameters.filter((parameter) => Object.values(fields).includes(parameter as string));
    });
    const mixed = { links: { isNull: true }, soort: { contains: "it" }, accu: { gte: 1 }, parent: { eq: a.id } };
    expect(await order(mixed)).toEqual([fields.parent, fields.accu, fields.soort, fields.links]);
    expect(await order(Object.fromEntries(Object.entries(mixed).reverse()))).toEqual(await order(mixed));
    // A classified key is never a filter or sort key, even for a writer who may read it.
    expect(await list(writer, { filter: { extensions: { bsn: { eq: "123456782" } } } })).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await list(writer, { sort: { field: "extensions.bsn", direction: "asc" } })).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await list(writer, { filter: { extensions: { nope: { eq: 1 } } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    // The raw source column is no filter or sort key under either name.
    for (const key of ["extensionValues", "extension_values"]) {
      expect(await list(writer, { filter: { [key]: { eq: "{}" } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
      expect(await list(writer, { sort: { field: key, direction: "asc" } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    }
    // limits.filtersPerQuery counts predicates over the whole tree (limit 3).
    expect(await list(reader, { filter: { extensions: { accu: { gte: 1, lte: 100 } }, and: [{ extensions: { soort: { eq: "kit" } } }, { extensions: { aantal: { eq: 1 } } }] } }))
      .toMatchObject({ error: { code: "BAD_USER_INPUT", message: expect.stringContaining("at most 3") } });
    // Sort: nulls last, id as tiebreaker in the sort's direction.
    const sorted = ids(await list(reader, { filter: scope, sort: { field: "extensions.accu", direction: "desc" } }));
    expect(sorted).toEqual([...[b.id, d.id].sort().reverse(), a.id, c.id]);
    expect(await list(reader, { sort: { field: "extensions.links" } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    // Tenant B's query sees nothing of tenant A, by filter or by sort.
    expect(await list(writerB, { filter: { extensions: { soort: { eq: "batterij" } } } })).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    expect(ids(await list(writerB, { filter: scope }))).toEqual([]);
    // Nor do the side tables leak through RLS to another tenant's session.
    const leaked = await withDbSession(fixture.app.db, writerB, async (trx) => ({
      values: (await sql<{ n: string }>`select count(*)::text as n from erp.extensible_assets_field_values`.execute(trx)).rows[0]!.n,
      claims: (await sql<{ n: string }>`select count(*)::text as n from erp.extensible_assets_field_unique_values`.execute(trx)).rows[0]!.n,
      definitions: (await sql<{ n: string }>`select count(*)::text as n from platform.extension_field_definitions`.execute(trx)).rows[0]!.n,
    }));
    expect(leaked).toEqual({ values: "0", claims: "0", definitions: "0" });
  });

  test("a tenant field sort pages in two bounded parts: valued rows from the index, then the rest", async () => {
    const tag = randomUUID().slice(0, 8);
    const one = await created(writer, { soort: "kit", accu: 1 }, `P-${tag}`);
    const five = await created(writer, { soort: "batterij", accu: 5 }, `P-${tag}`);
    const tied = [await created(writer, { soort: "batterij", accu: 20 }, `P-${tag}`), await created(writer, { soort: "kit", accu: 20 }, `P-${tag}`)];
    const empty = [await created(writer, { soort: "kit" }, `P-${tag}`), await created(writer, {}, `P-${tag}`), await created(writer, undefined, `P-${tag}`)];
    const scope = { name: `P-${tag}` };
    const byId = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
    const ascending = [one.id, five.id, ...byId(tied), ...byId(empty)];
    const descending = [...byId(tied).reverse(), five.id, one.id, ...byId(empty).reverse()];
    type Page = { items: Array<{ data: { id: string } }>; nextCursor: string | null; totalCount: number | null };
    const page = async (input: Record<string, unknown>) => {
      const result = await list(reader, { includeTotalCount: true, ...input });
      if ("error" in result) throw new Error(JSON.stringify(result.error));
      return result.data as Page;
    };
    /** Every page of one sort, following the cursor, with the page boundaries. */
    const walk = async (direction: string, limit: number, filter: Record<string, unknown> = scope, total = 7) => {
      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const current: Page = await page({ filter, sort: { field: "extensions.accu", direction }, limit, ...(cursor ? { cursor } : {}) });
        pages.push(current.items.map((item) => item.data.id));
        expect(current.totalCount).toBe(total);
        cursor = current.nextCursor;
      } while (cursor);
      return pages;
    };
    // One page holds both parts.
    expect((await walk("asc", 50)).flat()).toEqual(ascending);
    expect((await walk("desc", 50)).flat()).toEqual(descending);
    // Pages of three: the first is all valued, the second crosses the
    // boundary (one valued row, two without), the third starts past every
    // valued row, so its offset into the rest is counted.
    expect(await walk("asc", 3)).toEqual([ascending.slice(0, 3), ascending.slice(3, 6), ascending.slice(6)]);
    expect(await walk("desc", 3)).toEqual([descending.slice(0, 3), descending.slice(3, 6), descending.slice(6)]);
    // A page that ends exactly on the boundary, and one that starts on it.
    expect(await walk("asc", 4)).toEqual([ascending.slice(0, 4), ascending.slice(4)]);
    expect(await walk("desc", 2)).toEqual([0, 2, 4, 6].map((start) => descending.slice(start, start + 2)));
    // An offset beyond the last row is an empty last page.
    const beyond = await page({ filter: scope, sort: { field: "extensions.accu" }, limit: 2, cursor: Buffer.from("40").toString("base64url") });
    expect(beyond).toMatchObject({ items: [], nextCursor: null, totalCount: 7 });
    // The list's filter applies to both parts: tenant field and column predicates alike.
    const kits = [one, tied[1]!, empty[0]!].map((row) => row.id);
    const filtered = await walk("asc", 2, { ...scope, extensions: { soort: { eq: "kit" } } }, 3);
    expect(filtered.flat()).toEqual(ascending.filter((id) => kits.includes(id)));
    // Another tenant's sorted page sees none of it.
    const other = await list(writerB, { filter: scope, sort: { field: "extensions.accu", direction: "asc" } });
    expect("error" in other ? other : ids(other)).toMatchObject({ error: { code: "BAD_USER_INPUT" } });
    // The offset cap is the list's own.
    expect(await list(reader, { filter: scope, sort: { field: "extensions.accu" }, cursor: Buffer.from("100001").toString("base64url") }))
      .toMatchObject({ error: { code: "BAD_USER_INPUT" } });
  });

  test("audit is per key with definition versions, and classified keys never appear raw", async () => {
    const task = await created(writer, { bsn: "999999990", accu: 1, soort: "batterij" }, "Audit");
    await update(writer, task.id, { extensions: { accu: 2, bsn: "111222333" } });
    const events = (await sql<{ event_type: string; payload: Record<string, any> }>`select event_type, payload from platform.entity_events
      where aggregate_id = ${task.id} order by sequence`.execute(fixture.privileged.db)).rows;
    const extension = events.filter((event) => event.event_type === "extensionsChanged");
    expect(extension).toHaveLength(2);
    expect(extension[1]!.payload.audit).toMatchObject({
      entityType: ENTITY,
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
    const referenced = await withDbSession(fixture.app.db, reader, (trx) => executeReferencedBy(trx, reader, ENTITY, { id: target.id }));
    expect(referenced.items.sort((x, y) => x.fieldKey.localeCompare(y.fieldKey))).toEqual([
      { entity: ENTITY, fieldId: fields.links!, fieldKey: "links", label: label("Gekoppeld"), count: 1 },
      { entity: ENTITY, fieldId: fields.parent!, fieldKey: "parent", label: label("Hoofdtaak"), count: 2 },
    ]);
    const other = await withDbSession(fixture.app.db, writerB, (trx) => executeReferencedBy(trx, writerB, ENTITY, { id: target.id }));
    expect(other.items).toEqual([]);
    const outsider = sessionFor(tenantA, ["Nothing.At.All"]);
    expect(await failure(withDbSession(fixture.app.db, outsider, (trx) => executeReferencedBy(trx, outsider, ENTITY, { id: target.id }))))
      .toMatchObject({ code: "FORBIDDEN" });

    // A plain, non-extensible target: its own referencedBy read and the deletion guard.
    const location = await createLocation(writer, "Magazijn");
    expect(await createAsset(writer, { plek: (await createLocation(writerB, "Elders")).id })).toMatchObject({ error: { code: "FORBIDDEN" } });
    await created(writer, { plek: location.id });
    const atLocation = await withDbSession(fixture.app.db, reader, (trx) => executeReferencedBy(trx, reader, TARGET_ENTITY, { id: location.id }));
    expect(atLocation.items).toEqual([{ entity: ENTITY, fieldId: fields.plek!, fieldKey: "plek", label: label("Plek"), count: 1 }]);
    const refused = await executeEntityOperation(fixture.app.db, writer, { operation: { id: `${TARGET_ENTITY}.delete`, intent: "delete" },
      input: { id: location.id, confirmed: true, expectedVersion: String(location.updated_at) } });
    expect(refused).toMatchObject({ error: { code: "OPERATION_REFUSED", message: expect.stringContaining("plek") } });
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
    await sql`insert into erp.extensible_assets_field_values (tenant_id, record_id, field_id, ordinal, value_ref_id)
      values (${tenantA}::uuid, ${source.id}::uuid, ${fields.parent!}::uuid, 1, ${ghost}::uuid)`.execute(fixture.privileged.db);
    const orphans = await withDbSession(fixture.app.db, writer, (trx) => findExtensionReferenceOrphans(trx, writer));
    expect(orphans).toEqual([{ entity: ENTITY, fieldKey: "parent", recordId: source.id, targetEntity: ENTITY, targetId: ghost }]);
    expect(await withDbSession(fixture.app.db, writerB, (trx) => findExtensionReferenceOrphans(trx, writerB))).toEqual([]);
    await sql`delete from erp.extensible_assets_field_values where value_ref_id = ${ghost}::uuid`.execute(fixture.privileged.db);
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
    // The worker holds no MAINTAIN: the planner statistics of the index
    // follow autovacuum's ANALYZE, not the backfill.
    const maintain = await sql<{ index: boolean; entity: boolean }>`select
        has_table_privilege('openshapeforge_worker', 'erp.extensible_assets_field_values', 'MAINTAIN') as index,
        has_table_privilege('openshapeforge_worker', 'erp.extensible_assets', 'MAINTAIN') as entity`.execute(fixture.privileged.db);
    expect(maintain.rows[0]).toEqual({ index: false, entity: false });

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
    // Without duplicates, unique is switched on by a backfill that claims every
    // value. (Not on stuks: a create stores its default, so 1 is everywhere.)
    const claimed = (await sql<{ id: string }>`select record_id::text as id from erp.extensible_assets_field_values
      where field_id = ${fields.plek!}::uuid`.execute(fixture.privileged.db)).rows;
    expect(claimed).toHaveLength(1);
    const unique = await define(manager, "update", { fieldId: fields.plek, definition: { osfType: TARGET_ENTITY, label: label("Plek"),
      onDelete: "restrict", unique: true, classification: { sensitivity: "public" } } }) as { state: string; backfill?: { state: string } };
    expect(unique).toMatchObject({ state: "updating", backfill: { state: "queued" } });
    await drainJobs();
    const claims = await sql<{ record_id: string; value_text: string }>`select record_id::text, value_text from erp.extensible_assets_field_unique_values
      where field_id = ${fields.plek!}::uuid`.execute(fixture.privileged.db);
    expect(claims.rows.map((row) => row.record_id)).toEqual([claimed[0]!.id]);
    expect(await createAsset(writer, { plek: claims.rows[0]!.value_text })).toMatchObject({ error: { code: "CONFLICT" } });
  });

  test("lifecycle: deprecate, restore and delete with a confirmed, resumable, idempotent backfill", async () => {
    const records = [await created(writer, { bsn: "1" }), await created(writer, { bsn: "2" }), await created(writer, { bsn: "3" })];
    expect(await failure(define(manager, "delete", { fieldId: fields.bsn, confirmAffectedRecords: 0 }))).toMatchObject({ message: expect.stringContaining("deprecated") });
    await define(manager, "deprecate", { fieldId: fields.bsn });
    expect(await createAsset(writer, { bsn: "4" })).toMatchObject({ error: { violations: [expect.objectContaining({ code: "DEPRECATED_FIELD" })] } });
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
    const remaining = await sql<{ n: string }>`select count(*)::text as n from erp.extensible_assets where extension_values ? ${fields.bsn!}`.execute(fixture.privileged.db);
    expect(remaining.rows[0]!.n).toBe("0");
    expect(await sql`select 1 from erp.extensible_assets_field_values where field_id = ${fields.bsn!}::uuid`.execute(fixture.privileged.db).then((r) => r.rows)).toEqual([]);
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
    await sql`update erp.extensible_assets set created_at = now() - interval '40 days' where id = ${old.id}::uuid`.execute(fixture.privileged.db);
    const result = await withDbSession(fixture.worker.db, manager, (trx) => applyExtensionRetention(trx, manager, ENTITY));
    expect(result.cleared).toBeGreaterThanOrEqual(1);
    expect((await get(writer, old.id))!.extensions.sku).toBeNull();
    expect((await get(writer, fresh.id))!.extensions.sku).toBe("R-new");
    expect(await indexRows(old.id, field.fieldId)).toEqual([]);
    expect((await sql`select 1 from erp.extensible_assets_field_unique_values where record_id = ${old.id}::uuid`.execute(fixture.privileged.db)).rows).toEqual([]);
  });

  test("MCP: the listed schema and the dispatch agree on this tenant's fields", async () => {
    expect(hasExtensibleEntities()).toBe(true);
    await primeSessionExtensions(fixture.app.db, writer);
    const tool = (operation: string) => catalog.tools.find((candidate) => candidate.entity === ENTITY && candidate.operation === operation)!;
    const listTool = tool("list");
    const described = describeTool(listTool, undefined, fixture.table, writer) as unknown as { inputSchema: { properties: Record<string, any> } };
    expect(Object.keys(described.inputSchema.properties.filter.properties.extensions.properties)).toContain("accu");
    expect(described.inputSchema.properties.filter.properties.extensions.properties.bsn).toBeUndefined();
    expect(described.inputSchema.properties.sortField.enum).toContain("extensions.accu");
    expect(described.inputSchema.properties.sortField.enum).not.toContain("extensions.links");
    // The raw source column is no field of the compiled tools, statically or per session.
    for (const operation of ["list", "get", "create", "update", "delete"]) expect(JSON.stringify(tool(operation))).not.toContain("extensionValues");
    expect(JSON.stringify(described)).not.toContain("extensionValues");
    // Tenant B has no fields: its schema is the static one.
    await primeSessionExtensions(fixture.app.db, writerB);
    const other = describeTool(listTool, undefined, fixture.table, writerB) as unknown as { inputSchema: { properties: Record<string, any> } };
    expect(other.inputSchema.properties.filter.properties.extensions.properties).toEqual({});

    // The compiled create tool carries `extensions` as an open object; the session closes and types it.
    const createTool = tool("create");
    expect((createTool.inputSchema as { properties: Record<string, any> }).properties.extensions).toMatchObject({ type: "object", additionalProperties: true });
    const enriched = withExtensionTool(createTool, fixture.table, writer);
    const extensions = (enriched.inputSchema as { properties: Record<string, any> }).properties.extensions;
    expect(extensions).toMatchObject({ additionalProperties: false });
    expect(extensions.properties.accu).toMatchObject({ type: ["number", "string"] });
    expect(extensions.properties.soort.enum).toEqual(["batterij", "kit"]);
    const tables = new Map([[fixture.table.name, fixture.table]]);
    await expect(invokeTool(enriched, undefined, fixture.table, tables, fixture.app.db, writer, { name: "MCP", extensions: { kleur: "rood" } }))
      .rejects.toThrow("tenant field values do not satisfy their definitions");
    await expect(invokeTool(enriched, undefined, fixture.table, tables, fixture.app.db, writer, { name: "MCP", extensionValues: {} }))
      .rejects.toMatchObject({ code: "BAD_USER_INPUT" });
    const args = { name: "MCP", extensions: { soort: "kit", stuks: 4 } };
    const created = await invokeTool(enriched, undefined, fixture.table, tables, fixture.app.db, writer, args) as unknown as { structuredContent?: { data: Record<string, unknown> & { extensions: Record<string, unknown> } } };
    expect(created.structuredContent?.data.extensions).toMatchObject({ soort: "kit", stuks: 4 });
    expect(created.structuredContent?.data.extensionValues).toBeUndefined();
    const listed = await invokeTool(withExtensionTool(listTool, fixture.table, writer), undefined, fixture.table, tables, fixture.app.db, writer,
      { filter: { name: "MCP", extensions: { stuks: { eq: 4 } } }, sortField: "extensions.stuks" }) as unknown as { structuredContent?: { data: { items: unknown[] } } };
    expect(listed.structuredContent?.data.items).toHaveLength(1);
    expect(JSON.stringify(listed.structuredContent)).not.toContain("extensionValues");
  });

  test("GraphQL: the type, inputs and filter carry extensions as JSON, never the source column", () => {
    const sdl = renderTypeDefinition(fixture.table);
    expect(sdl).toMatch(/type ExtensibleAsset \{[\s\S]*extensions: JSON[\s\S]*extensionsMeta: JSON/);
    expect(sdl).toMatch(/input ExtensibleAssetFilter \{[\s\S]*extensions: JSON/);
    expect(sdl).toMatch(/input CreateExtensibleAssetInput \{[\s\S]*extensions: JSON/);
    expect(sdl).toMatch(/input UpdateExtensibleAssetInput \{[\s\S]*extensions: JSON/);
    expect(sdl).not.toContain("extensionValues");
    expect(sdl).not.toContain("extension_values");
  });

  test("the compiled Operations dispatch to the native handler and notify MCP of a change", async () => {
    // The contracts packages/compiler/src/extension-operations.ts emitted into this manifest.
    const compiled = (rawCatalog as unknown as { operations: OperationContract[] }).operations;
    const contract = (key: string) => compiled.find((operation) => operation.key === key)!;
    const own = compiled.filter((operation) => operation.plugin === "osf-extensions");
    expect(own.filter((operation) => operation.target?.entityName === ENTITY).map((operation) => operation.key).sort()).toEqual([
      ...["affectedRecords", "create", "delete", "deprecate", "list", "rebuildIndex", "reorder", "restore", "update"].map((action) => `${ENTITY}.fieldDefinitions.${action}`),
      `${ENTITY}.referencedBy`,
    ]);
    expect(contract(`${TARGET_ENTITY}.referencedBy`)).toMatchObject({ handler: "referencedBy", target: { entityName: TARGET_ENTITY } });
    const bound = bindOperationHandlers([], own, { pluginOperations: "absent" });
    expect([...bound.keys()].sort()).toEqual(own.map((operation) => operation.key).sort());
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
    const create = bound.get(`${ENTITY}.fieldDefinitions.create`)!;
    const result = await invokeOperation(create, {
      key: "viaRest", definition: { osfType: "boolean", classification: { sensitivity: "public" } },
    }, { db: fixture.app.db, platform: platform.services, transport: "rest", session: manager as never });
    expect(result).toMatchObject({ value: { key: "viaRest", state: "ready" } });
    await Promise.resolve();
    expect(calls).toEqual(["a"]);
    await expect(invokeOperation(create, { key: "nope", definition: {} },
      { db: fixture.app.db, platform: platform.services, transport: "rest", session: writer as never })).rejects.toBeDefined();
    expect(() => bindOperationHandlers([], [{ ...contract(`${ENTITY}.fieldDefinitions.create`), effects: { data: "read", external: "none" } } as OperationContract], { pluginOperations: "absent" }))
      .toThrow(/unsupported or incomplete binding/);
  });
});
