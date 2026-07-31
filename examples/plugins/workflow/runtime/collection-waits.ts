// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import { withDbSession, type DbSessionInput } from "../../../../apps/api/src/db/session.js";
import type { EntityEventRecord } from "../../../../apps/api/src/platform/entity-events.js";
import { enqueueWorkflowInstanceResume } from "./instance-commands.js";

export type WorkflowCollectionWaitFilterValue = string | number | boolean | null;

export type WorkflowCollectionWaitInput = {
  instanceId: string;
  nodeId: string;
  waitToken: string;
  entityType: string;
  eventType: string;
  filters?: Record<string, WorkflowCollectionWaitFilterValue> | null;
  checkpointSequence?: string | number | bigint | null;
  timeoutAt?: Date | string | null;
};

export type WorkflowCollectionWaitMatch = {
  waitToken: string;
  instanceId: string;
  nodeId: string;
  event: EntityEventRecord;
};

type PendingCollectionWaitRow = {
  id: string;
  instance_id: string;
  node_id: string;
  wait_token: string;
  filters: unknown;
  wait_metadata: unknown;
  checkpoint_sequence: string;
  timeout_at: string | null;
};

type CollectionWaitStatusRow = {
  status: string;
  instance_id: string;
  node_id: string;
  wait_token: string;
  event_id: string | null;
  tenant_id: string | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  event_type: string | null;
  payload: unknown;
  sequence: string | null;
  occurred_at: string | null;
};

type LoadEventRowsInput = {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  entityType: string;
  eventType: string;
  checkpointSequence: string;
};

export type WorkflowCollectionWaitWorkerOptions = {
  batchSize?: number;
  pollIntervalMs?: number;
};

const workerUserId = "00000000-0000-4000-8000-000000000000";

function normalizeRequiredText(value: string | null | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeUuid(value: string | null | undefined, label: string) {
  const normalized = normalizeRequiredText(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized,
    )
  ) {
    throw new Error(`${label} must be a UUID.`);
  }
  return normalized;
}

function normalizeSequence(value: string | number | bigint | null | undefined) {
  if (value === undefined || value === null || value === "") return "0";
  const sequence = BigInt(value);
  if (sequence < 0n) {
    throw new Error("checkpointSequence must be zero or greater.");
  }
  return sequence.toString();
}

function normalizeFilters(
  filters: Record<string, WorkflowCollectionWaitFilterValue> | null | undefined,
) {
  const normalized: Record<string, WorkflowCollectionWaitFilterValue> = {};
  for (const [key, value] of Object.entries(filters ?? {})) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    normalized[normalizedKey] = value;
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) =>
    left.localeCompare(right),
  ));
}

function jsonb(value: unknown) {
  return sql`cast(${JSON.stringify(value)} as jsonb)`;
}

