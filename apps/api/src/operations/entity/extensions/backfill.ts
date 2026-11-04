// SPDX-License-Identifier: BUSL-1.1
/**
 * Backfills: every definition change that touches records runs as a
 * job in `platform.jobs`, one batch per job run. A run processes the next
 * batch after the cursor, records its progress in
 * `platform.extension_field_backfills` and enqueues the next run in the same
 * transaction — so progress is visible between batches, a crash resumes at
 * the last committed cursor, and every step is idempotent per record (the
 * index is rewritten from the source; stripping a key twice strips nothing).
 * When the last batch is done the field leaves `updating`; a backfill that
 * fails never leaves it there (a unique backfill that meets a duplicate
 * turns unique off again, and a field in `updating` can always be
 * deprecated and deleted).
 *
 * Every batch reads and writes the records of the whole tenant under an
 * audited bypass: the index inherits the entity's row
 * policies, and an erasure, a rebuild or a uniqueness claim that saw only the
 * rows its starter may see would leave the rest behind. Each statement still
 * names the tenant. A batch shares the tenant field lock before it locks a
 * record, like every writer (store.ts).
 *
 * Worker rights: the job runs under the worker role, replaying the session
 * that started the change. The worker holds DML on the side tables, SELECT,
 * INSERT (the version that turns unique off again) and UPDATE of `state` and
 * `is_current` on the definitions, SELECT and UPDATE of the progress columns
 * of the backfills, INSERT on the bypass audit, and SELECT plus UPDATE of
 * `extension_values`, `updated_at` and a versioned head's lifecycle column on
 * the entity table (db/migrations/worker-role.ts, `extensionWorkerGrants`) —
 * nothing else. No MAINTAIN: the planner statistics of the index follow
 * autovacuum's ANALYZE.
 */
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../../generated/db/types.js";
import { withTenantBypassInTransaction, type DbSessionInput } from "../../../db/session.js";
import { jsonbLiteral } from "../../../db/sql-helpers.js";
import { enqueueJob } from "../../../jobs/store.js";
import { actorSessionOf, type JobActorCredential, type JobActorSession } from "../../../jobs/actor-session.js";
import type { ModuleJobHandler } from "../../../modules/contract.js";
import { getGeneratedCrudTables } from "../catalog.js";
import { sqlstateOf } from "../transition-lock-retry.js";
import type { GeneratedCrudTable } from "../types.js";
import {
  EXTENSION_META_KEY,
  extensionError,
  extensionShape,
  indexColumnRef,
  isClassified,
  normalizedUnique,
  typedOperand,
  uniqueOperand,
  type ExtensionField,
  type ExtensionFieldSet,
} from "./model.js";
import { extensionRegistry } from "./registry.js";
import { formulaGraph } from "./formulas.js";
import { announceFieldDefinitionChange, forgetExtensionFields, insertFieldVersion, loadExtensionFieldsFor } from "./store.js";
import { qualifiedTable, recomputeRecordFormulas, rewriteExtensionValues } from "./write.js";
import { storedExtensionSource } from "./read.js";

export const EXTENSION_BACKFILL_KIND = "extensions.backfill";
export const EXTENSION_RETENTION_KIND = "extensions.retention";
export type BackfillOperation = "retype" | "delete" | "unique" | "rebuild" | "formula" | "lookup" | "rollup";
/** A backfill that computes a field (and what reads it) on every record, rather than rewriting stored values. */
const COMPUTING: ReadonlySet<BackfillOperation> = new Set(["formula", "lookup", "rollup"]);
export const BACKFILL_BATCH_SIZE = 500;

const isDeadlock = (error: unknown) => sqlstateOf(error) === "40P01";

export type BackfillRow = {
  id: string; entity: string; field_id: string; definition_version: number; operation: BackfillOperation;
  state: "queued" | "running" | "done" | "failed"; processed: number; total: number; cursor: string | null; error: unknown;
};

