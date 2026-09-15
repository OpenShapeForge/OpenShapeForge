// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import { getGeneratedCrudTables, requireEntityOperation } from "../operations/entity/catalog.js";
import type { GeneratedCrudTable } from "../operations/entity/types.js";
import { mapEntityEvent, type EntityEventRecord } from "./entity-events.js";

export const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export type ResourceChange = { entity: string; id: string; change: "created" | "updated" | "deleted"; version?: string };
export type ChangeBatch = { cursor: string; reset: boolean; changes: Array<{ cursor: string; data: ResourceChange }> };

export function parseStreamCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new Error("INVALID_STREAM_CURSOR");
  }
  return value;
}

export function encodeStreamFrame(cursor: string, event?: string, data?: unknown): string {
  return `id: ${cursor}\n${event ? `event: ${event}\ndata: ${JSON.stringify(data)}\n` : ": heartbeat\n"}\n`;
}

function eventTable(event: EntityEventRecord): GeneratedCrudTable | undefined {
  return getGeneratedCrudTables().find(table => table.realtime && (
    table.source?.graphql?.singleQueryName === event.aggregateType ||
    table.source?.authoringEntityName === event.aggregateType
  ));
}

async function projectChange(trx: Transaction<DB>, session: DbSessionInput, event: EntityEventRecord): Promise<ResourceChange | undefined> {
  if (!["created", "updated", "deleted"].includes(event.eventType)) return;
  const table = eventTable(event);
  if (!table?.realtime || !table.primaryKey || !table.source?.authoringEntityName) return;
  try { requireEntityOperation(table, "get", session); } catch { return; }

  const payload = event.payload as Record<string, unknown> | null;
  const visibility = payload?.visibility;
  if (event.eventType === "deleted") {
    // Only compiler-selected policy columns are retained. Evaluate the same
    // predicate as RLS with the reader's *current* session, never writer roles.
    if (!visibility || typeof visibility !== "object" || Array.isArray(visibility)) return;
    const snapshot = Object.fromEntries(table.realtime.visibilityColumns.map(column => [column, (visibility as Record<string, unknown>)[column] ?? null]));
    const allowed = await sql<{ allowed: boolean }>`
      select (${sql.raw(table.realtime.readPredicate)}) as allowed
      from jsonb_populate_record(null::${sql.id(table.schema, table.table)}, ${jsonbLiteral(snapshot)}) as tombstone
    `.execute(trx);
    if (allowed.rows[0]?.allowed !== true) return;
  } else {
    // Current RLS, including owner and record ACL policies, is authoritative.
    const visible = await sql<{ id: string }>`select ${sql.id(table.primaryKey)}::text as id
      from ${sql.id(table.schema, table.table)}
      where ${sql.id(table.primaryKey)}::text = ${event.aggregateId}
        and tenant_id = ${session.tenantId} limit 1`.execute(trx);
    if (!visible.rows.length) return;
  }
  return { entity: table.source.authoringEntityName, id: event.aggregateId, change: event.eventType as ResourceChange["change"] };
}

/** Each poll is a short transaction, shared by every API replica through the journal. */
export async function readChangeBatch(db: OpenShapeForgeDatabase, session: DbSessionInput, cursor?: string, validateCursor = true): Promise<ChangeBatch> {
  return withDbSession(db, session, async trx => {
    // Writers never acquire this lock. Only committed journal rows receive a
    // delivery cursor, so a slow transaction cannot be skipped or deadlock a writer.
    await sql`select pg_advisory_xact_lock(hashtextextended(${"entity-delivery:" + session.tenantId}, 0))`.execute(trx);
    const latest = await trx.selectFrom("platform.entity_events").select("delivery_sequence")
      .where("tenant_id", "=", session.tenantId!).where("delivery_sequence", "is not", null)
      .orderBy("delivery_sequence", "desc").limit(1).executeTakeFirst();
    const previousHigh = latest?.delivery_sequence ?? "0";
    const assigned = await sql<{ delivery_sequence: string }>`with pending as (
      select id, row_number() over (order by sequence) as ordinal
      from platform.entity_events where tenant_id = ${session.tenantId}
        and delivery_sequence is null and occurred_at >= statement_timestamp() - interval '24 hours'
      order by sequence limit 100
    ) update platform.entity_events as event set delivery_sequence = ${previousHigh}::bigint + pending.ordinal
      from pending where event.id = pending.id returning event.delivery_sequence::text`.execute(trx);
    const high = assigned.rows.reduce((max, row) => BigInt(row.delivery_sequence) > BigInt(max) ? row.delivery_sequence : max, previousHigh);
    if (cursor === undefined) return { cursor: high, reset: true, changes: [] };
    if (validateCursor && cursor === "0") {
      const old = await sql`select 1 from platform.entity_events where tenant_id = ${session.tenantId}
        and occurred_at < statement_timestamp() - interval '24 hours' limit 1`.execute(trx);
      if (old.rows.length) return { cursor: high, reset: true, changes: [] };
    } else if (validateCursor) {
      const checkpoint = await sql<{ recent: boolean }>`select occurred_at >= statement_timestamp() - interval '24 hours' as recent
        from platform.entity_events where tenant_id = ${session.tenantId} and delivery_sequence = ${cursor}`.execute(trx);
      if (!checkpoint.rows[0]?.recent) return { cursor: high, reset: true, changes: [] };
    }
    // Late commits mean event timestamps need not follow delivery order.
    const expired = await sql`select 1 from platform.entity_events where tenant_id = ${session.tenantId}
      and delivery_sequence > ${cursor} and occurred_at < statement_timestamp() - interval '24 hours' limit 1`.execute(trx);
    if (expired.rows.length) return { cursor: high, reset: true, changes: [] };
    const rows = await trx.selectFrom("platform.entity_events").selectAll()
      .where("tenant_id", "=", session.tenantId!).where("delivery_sequence", ">", cursor)
      .orderBy("delivery_sequence", "asc").limit(100).execute();
    const changes: ChangeBatch["changes"] = [];
    for (const row of rows) {
      const event = { ...mapEntityEvent(row), sequence: row.delivery_sequence! };
      const data = await projectChange(trx, session, event);
      if (data) changes.push({ cursor: event.sequence, data });
    }
    return { cursor: rows.at(-1)?.delivery_sequence ?? cursor, reset: false, changes };
  });
}