function filterHash(filters: Record<string, WorkflowCollectionWaitFilterValue>) {
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

function readFilterValue(event: EntityEventRecord, key: string) {
  if (key === "aggregateId") return event.aggregateId;
  if (key === "aggregateType") return event.aggregateType;
  if (key === "eventType") return event.eventType;

  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return (payload as Record<string, unknown>)[key];
}

function filterMatchesEvent(
  filters: Record<string, WorkflowCollectionWaitFilterValue>,
  event: EntityEventRecord,
) {
  return Object.entries(filters).every(([key, expected]) => {
    const actual = readFilterValue(event, key);
    return actual === expected;
  });
}

function parseFilters(
  filters: unknown,
): Record<string, WorkflowCollectionWaitFilterValue> {
  if (typeof filters === "string") {
    try {
      return parseFilters(JSON.parse(filters));
    } catch {
      return {};
    }
  }
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    return {};
  }
  return filters as Record<string, WorkflowCollectionWaitFilterValue>;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiresContinuationRouting(waitMetadata: unknown): boolean {
  return parseRecord(waitMetadata).requiresContinuationRouting === true;
}

function mapEventRow(row: CollectionWaitStatusRow): EntityEventRecord | null {
  if (
    !row.event_id ||
    !row.tenant_id ||
    !row.aggregate_type ||
    !row.aggregate_id ||
    !row.event_type ||
    !row.sequence ||
    !row.occurred_at
  ) {
    return null;
  }

  return {
    id: row.event_id,
    tenantId: row.tenant_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload as EntityEventRecord["payload"],
    sequence: row.sequence,
    occurredAt: new Date(row.occurred_at).toISOString(),
  };
}

async function loadEventRowsAfterCheckpoint(input: LoadEventRowsInput) {
  return withDbSession(input.db, input.session, async (trx, scopedSession) => {
    const rows = await sql<{
      id: string;
      tenant_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: unknown;
      sequence: string;
      occurred_at: string;
    }>`
      select
        id::text,
        tenant_id::text,
        aggregate_type,
        aggregate_id,
        event_type,
        payload,
        sequence::text,
        occurred_at::text
      from platform.entity_events
      where tenant_id = cast(${scopedSession.tenantId} as uuid)
        and aggregate_type = ${input.entityType}
        and event_type = ${input.eventType}
        and sequence > ${input.checkpointSequence}
      order by sequence asc
    `.execute(trx);

    return rows.rows.map((row): EntityEventRecord => ({
      id: row.id,
      tenantId: row.tenant_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload as EntityEventRecord["payload"],
      sequence: row.sequence,
      occurredAt: new Date(row.occurred_at).toISOString(),
    }));
  });
}

async function enqueueCollectionWaitResume(
  db: OpenShapeForgeDatabase,
  tenantId: string,
  match: WorkflowCollectionWaitMatch,
) {
  await enqueueWorkflowInstanceResume(
    db,
    {
      tenantId,
      userId: workerUserId,
      roles: ["workflow-worker", "workflow-operator"],
    },
    {
      instanceId: match.instanceId,
      nodeId: match.nodeId,
      waitToken: match.waitToken,
      reason: "collection-wait-match",
      input: {
        event: match.event,
        checkpointSequence: match.event.sequence,
      },
    },
  );
}

export async function registerWorkflowCollectionWait(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: WorkflowCollectionWaitInput,
) {
  const instanceId = normalizeUuid(input.instanceId, "instanceId");
  const nodeId = normalizeRequiredText(input.nodeId, "nodeId");
  const waitToken = normalizeRequiredText(input.waitToken, "waitToken");
  const entityType = normalizeRequiredText(input.entityType, "entityType");
  const eventType = normalizeRequiredText(input.eventType, "eventType");
  const checkpointSequence = normalizeSequence(input.checkpointSequence);
  const filters = normalizeFilters(input.filters);
  const hash = filterHash(filters);

  await withDbSession(db, session, async (trx, scopedSession) => {
    const instance = await sql<{ id: string }>`
      select id::text
      from workflow.instances
      where tenant_id = cast(${scopedSession.tenantId} as uuid)
        and id = cast(${instanceId} as uuid)
      limit 1
    `.execute(trx);
    if (instance.rows.length !== 1) {
      throw new Error("Collection wait instance was not found for the active tenant.");
    }

    await sql`
      insert into workflow.collection_waits (
        tenant_id,
        instance_id,
        node_id,
        wait_token,
        entity_type,
        event_type,
        filters,
        filter_hash,
        checkpoint_sequence,
        status,
        matched_event_id,
        matched_sequence,
        timeout_at
      ) values (
        cast(${scopedSession.tenantId} as uuid),
        cast(${instanceId} as uuid),
        ${nodeId},
        ${waitToken},
        ${entityType},
        ${eventType},
        ${jsonb(filters)},
        ${hash},
        ${checkpointSequence},
        'pending',
        null::uuid,
        null,
        ${input.timeoutAt ? new Date(input.timeoutAt).toISOString() : null}::timestamptz
      )
      on conflict (tenant_id, wait_token) do update
      set updated_at = now()
    `.execute(trx);

    await sql`
      insert into workflow.waits (
        tenant_id,
        instance_id,
        node_id,
        wait_token,
        wait_kind,
        wait_metadata
      ) values (
        cast(${scopedSession.tenantId} as uuid),
        cast(${instanceId} as uuid),
        ${nodeId},
        ${waitToken},
        'collection_entity',
        ${jsonb({
          entityType,
          eventType,
          filters,
          checkpointSequence,
        })}
      )
      on conflict (tenant_id, wait_token) do update
      set updated_at = now()
    `.execute(trx);
  });

  const current = await withDbSession(db, session, async (trx, scopedSession) => {
    const row = await sql<CollectionWaitStatusRow>`
      select
        cw.status,
        cw.instance_id::text,
        cw.node_id,
        cw.wait_token,
        e.id::text as event_id,
        e.tenant_id::text,
        e.aggregate_type,
        e.aggregate_id,
        e.event_type,
        e.payload,
        e.sequence::text,
        e.occurred_at::text
      from workflow.collection_waits as cw
      left join platform.entity_events as e
        on e.id = cw.matched_event_id
      where cw.tenant_id = cast(${scopedSession.tenantId} as uuid)
        and cw.wait_token = ${waitToken}
      limit 1
    `.execute(trx);
    return row.rows[0] ?? null;
  });

  if (current?.status === "matched") {
    const event = mapEventRow(current);
    if (event) {
      return {
        status: "matched" as const,
        match: {
          waitToken: current.wait_token,
          instanceId: current.instance_id,
          nodeId: current.node_id,
          event,
        },
      };
    }
  }
  if (current?.status === "timed_out") {
    return {
      status: "timed_out" as const,
      waitToken: current.wait_token,
      instanceId: current.instance_id,
      nodeId: current.node_id,
    };
  }

  const replay = await replayWorkflowCollectionWaitEvents({
    db,
    session,
    entityType,
    eventType,
    checkpointSequence,
  });
  const matched = replay.matched.find((candidate) => candidate.waitToken === waitToken);

  if (matched) {
    return {
      status: "matched" as const,
      match: matched,
    };
  }

  return { status: "pending" as const, waitToken, instanceId, nodeId };
}

export async function processWorkflowCollectionWaitEvent(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  event: EntityEventRecord,
) {
  const result = await withDbSession(db, session, async (trx, scopedSession) => {
    if (event.tenantId !== scopedSession.tenantId) {
      return { matched: [] as WorkflowCollectionWaitMatch[], skippedContinuationRouting: [] as PendingCollectionWaitRow[] };
    }

    const rows = await sql<PendingCollectionWaitRow>`
      select
        cw.id::text,
        cw.instance_id::text,
        cw.node_id,
        cw.wait_token,
        cw.filters,
        w.wait_metadata,
        cw.checkpoint_sequence::text,
        cw.timeout_at::text
      from workflow.collection_waits cw
      left join workflow.waits w
        on w.tenant_id = cw.tenant_id
       and w.wait_token = cw.wait_token
      where cw.tenant_id = cast(${scopedSession.tenantId} as uuid)
        and cw.status = 'pending'
        and cw.entity_type = ${event.aggregateType}
        and cw.event_type = ${event.eventType}
        and cw.checkpoint_sequence < ${event.sequence}
        and (
          cw.timeout_at is null
          or cw.timeout_at >= cast(${event.occurredAt} as timestamptz)
        )
      order by cw.created_at asc
    `.execute(trx);

    const matched: WorkflowCollectionWaitMatch[] = [];
    // Continuation-routed waits that this event WOULD have matched by filter but
    // which we intentionally leave for the orchestrator/router continuation path
    // (messaging/inbound-ingest.ts). They are surfaced for observability so a
    // broken routing path does not silently stall the instance — see the worker
    // warning in startWorkflowCollectionWaitWorker.
    const skippedContinuationRouting: PendingCollectionWaitRow[] = [];
    for (const row of rows.rows) {
      if (!filterMatchesEvent(parseFilters(row.filters), event)) continue;
      if (requiresContinuationRouting(row.wait_metadata)) {
        skippedContinuationRouting.push(row);
        continue;
      }
      const updated = await sql<{ id: string }>`
        update workflow.collection_waits
        set
          status = 'matched',
          matched_event_id = cast(${event.id} as uuid),
          matched_sequence = ${event.sequence},
          updated_at = now()
        where id = cast(${row.id} as uuid)
          and status = 'pending'
        returning id::text
      `.execute(trx);
      if (updated.rows.length === 1) {
        matched.push({
          waitToken: row.wait_token,
          instanceId: row.instance_id,
          nodeId: row.node_id,
          event,
        });
      }
    }

    return { matched, skippedContinuationRouting };
  });

  for (const match of result.matched) {
    await enqueueCollectionWaitResume(db, event.tenantId, match);
  }

  // A continuation-routed wait matched by filter but lacking a timeout can never
  // be reclaimed by processExpiredWorkflowCollectionWaits if the routing path
  // fails to fire — log it loudly so the silent-stall is observable. Root cause
  // of a never-firing routing path is cross-file: orchestrator-bridges.ts must
  // propagate processStepId across the subWorkflow boundary.
  const unrecoverable = result.skippedContinuationRouting.filter((row) => !row.timeout_at);
  if (unrecoverable.length > 0) {
    console.warn(
      {
        tenantId: event.tenantId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        waits: unrecoverable.map((row) => ({
          instanceId: row.instance_id,
          nodeId: row.node_id,
          waitToken: row.wait_token,
        })),
      },
      "Collection wait matched event by filter but is continuation-routed with no timeout; relying on the routing path to resume it.",
    );
  }

  return {
    matched: result.matched,
    skippedContinuationRouting: result.skippedContinuationRouting.length,
  };
}

export async function replayWorkflowCollectionWaitEvents(input: {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  entityType: string;
  eventType: string;
  checkpointSequence: string;
}) {
  const events = await loadEventRowsAfterCheckpoint(input);
  const matched: WorkflowCollectionWaitMatch[] = [];
  for (const event of events) {
    const result = await processWorkflowCollectionWaitEvent(
      input.db,
      input.session,
      event,
    );
    matched.push(...result.matched);
  }
  return { matched };
}

async function listPendingCollectionWaitReplayGroups(
  db: OpenShapeForgeDatabase,
  batchSize: number,
) {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.worker_role', 'workflow-worker', true)`.execute(
      trx,
    );
    const rows = await sql<{
      tenant_id: string;
      entity_type: string;
      event_type: string;
      checkpoint_sequence: string;
    }>`
      select
        cw.tenant_id::text,
        cw.entity_type,
        cw.event_type,
        min(cw.checkpoint_sequence)::text as checkpoint_sequence
      from workflow.collection_waits cw
      left join workflow.waits w
        on w.tenant_id = cw.tenant_id
       and w.wait_token = cw.wait_token
      where cw.status = 'pending'
        and coalesce((w.wait_metadata ->> 'requiresContinuationRouting')::boolean, false) = false
      group by cw.tenant_id, cw.entity_type, cw.event_type
      order by min(cw.created_at) asc
      limit ${batchSize}
    `.execute(trx);
    return rows.rows;
  });
}