/** The session a queued run replays: the verified one that started the change. */
export function jobActorSession(session: DbSessionInput & { credential?: string; oauthScopes?: readonly string[] }): JobActorSession {
  const credential = (["bearer", "api-key", "trusted-context"].includes(session.credential ?? "")
    ? session.credential : "trusted-context") as JobActorCredential;
  return actorSessionOf({
    credential,
    roles: [...session.roles ?? []],
    groups: [...session.groups ?? []],
    relationGroupIds: [...session.relationGroupIds ?? []],
    scope: session.scope ?? "tenant",
    ...(session.oauthScopes ? { oauthScopes: session.oauthScopes } : {}),
  });
}

/** The tenant session a queued run works under: what it enqueues further carries the same credential. */
export function jobSession(tenantId: string, userId: string, actorSession: JobActorSession): DbSessionInput {
  const { roles, groups, relationGroupIds, scope, credential, oauthScopes } = actorSession;
  return { tenantId, userId, roles, groups, relationGroupIds, scope, credential, ...(oauthScopes ? { oauthScopes } : {}) } as DbSessionInput;
}

/** Run maintenance over every record of the session's tenant (see the module comment). */
export function acrossTenant<T>(trx: Transaction<DB>, session: DbSessionInput, reason: string, work: () => Promise<T>): Promise<T> {
  return withTenantBypassInTransaction(trx, { tenantId: session.tenantId!, actorSubject: session.userId ?? "system", reason }, work);
}

function entityTable(entity: string): GeneratedCrudTable {
  const tables = getGeneratedCrudTables().filter((table) => table.source?.authoringEntityName === entity && !table.subtype);
  if (tables.length !== 1) extensionError(`Extensible entity ${entity} has no unambiguous table.`, "INVALID_DEFINITION");
  return tables[0]!;
}

/** Records of the tenant holding a value of the field, counted across the tenant. */
export async function recordsWithField(trx: Transaction<DB>, session: DbSessionInput, entity: string, fieldId: string): Promise<number> {
  const entry = extensionRegistry.entity(entity)!;
  return acrossTenant(trx, session, `count records holding tenant field ${fieldId} of ${entity}`, async () => {
    const total = await sql<{ total: string }>`select count(*)::text as total from ${qualifiedTable(entry.table)}
      where tenant_id = ${session.tenantId}::uuid and extension_values ? ${fieldId}`.execute(trx);
    return Number(total.rows[0]?.total ?? 0);
  });
}

/** Every record of the tenant, counted across the tenant: what a formula backfill computes. */
async function recordsOfTenant(trx: Transaction<DB>, session: DbSessionInput, entity: string): Promise<number> {
  const entry = extensionRegistry.entity(entity)!;
  return acrossTenant(trx, session, `count records of ${entity} for a formula`, async () => {
    const total = await sql<{ total: string }>`select count(*)::text as total from ${qualifiedTable(entry.table)}
      where tenant_id = ${session.tenantId}::uuid`.execute(trx);
    return Number(total.rows[0]?.total ?? 0);
  });
}

/** Start a backfill for one field version, inside the definition change's transaction. */
export async function startBackfill(
  trx: Transaction<DB>,
  session: DbSessionInput,
  input: { entity: string; field: ExtensionField; operation: BackfillOperation },
): Promise<BackfillRow> {
  const total = COMPUTING.has(input.operation)
    ? await recordsOfTenant(trx, session, input.entity)
    : await recordsWithField(trx, session, input.entity, input.field.fieldId);
  const id = randomUUID();
  const row = await sql<BackfillRow>`insert into platform.extension_field_backfills
      (tenant_id, id, entity, field_id, definition_version, operation, state, processed, total, cursor, error, created_at, updated_at)
    values (${session.tenantId}::uuid, ${id}::uuid, ${input.entity}, ${input.field.fieldId}::uuid, ${input.field.version},
      ${input.operation}, 'queued', 0, ${total}, null, null, now(), now())
    returning id, entity, field_id, definition_version, operation, state, processed, total, cursor, error`.execute(trx);
  await enqueueBackfillRun(trx, session.tenantId!, session.userId!, jobActorSession(session), id, null);
  await announceFieldDefinitionChange(trx, session.tenantId!, input.entity, input.field.fieldId, "updated");
  return row.rows[0]!;
}

