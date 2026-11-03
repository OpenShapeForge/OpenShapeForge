// SPDX-License-Identifier: BUSL-1.1
/**
 * Backfills (§5.3): every definition change that touches records runs as a
 * job in `platform.jobs`, one batch per job run. A run processes the next
 * batch after the cursor, records its progress in
 * `platform.extension_field_backfills` and enqueues the next run in the same
 * transaction — so progress is visible between batches, a crash resumes at
 * the last committed cursor, and every step is idempotent per record (the
 * index is rewritten from the source; stripping a key twice strips nothing).
 * When the last batch is done the field leaves `updating`.
 *
 * Worker rights: the job runs under the worker role, replaying the session
 * that started the change. The worker holds DML on the side tables and the
 * two platform extension tables, and SELECT plus UPDATE of the one
 * `extension_values` column on the entity table (db/migrations/worker-role.ts,
 * `extensionWorkerGrants`) — nothing else of the entity.
 */
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../../generated/db/types.js";
import type { DbSessionInput } from "../../../db/session.js";
import { jsonbLiteral } from "../../../db/sql-helpers.js";
import { enqueueJob } from "../../../jobs/store.js";
import { actorSessionOf, type JobActorCredential, type JobActorSession } from "../../../jobs/actor-session.js";
import type { ModuleJobHandler } from "../../../modules/contract.js";
import { extensionError, uniqueText, extensionShape, type ExtensionField } from "./model.js";
import { extensionRegistry } from "./registry.js";
import { forgetExtensionFields, loadExtensionFieldsFor } from "./store.js";
import { qualifiedTable, writeExtensionFieldIndex } from "./write.js";
import { storedExtensionSource } from "./read.js";

export const EXTENSION_BACKFILL_KIND = "extensions.backfill";
export const EXTENSION_RETENTION_KIND = "extensions.retention";
export type BackfillOperation = "retype" | "delete" | "unique" | "rebuild";
export const BACKFILL_BATCH_SIZE = 500;

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