/**
 * Safety net for the continuation-routing split (see processWorkflowCollectionWaitEvent).
 * Continuation-routed waits are intentionally skipped by this worker and the
 * replay scan, expecting the orchestrator/router continuation path to resume
 * them. A wait that path never fires for is only reclaimed by the timeout
 * sweep when timeout_at is set; one with timeout_at IS NULL would stall the
 * instance forever. Count those (still-active, past a short grace window) so a
 * broken routing path is observable rather than a silent stall. The root cause
 * of a never-firing routing path is cross-file: orchestrator-bridges.ts must
 * propagate processStepId across the subWorkflow boundary.
 */
async function countStalledContinuationRoutingWaits(db: OpenShapeForgeDatabase) {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.worker_role', 'workflow-worker', true)`.execute(
      trx,
    );
    const result = await sql<{ count: string }>`
      select count(*)::text as count
      from workflow.collection_waits cw
      join workflow.instances i
        on i.tenant_id = cw.tenant_id
       and i.id = cw.instance_id
      left join workflow.waits w
        on w.tenant_id = cw.tenant_id
       and w.wait_token = cw.wait_token
      where cw.status = 'pending'
        and cw.timeout_at is null
        and cw.created_at < now() - interval '5 minutes'
        and i.status not in ('completed', 'failed', 'cancelled', 'skipped')
        and coalesce((w.wait_metadata ->> 'requiresContinuationRouting')::boolean, false) = true
    `.execute(trx);
    return Number(result.rows[0]?.count ?? "0");
  });
}