async function enqueueBackfillRun(
  trx: Transaction<DB>,
  tenantId: string,
  actorId: string,
  actorSession: JobActorSession,
  backfillId: string,
  cursor: string | null,
): Promise<void> {
  await enqueueJob(trx, {
    tenantId, actorId, actorSession, kind: EXTENSION_BACKFILL_KIND,
    payload: { backfillId },
    deliveryKey: `${backfillId}:${cursor ?? "start"}`,
    subject: { entity: "ExtensionFieldBackfill", id: backfillId },
  });
}

/** The latest backfill of each field of one entity, for FieldDefinitionRecord.backfill. */
export async function latestBackfills(
  trx: Transaction<DB>,
  tenantId: string,
  entity: string,
): Promise<Map<string, BackfillRow>> {
  const rows = await sql<BackfillRow>`select distinct on (field_id)
      id, entity, field_id, definition_version, operation, state, processed, total, cursor, error
    from platform.extension_field_backfills
    where tenant_id = ${tenantId}::uuid and entity = ${entity}
    order by field_id, created_at desc, id desc`.execute(trx);
  return new Map(rows.rows.map((row) => [row.field_id, row]));
}

async function failBackfill(trx: Transaction<DB>, tenantId: string, row: BackfillRow, error: Record<string, unknown>) {
  await sql`update platform.extension_field_backfills set state = 'failed', error = ${jsonbLiteral(error)}, updated_at = now()
    where tenant_id = ${tenantId}::uuid and id = ${row.id}::uuid`.execute(trx);
  await announceFieldDefinitionChange(trx, tenantId, row.entity, row.field_id, "updated");
}

/**
 * Claim one record's value of a unique field; false when another record
 * holds the same value (normalized, model.ts `normalizedUnique`).
 */
async function claimValue(trx: Transaction<DB>, tenantId: string, set: ExtensionFieldSet, field: ExtensionField, recordId: string, value: unknown): Promise<boolean> {
  const operand = uniqueOperand(extensionShape(set.entry, field.definition), value);
  if (operand === null) return true;
  const table = qualifiedTable(set.entry.uniqueTable);
  const claimed = await sql<{ record_id: string }>`insert into ${table} (tenant_id, field_id, value_text, record_id)
    values (${tenantId}::uuid, ${field.fieldId}::uuid, ${normalizedUnique(operand.column, typedOperand(operand.column, operand.value))}, ${recordId}::uuid)
    on conflict (tenant_id, field_id, value_text) do update set record_id = ${table}.record_id
    returning record_id`.execute(trx);
  return claimed.rows[0]?.record_id === recordId;
}

/**
 * The duplicates of one field, normalized as uniqueness compares them: how
 * many values more than one record holds, and up to 20 of them when the
 * caller may show them (never for a classified field). Counts what the
 * transaction sees: under acrossTenant the whole tenant.
 */
export async function duplicateValues(
  trx: Transaction<DB>,
  tenantId: string,
  set: ExtensionFieldSet,
  field: ExtensionField,
  withExamples: boolean,
): Promise<{ count: number; examples: Array<{ value: string; count: number }> }> {
  const shape = extensionShape(set.entry, field.definition);
  const column = indexColumnRef(shape.column);
  const result = await sql<{ value: string; count: string; total: string }>`
    select value, count::text as count, (count(*) over ())::text as total from (
      select ${normalizedUnique(shape.column, column)} as value, count(*) as count from ${qualifiedTable(set.entry.valuesTable)}
      where tenant_id = ${tenantId}::uuid and field_id = ${field.fieldId}::uuid and ordinal = 0 and ${column} is not null
      group by 1 having count(*) > 1) as duplicates
    order by value limit 20`.execute(trx);
  return {
    count: Number(result.rows[0]?.total ?? 0),
    examples: withExamples && !isClassified(field.definition) ? result.rows.map((row) => ({ value: row.value, count: Number(row.count) })) : [],
  };
}

/**
 * A unique field whose values are not unique after all:
 * unique goes off again as a new version, `ready`, and the claims of the
 * attempt are released. The backfill fails with the number of duplicates,
 * and, for a field that is not classified, which ones.
 */
