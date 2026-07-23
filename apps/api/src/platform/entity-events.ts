// SPDX-License-Identifier: BUSL-1.1
/**
 * Durable entity-event append for generated CRUD mutations.
 *
 * Trimmed from the full apps/api service: the event-outbox enqueue, realtime
 * dirty-marker projection, and cross-replica fanout have been removed — this
 * runtime only persists the event row in platform.entity_events inside the
 * mutating transaction. Re-add the outbox/realtime wiring when those workers
 * (and their tables) come back.
 */
import { sql, type Selectable, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import type {
  DB,
  Json,
  PlatformEntityEventsTable,
} from "../generated/db/types.js";

export type AppendEntityEventInput = {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload?: Json;
};

export type AppendEntityEventInTransactionInput = AppendEntityEventInput & {
  tenantId: string;
};

export type AppendScopedEntityEventInTransactionInput = AppendEntityEventInput;

export type ListEntityEventsInput = {
  aggregateType?: string | null;
  aggregateId?: string | null;
  eventType?: string | null;
  afterSequence?: string | number | bigint | null;
  limit?: number | null;
};

export type EntityEventRecord = {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Json;
  sequence: string;
  occurredAt: string;
};

export type EntityEventConnection = {
  events: EntityEventRecord[];
  nextSequence: string | null;
};

type EntityEventRow = Selectable<PlatformEntityEventsTable>;

function timestampToIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeLimit(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) {
    return 100;
  }
  return Math.max(1, Math.min(Math.trunc(value as number), 500));
}

function normalizeSequence(value?: string | number | bigint | null) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  try {
    const sequence = BigInt(value);
    return sequence >= 0n ? sequence.toString() : null;
  } catch {
    return null;
  }
}

// Inlined from the full service's workflow/definitions.ts so this runtime does
// not depend on the workflow module.
export function normalizeJsonValue(value: Json): Json {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed === value ? value : normalizeJsonValue(parsed as Json);
    } catch {
      return value;
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeJsonValue(entry),
      ]),
    );
  }

  return value;
}

async function readTransactionTenantId(trx: Transaction<DB>) {
  const row = await sql<{ tenant_id: string | null }>`
    select current_setting('app.tenant_id', true) as tenant_id
  `.execute(trx);
  return normalizeOptionalText(row.rows[0]?.tenant_id);
}

export function mapEntityEvent(row: EntityEventRow): EntityEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: normalizeJsonValue(row.payload),
    sequence: row.sequence,
    occurredAt: timestampToIso(row.occurred_at),
  };
}

export async function appendEntityEventInTransaction(
  trx: Transaction<DB>,
  input: AppendEntityEventInTransactionInput,
) {
  const scopedTenantId = await readTransactionTenantId(trx);
  if (!scopedTenantId || scopedTenantId !== input.tenantId) {
    throw new Error("Entity event tenantId does not match the active database session.");
  }

  return appendScopedEntityEventInTransaction(trx, input);
}

export async function appendScopedEntityEventInTransaction(
  trx: Transaction<DB>,
  input: AppendScopedEntityEventInTransactionInput,
) {
  const tenantId = await readTransactionTenantId(trx);
  if (!tenantId) {
    throw new Error("Entity event append requires an active tenant-scoped database session.");
  }

  const row = await trx
    .insertInto("platform.entity_events")
    .values({
      tenant_id: tenantId,
      aggregate_type: normalizeText(input.aggregateType, "aggregateType"),
      aggregate_id: normalizeText(input.aggregateId, "aggregateId"),
      event_type: normalizeText(input.eventType, "eventType"),
      payload: input.payload ?? {},
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapEntityEvent(row);
}

export async function appendEntityEvent(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: AppendEntityEventInput,
) {
  return withDbSession(db, session, async (trx, scopedSession) =>
    appendEntityEventInTransaction(trx, {
      ...input,
      tenantId: scopedSession.tenantId,
    }),
  );
}

export async function listEntityEvents(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: ListEntityEventsInput = {},
): Promise<EntityEventConnection> {
  const limit = normalizeLimit(input.limit);
  const afterSequence = normalizeSequence(input.afterSequence);
  const aggregateType = normalizeOptionalText(input.aggregateType);
  const aggregateId = normalizeOptionalText(input.aggregateId);
  const eventType = normalizeOptionalText(input.eventType);

  if (afterSequence === null) {
    return { events: [], nextSequence: null };
  }

  return withDbSession(db, session, async (trx, scopedSession) => {
    let query = trx
      .selectFrom("platform.entity_events")
      .selectAll()
      .where("tenant_id", "=", scopedSession.tenantId)
      .orderBy("sequence", "asc")
      .limit(limit + 1);

    if (aggregateType) {
      query = query.where("aggregate_type", "=", aggregateType);
    }
    if (aggregateId) {
      query = query.where("aggregate_id", "=", aggregateId);
    }
    if (eventType) {
      query = query.where("event_type", "=", eventType);
    }
    if (afterSequence !== undefined) {
      query = query.where("sequence", ">", afterSequence);
    }

    const rows = await query.execute();
    const events = rows.slice(0, limit).map(mapEntityEvent);
    return {
      events,
      nextSequence:
        rows.length > limit && events.length > 0
          ? events[events.length - 1]!.sequence
          : null,
    };
  });
}