export async function processPendingWorkflowCollectionWaits(
  db: OpenShapeForgeDatabase,
  options: WorkflowCollectionWaitWorkerOptions = {},
) {
  const groups = await listPendingCollectionWaitReplayGroups(
    db,
    Math.max(1, Math.min(Math.trunc(options.batchSize ?? 25), 100)),
  );
  let matched = 0;

  for (const group of groups) {
    const result = await replayWorkflowCollectionWaitEvents({
      db,
      session: {
        tenantId: group.tenant_id,
        userId: workerUserId,
        roles: ["workflow-worker", "workflow-operator"],
      },
      entityType: group.entity_type,
      eventType: group.event_type,
      checkpointSequence: group.checkpoint_sequence,
    });
    matched += result.matched.length;
  }
  const timedOut = await processExpiredWorkflowCollectionWaits(db);
  const stalledContinuationRouting = await countStalledContinuationRoutingWaits(db);

  return {
    groups: groups.length,
    matched,
    timedOut: timedOut.timedOut,
    stalledContinuationRouting,
  };
}

export async function processExpiredWorkflowCollectionWaits(db: OpenShapeForgeDatabase) {
  const expired = await db.transaction().execute(async (trx) => {
    await sql`select set_config('app.worker_role', 'workflow-worker', true)`.execute(
      trx,
    );
    const rows = await sql<{
      tenant_id: string;
      instance_id: string;
      node_id: string;
      wait_token: string;
    }>`
      update workflow.collection_waits
      set
        status = 'timed_out',
        updated_at = now()
      where status = 'pending'
        and timeout_at is not null
        and timeout_at <= now()
      returning
        tenant_id::text,
        instance_id::text,
        node_id,
        wait_token
    `.execute(trx);
    return rows.rows;
  });

  for (const wait of expired) {
    await enqueueWorkflowInstanceResume(db, {
      tenantId: wait.tenant_id,
      userId: workerUserId,
      roles: ["workflow-worker", "workflow-operator"],
    }, {
      instanceId: wait.instance_id,
      nodeId: wait.node_id,
      waitToken: wait.wait_token,
      reason: "collection-wait-timeout",
      input: {
        timedOut: true,
      },
    });
  }

  return { timedOut: expired.length };
}

export function startWorkflowCollectionWaitWorker(
  db: OpenShapeForgeDatabase,
  options: WorkflowCollectionWaitWorkerOptions = {},
) {
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000);
  let stopped = false;
  let active = false;

  const tick = async () => {
    if (stopped || active) return;
    active = true;
    try {
      const result = await processPendingWorkflowCollectionWaits(db, options);
      if (result.matched > 0 || result.timedOut > 0) {
        console.info(
          {
            matched: result.matched,
            timedOut: result.timedOut,
            groups: result.groups,
          },
          "Workflow collection wait worker processed waits.",
        );
      }
      if (result.stalledContinuationRouting > 0) {
        console.warn(
          { stalledContinuationRouting: result.stalledContinuationRouting },
          "Continuation-routed collection waits with no timeout are pending past the grace window; the routing path may not be firing (cross-file root cause: orchestrator-bridges.ts processStepId propagation).",
        );
      }
    } finally {
      active = false;
    }
  };

  const interval = setInterval(() => {
    void tick().catch((error) => {
      console.error({ error }, "Workflow collection wait worker tick failed.");
    });
  }, pollIntervalMs);
  void tick().catch((error) => {
    console.error({ error }, "Workflow collection wait worker initial tick failed.");
  });

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      while (active) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}