async function abandonUnique(
  trx: Transaction<DB>,
  session: DbSessionInput,
  row: BackfillRow,
  set: ExtensionFieldSet,
  field: ExtensionField,
): Promise<void> {
  const tenantId = session.tenantId!;
  const duplicates = await duplicateValues(trx, tenantId, set, field, true);
  const count = Math.max(duplicates.count, 1);
  const { unique: _unique, ...definition } = field.definition;
  await insertFieldVersion(trx, session, row.entity, { ...field, version: field.version + 1, definition, state: "ready" });
  await sql`delete from ${qualifiedTable(set.entry.uniqueTable)}
    where tenant_id = ${tenantId}::uuid and field_id = ${field.fieldId}::uuid`.execute(trx);
  await failBackfill(trx, tenantId, row, {
    code: "DUPLICATE_VALUE",
    message: `${field.key} cannot be unique: ${count} value(s) are used by more than one record; unique is off again.`,
    duplicates: count,
    ...(duplicates.examples.length ? { values: duplicates.examples } : {}),
  });
}

/** Index rows and claims of records whose source no longer carries the field. */
async function removeOrphanIndexRows(trx: Transaction<DB>, tenantId: string, set: ExtensionFieldSet, fieldId: string): Promise<void> {
  for (const side of [set.entry.valuesTable, set.entry.uniqueTable]) {
    await sql`delete from ${qualifiedTable(side)} as side
      where side.tenant_id = ${tenantId}::uuid and side.field_id = ${fieldId}::uuid
        and not exists (select 1 from ${qualifiedTable(set.entry.table)} as source
          where source.tenant_id = side.tenant_id and source.id = side.record_id and source.extension_values ? ${fieldId})`.execute(trx);
  }
}

/**
 * One batch of one backfill. Exported for tests and for an operator who runs
 * a backfill by hand; the job handler below is the normal caller.
 */