/** Start a backfill for one field version, inside the definition change's transaction. */
export async function startBackfill(
  trx: Transaction<DB>,
  session: DbSessionInput,
  input: { entity: string; field: ExtensionField; operation: BackfillOperation },
): Promise<BackfillRow> {
  const entry = extensionRegistry.entity(input.entity)!;
  const total = await sql<{ total: string }>`select count(*)::text as total from ${qualifiedTable(entry.table)}
    where tenant_id = ${session.tenantId}::uuid and extension_values ? ${input.field.fieldId}`.execute(trx);
  const id = randomUUID();
  const row = await sql<BackfillRow>`insert into platform.extension_field_backfills
      (tenant_id, id, entity, field_id, definition_version, operation, state, processed, total, cursor, error, created_at, updated_at)
    values (${session.tenantId}::uuid, ${id}::uuid, ${input.entity}, ${input.field.fieldId}::uuid, ${input.field.version},
      ${input.operation}, 'queued', 0, ${Number(total.rows[0]?.total ?? 0)}, null, null, now(), now())
    returning id, entity, field_id, definition_version, operation, state, processed, total, cursor, error`.execute(trx);
  await enqueueBackfillRun(trx, session.tenantId!, session.userId!, jobActorSession(session), id, null);
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
  const set = await loadExtensionFieldsFor(trx, session, row!.entity, entry!);
  const field = set.byId.get(row!.field_id);
  if (!field) extensionError("The backfill's field does not exist.", "INVALID_DEFINITION");
  const records = await sql<{ id: string; extension_values: unknown }>`
    select id, extension_values from ${qualifiedTable(entry!.table)}
    where tenant_id = ${tenantId}::uuid and extension_values ? ${field!.fieldId}
      ${row!.cursor ? sql`and id > ${row!.cursor}::uuid` : sql``}
    order by id limit ${batchSize} for update`.execute(trx);
  for (const record of records.rows) {
    const source = storedExtensionSource(record);
    switch (row!.operation) {
      case "retype":
      case "rebuild":
        await writeExtensionFieldIndex(trx, tenantId, set, { ...field!, definition: { ...field!.definition, unique: false } }, record.id, source[field!.fieldId]);
        break;
      case "unique": {
        const text = uniqueText(extensionShape(entry!, field!.definition), source[field!.fieldId]);
        if (text === null) break;
        const claimed = await sql<{ record_id: string }>`insert into ${qualifiedTable(entry!.uniqueTable)} (tenant_id, field_id, value_text, record_id)
          values (${tenantId}::uuid, ${field!.fieldId}::uuid, ${text}, ${record.id}::uuid)
          on conflict (tenant_id, field_id, value_text) do update set record_id = ${qualifiedTable(entry!.uniqueTable)}.record_id
          returning record_id`.execute(trx);
        if (claimed.rows[0]?.record_id !== record.id) {
          await failBackfill(trx, tenantId, row!, { code: "DUPLICATE_VALUE", message: `Value "${text}" of ${field!.key} is used by more than one record.` });
          return { state: "failed", processed: row!.processed, cursor: row!.cursor, more: false };
        }
        break;
      }
      case "delete": {
        await sql`update ${qualifiedTable(entry!.table)} set extension_values = extension_values - ${field!.fieldId}::text
          where tenant_id = ${tenantId}::uuid and id = ${record.id}::uuid`.execute(trx);
        await sql`delete from ${qualifiedTable(entry!.valuesTable)}
          where tenant_id = ${tenantId}::uuid and record_id = ${record.id}::uuid and field_id = ${field!.fieldId}::uuid`.execute(trx);
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
    } else if (field!.state === "updating") {
      await sql`update platform.extension_field_definitions set state = 'ready'
        where tenant_id = ${tenantId}::uuid and id = ${field!.rowId}::uuid and state = 'updating'`.execute(trx);
      forgetExtensionFields(tenantId, row!.entity);
    }
  }
  await sql`update platform.extension_field_backfills
    set state = ${more ? "running" : "done"}, processed = ${processed}, cursor = ${cursor}, updated_at = now()
    where tenant_id = ${tenantId}::uuid and id = ${row!.id}::uuid`.execute(trx);
  return { state: more ? "running" : "done", processed, cursor, more };
}

/** The `extensions.backfill` job: one batch per run, the next run enqueued with it. */
export const extensionBackfillJobHandler: ModuleJobHandler = async (payload, context) => {
  const backfillId = typeof payload.backfillId === "string" ? payload.backfillId : undefined;
  if (!backfillId) return { outcome: "failed", error: { code: "INVALID_PAYLOAD", message: "A backfill job names its backfill." } };
  const job = await sql<{ actor_session: unknown }>`select actor_session from platform.jobs
    where tenant_id = ${context.job.tenantId}::uuid and id = ${context.job.id}::uuid`.execute(context.db);
  const actorSession = actorSessionOf(job.rows[0]?.actor_session as JobActorSession);
  const session: DbSessionInput = {
    tenantId: context.job.tenantId, userId: context.job.actorId,
    roles: actorSession.roles, groups: actorSession.groups, scope: actorSession.scope,
  };
  const result = await runBackfillBatch(context.db, session, backfillId);
  if (result.more) {
    await enqueueBackfillRun(context.db, context.job.tenantId, context.job.actorId, actorSession, backfillId, result.cursor ?? `after-${result.processed}`);
  }
  return { outcome: "done", result: { state: result.state, processed: result.processed } };
};

/**
 * §6 retention, the minimal path: a field whose definition carries
 * `retention: { days, from?: "createdAt" | "updatedAt" }` loses its value
 * (source and index together) on records whose clock is older than that.
 * There is no record retention worker in this runtime to extend per jsonb
 * key, so the sweep is a per-(tenant, entity) job that reschedules itself
 * daily while any field still declares retention.
 */
export async function applyExtensionRetention(
  trx: Transaction<DB>,
  session: DbSessionInput,
  entity: string,
): Promise<{ cleared: number; retained: boolean }> {
  const entry = extensionRegistry.entity(entity);
  if (!entry) extensionError("The entity is not extensible.", "INVALID_DEFINITION");
  const set = await loadExtensionFieldsFor(trx, session, entity, entry!);
  let cleared = 0;
  let retained = false;
  for (const field of set.fields) {
    const retention = field.definition.retention as { days?: unknown; from?: unknown } | undefined;
    if (field.state === "deleted" || !retention || !Number.isInteger(retention.days)) continue;
    retained = true;
    const clock = retention.from === "updatedAt" ? "updated_at" : "created_at";
    const expired = await sql<{ id: string }>`update ${qualifiedTable(entry!.table)} set extension_values = extension_values - ${field.fieldId}::text
      where tenant_id = ${session.tenantId}::uuid and extension_values ? ${field.fieldId}
        and ${sql.ref(clock)} < now() - make_interval(days => ${retention.days as number})
      returning id`.execute(trx);
    for (const row of expired.rows) {
      await writeExtensionFieldIndex(trx, session.tenantId!, set, field, row.id, null);
    }
    cleared += expired.rows.length;
  }
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