export async function runBackfillBatch(
  trx: Transaction<DB>,
  session: DbSessionInput,
  backfillId: string,
  batchSize = BACKFILL_BATCH_SIZE,
): Promise<{ state: BackfillRow["state"]; processed: number; cursor: string | null; more: boolean }> {
  const tenantId = session.tenantId!;
  const locked = await sql<BackfillRow>`select id, entity, field_id, definition_version, operation, state, processed, total, cursor, error
    from platform.extension_field_backfills where tenant_id = ${tenantId}::uuid and id = ${backfillId}::uuid for update`.execute(trx);
  const row = locked.rows[0];
  if (!row) extensionError("The backfill does not exist.", "NOT_FOUND");
  if (row!.state === "done" || row!.state === "failed") return { state: row!.state, processed: row!.processed, cursor: row!.cursor, more: false };
  const entry = extensionRegistry.entity(row!.entity);
  if (!entry) extensionError("The backfill's entity is not extensible.", "INVALID_DEFINITION");
  // Shared, before any record lock: writers of the entity do the same.
  const set = await loadExtensionFieldsFor(trx, session, row!.entity, entry!, { lock: "shared" });
  const field = set.byId.get(row!.field_id);
  if (!field) extensionError("The backfill's field does not exist.", "INVALID_DEFINITION");
  // A retype, unique or formula backfill works for one version; a later
  // version (a deprecation, unique turned off again, another formula)
  // supersedes it.
  if ((row!.operation === "retype" || row!.operation === "unique" || COMPUTING.has(row!.operation)) && field!.version !== Number(row!.definition_version)) {
    await failBackfill(trx, tenantId, row!, { code: "SUPERSEDED", message: `${field!.key} changed while this backfill ran.` });
    return { state: "failed", processed: row!.processed, cursor: row!.cursor, more: false };
  }
  const table = entityTable(row!.entity);
  if (COMPUTING.has(row!.operation)) return runFormulaBatch(trx, session, { row: row!, set, field: field!, table, batchSize });
  return acrossTenant(trx, session, `tenant field ${row!.operation} backfill ${row!.id}`, async () => {
    const records = await sql<{ id: string; extension_values: unknown }>`
      select id, extension_values from ${qualifiedTable(entry!.table)}
      where tenant_id = ${tenantId}::uuid and extension_values ? ${field!.fieldId}
        ${row!.cursor ? sql`and id > ${row!.cursor}::uuid` : sql``}
      order by id limit ${batchSize} for no key update`.execute(trx);
    for (const record of records.rows) {
      const source = storedExtensionSource(record);
      switch (row!.operation) {
        case "retype":
          // The value stays; its index rows follow the new type. Claims are the unique backfill's.
          await rewriteExtensionValues(trx, session, { table, set, recordId: record.id, before: source, after: source, fields: [field!], claims: false, draft: false });
          break;
        case "rebuild":
        case "unique": {
          if (row!.operation === "rebuild") {
            await rewriteExtensionValues(trx, session, { table, set, recordId: record.id, before: source, after: source, fields: [field!], claims: false, draft: false });
            if (field!.definition.unique !== true) break;
            await sql`delete from ${qualifiedTable(entry!.uniqueTable)}
              where tenant_id = ${tenantId}::uuid and field_id = ${field!.fieldId}::uuid and record_id = ${record.id}::uuid`.execute(trx);
          }
          if (!await claimValue(trx, tenantId, set, field!, record.id, source[field!.fieldId])) {
            await abandonUnique(trx, session, row!, set, field!);
            return { state: "failed" as const, processed: row!.processed, cursor: row!.cursor, more: false };
          }
          break;
        }
        case "delete": {
          const after = { ...source };
          delete after[field!.fieldId];
          // A computed field's error code goes with its value.
          const meta = after[EXTENSION_META_KEY];
          if (meta && typeof meta === "object" && !Array.isArray(meta) && Object.hasOwn(meta, field!.fieldId)) {
            const { [field!.fieldId]: _gone, ...rest } = meta as Record<string, unknown>;
            if (Object.keys(rest).length) after[EXTENSION_META_KEY] = rest; else delete after[EXTENSION_META_KEY];
          }
          await rewriteExtensionValues(trx, session, { table, set, recordId: record.id, before: source, after, fields: [field!] });
          break;
        }
      }
    }
    const processed = row!.processed + records.rows.length;
    // A delete strips the key, so the next batch starts at the first record
    // that still carries it; every other operation moves past what it did.
    const cursor = row!.operation === "delete" ? null : records.rows.at(-1)?.id ?? row!.cursor;
    const more = records.rows.length === batchSize;
    if (!more) {
      if (row!.operation === "delete") {
        // Index rows and claims of records whose source no longer carried the key.
        await sql`delete from ${qualifiedTable(entry!.valuesTable)} where tenant_id = ${tenantId}::uuid and field_id = ${field!.fieldId}::uuid`.execute(trx);
        await sql`delete from ${qualifiedTable(entry!.uniqueTable)} where tenant_id = ${tenantId}::uuid and field_id = ${field!.fieldId}::uuid`.execute(trx);
      } else {
        await removeOrphanIndexRows(trx, tenantId, set, field!.fieldId);
        if (field!.state === "updating") {
          await sql`update platform.extension_field_definitions set state = 'ready'
            where tenant_id = ${tenantId}::uuid and id = ${field!.rowId}::uuid and state = 'updating'`.execute(trx);
          forgetExtensionFields(trx, tenantId, row!.entity);
        }
      }
    }
    await sql`update platform.extension_field_backfills
      set state = ${more ? "running" : "done"}, processed = ${processed}, cursor = ${cursor}, updated_at = now()
      where tenant_id = ${tenantId}::uuid and id = ${row!.id}::uuid`.execute(trx);
    await announceFieldDefinitionChange(trx, tenantId, row!.entity, row!.field_id, "updated");
    return { state: more ? "running" as const : "done" as const, processed, cursor, more };
  });
}

/**
 * One batch of a formula backfill: every record of the tenant after the
 * cursor, in id order, recomputes the field and every formula that reads
 * it, and its index is rewritten from the result (idempotent per record).
 * A record whose formula gives an error code is computed like any other: the
 * code is its value (null, `$meta[fieldId].error`), and the batch goes on.
 * Only a database failure fails the batch: it is rolled back to before its
 * first record and the field is `suspended` — never left `updating` — with
 * the backfill failed and the reason in its error. Records of earlier
 * batches already hold the new generation, the rest the old one, so readers
 * see `extensionsMeta.<key>.suspended` and a query refuses the field; saving
 * the formula again or `rebuildIndex` starts a new backfill.
 */
async function runFormulaBatch(
  trx: Transaction<DB>,
  session: DbSessionInput,
  input: { row: BackfillRow; set: ExtensionFieldSet; field: ExtensionField; table: GeneratedCrudTable; batchSize: number },
): Promise<{ state: BackfillRow["state"]; processed: number; cursor: string | null; more: boolean }> {
  const { row, set, field, table, batchSize } = input;
  const tenantId = session.tenantId!;
  const fields = [field, ...formulaGraph(set).affectedBy([{ entity: set.entity, field: field.fieldId }])];
  return acrossTenant(trx, session, `tenant field formula backfill ${row.id}`, async () => {
    await sql`savepoint formula_backfill_batch`.execute(trx);
    try {
      const records = await sql<{ id: string }>`select id from ${sql.id(table.schema, table.table)}
        where tenant_id = ${tenantId}::uuid ${row.cursor ? sql`and id > ${row.cursor}::uuid` : sql``}
        order by id limit ${batchSize}`.execute(trx);
      for (const record of records.rows) {
        // A definition change: a published head stays published (rewriteExtensionValues).
        await recomputeRecordFormulas(trx, session, { table, set, recordId: record.id, fields, rebuild: true, draft: false });
      }
      const processed = row.processed + records.rows.length;
      const cursor = records.rows.at(-1)?.id ?? row.cursor;
      const more = records.rows.length === batchSize;
      if (!more && field.state === "updating") {
        await sql`update platform.extension_field_definitions set state = 'ready'
          where tenant_id = ${tenantId}::uuid and id = ${field.rowId}::uuid and state = 'updating'`.execute(trx);
        forgetExtensionFields(trx, tenantId, row.entity);
      }
      await sql`update platform.extension_field_backfills
        set state = ${more ? "running" : "done"}, processed = ${processed}, cursor = ${cursor}, updated_at = now()
        where tenant_id = ${tenantId}::uuid and id = ${row.id}::uuid`.execute(trx);
      await sql`release savepoint formula_backfill_batch`.execute(trx);
      await announceFieldDefinitionChange(trx, tenantId, row.entity, row.field_id, "updated");
      return { state: more ? "running" as const : "done" as const, processed, cursor, more };
    } catch (error) {
      // The reason stays out of the backfill row: a database message may
      // quote values of records the designer cannot read.
      await sql`rollback to savepoint formula_backfill_batch`.execute(trx);
      // Another transaction was in the way, not this record: the job runs the batch again.
      if (isDeadlock(error)) throw error;
      await sql`update platform.extension_field_definitions set state = 'suspended', suspended_reason = 'FORMULA_BACKFILL_FAILED'
        where tenant_id = ${tenantId}::uuid and id = ${field.rowId}::uuid and state in ('updating', 'ready')`.execute(trx);
      forgetExtensionFields(trx, tenantId, row.entity);
      await failBackfill(trx, tenantId, row, {
        code: "FORMULA_BACKFILL_FAILED",
        message: `${field.key} could not be computed for every record and is suspended; save the ${field.kind} again or rebuild its index to resume.`,
      });
      return { state: "failed" as const, processed: row.processed, cursor: row.cursor, more: false };
    }
  });
}

/** The `extensions.backfill` job: one batch per run, the next run enqueued with it. */
export const extensionBackfillJobHandler: ModuleJobHandler = async (payload, context) => {
  const backfillId = typeof payload.backfillId === "string" ? payload.backfillId : undefined;
  if (!backfillId) return { outcome: "failed", error: { code: "INVALID_PAYLOAD", message: "A backfill job names its backfill." } };
  const job = await sql<{ actor_session: unknown }>`select actor_session from platform.jobs
    where tenant_id = ${context.job.tenantId}::uuid and id = ${context.job.id}::uuid`.execute(context.db);
  const actorSession = actorSessionOf(job.rows[0]?.actor_session as JobActorSession);
  const session = jobSession(context.job.tenantId, context.job.actorId, actorSession);
  await sql`savepoint extension_backfill_batch`.execute(context.db);
  try {
    const result = await runBackfillBatch(context.db, session, backfillId);
    if (result.more) {
      await enqueueBackfillRun(context.db, context.job.tenantId, context.job.actorId, actorSession, backfillId, result.cursor ?? `after-${result.processed}`);
    }
    await sql`release savepoint extension_backfill_batch`.execute(context.db);
    return { outcome: "done", result: { state: result.state, processed: result.processed } };
  } catch (error) {
    if (!isDeadlock(error)) throw error;
    await sql`rollback to savepoint extension_backfill_batch`.execute(context.db);
    return { outcome: "retry", error: { code: "40P01", message: "A backfill batch met a deadlock; it runs again." } };
  }
};

/**
 * Retention, the minimal path: a field whose definition carries
 * `retention: { days, from?: "createdAt" | "updatedAt" }` loses its value
 * (source and index together, through the one internal write) on records
 * whose clock is older than that — every record of the tenant, under the
 * audited bypass. There is no record retention worker in this runtime to
 * extend per jsonb key, so the sweep is a per-(tenant, entity) job that
 * reschedules itself daily while any field still declares retention.
 */
export async function applyExtensionRetention(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
): Promise<{ cleared: number; retained: boolean }> {
  const entry = extensionRegistry.entity(entity);
  if (!entry) extensionError("The entity is not extensible.", "INVALID_DEFINITION");
  const set = await loadExtensionFieldsFor(trx, session, entity, entry!, { lock: "shared" });
  const table = entityTable(entity);
  let cleared = 0;
  let retained = false;
  await acrossTenant(trx, session, `tenant field retention of ${entity}`, async () => {
    for (const field of set.fields) {
      const retention = field.definition.retention as { days?: unknown; from?: unknown } | undefined;
      if (field.state === "deleted" || !retention || !Number.isInteger(retention.days)) continue;
      retained = true;
      const clock = retention.from === "updatedAt" ? "updated_at" : "created_at";
      const expired = await sql<{ id: string; extension_values: unknown }>`select id, extension_values from ${qualifiedTable(entry!.table)}
        where tenant_id = ${session.tenantId}::uuid and extension_values ? ${field.fieldId}
          and ${sql.ref(clock)} < now() - make_interval(days => ${retention.days as number})
        order by id for no key update`.execute(trx);
      for (const record of expired.rows) {
        const before = storedExtensionSource(record);
        const after = { ...before };
        delete after[field.fieldId];
        await rewriteExtensionValues(trx, session, { table, set, recordId: record.id, before, after, fields: [field] });
      }
      cleared += expired.rows.length;
    }
  });
  return { cleared, retained };
}

export async function scheduleExtensionRetention(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
  actorSession: JobActorSession = jobActorSession(session),
  actorId = session.userId!,
  delayDays = 0,
): Promise<void> {
  const day = new Date(Date.now() + delayDays * 86_400_000).toISOString().slice(0, 10);
  await enqueueJob(trx, {
    tenantId: session.tenantId!, actorId, actorSession, kind: EXTENSION_RETENTION_KIND,
    payload: { entity }, deliveryKey: `${entity}:${day}`,
    ...(delayDays ? { availableAt: new Date(`${day}T03:00:00.000Z`) } : {}),
  });
}

export const extensionRetentionJobHandler: ModuleJobHandler = async (payload, context) => {
  const entity = typeof payload.entity === "string" ? payload.entity : undefined;
  if (!entity || !extensionRegistry.entity(entity)) return { outcome: "failed", error: { code: "INVALID_PAYLOAD", message: "A retention job names an extensible entity." } };
  const job = await sql<{ actor_session: unknown }>`select actor_session from platform.jobs
    where tenant_id = ${context.job.tenantId}::uuid and id = ${context.job.id}::uuid`.execute(context.db);
  const actorSession = actorSessionOf(job.rows[0]?.actor_session as JobActorSession);
  const session: DbSessionInput = { tenantId: context.job.tenantId, userId: context.job.actorId, roles: actorSession.roles, scope: actorSession.scope };
  const result = await applyExtensionRetention(context.db, session, entity);
  if (result.retained) await scheduleExtensionRetention(context.db, session, entity, actorSession, context.job.actorId, 1);
  return { outcome: "done", result: { cleared: result.cleared } };
};
