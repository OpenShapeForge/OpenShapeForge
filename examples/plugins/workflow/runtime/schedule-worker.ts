// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import type { DB } from "../../../../apps/api/src/generated/db/types.js";
import { jsonbLiteral } from "../../../../apps/api/src/db/sql-helpers.js";
import { WORKFLOW_WORKER_ROLE } from "../worker-role.js";
import { enqueueWorkflowInstanceStartInTransaction } from "./instance-commands.js";

type ScheduleNodeSnapshot = {
  triggerNodeId: string;
  cron: string;
  timezone: string;
};

type PublishedScheduleDefinition = {
  versionId: string;
  version: number;
  definition: unknown;
  publishedBy: string | null;
};

type ClaimedSchedule = {
  id: string;
  tenantId: string;
  definitionId: string;
  versionId: string | null;
  triggerNodeId: string;
  cron: string;
  timezone: string;
  generation: number;
  nextFireAt: Date;
  nextOccurrence: number;
  startedBy: string | null;
};

export type WorkflowScheduleSyncOptions = {
  now?: Date;
};

export type WorkflowScheduleWorkerOptions = {
  now?: Date;
  workerId?: string;
  batchSize?: number;
  pollIntervalMs?: number;
};

const DEFAULT_TIMEZONE = "Europe/Amsterdam";
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const SYSTEM_SCHEDULE_USER_ID = "00000000-0000-4000-8000-000000000000";


function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function extractScheduleNodes(definition: unknown): ScheduleNodeSnapshot[] {
  const record = normalizeRecord(definition);
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const schedules: ScheduleNodeSnapshot[] = [];

  for (const node of nodes) {
    const nodeRecord = normalizeRecord(node);
    if (nodeRecord.type !== "triggerSchedule") continue;

    const config = normalizeRecord(nodeRecord.config);
    schedules.push({
      triggerNodeId: typeof nodeRecord.id === "string" ? nodeRecord.id : "",
      cron: typeof config.cron === "string" ? config.cron.trim() : "",
      timezone:
        (typeof config.timezone === "string" ? config.timezone.trim() : "") ||
        DEFAULT_TIMEZONE,
    });
  }

  return schedules.filter((schedule) => schedule.triggerNodeId && schedule.cron);
}

function nextFireAt(cron: string, timezone: string, currentDate: Date) {
  return CronExpressionParser.parse(cron, {
    currentDate,
    tz: timezone,
  }).next().toDate();
}

function startIdempotencyKey(schedule: ClaimedSchedule) {
  return [
    "workflow-start:schedule",
    schedule.tenantId,
    schedule.definitionId,
    schedule.nextFireAt.toISOString(),
    String(schedule.nextOccurrence),
  ].join(":");
}

/**
 * Row security for a worker poll.
 *
 * The queue tables are tenant-scoped and RLS'd, but a worker claim is
 * cross-tenant by nature: it scans every due schedule, precisely so one
 * tenant's backlog does not need its own worker.
 *
 * Nothing here is bypassed. `workflow.schedules` and `workflow.schedule_fires`
 * declare `workerAccess: WORKFLOW_WORKER_ROLE` (see the plugin's `index.ts`),
 * so their policies admit a worker directly — connected as
 * `openshapeforge_worker` AND presenting this role. The widening stops there:
 * `workflow.definitions` and `workflow.definition_versions` do NOT declare it
 * (only `workerDml`, which grants without widening), and this worker reads them
 * only after `tenantId` is known and set below — through the ordinary tenant
 * predicate, exactly as a user session would. Setting `app.bypass_rls` instead
 * would have granted read AND write on every tenant-scoped table in the
 * manifest.
 *
 * No audit row, because there is no bypass to audit — which is also why the
 * poll loop's rate stops being a problem for the break-glass trail.
 *
 * Call this ONLY on a transaction this worker opened. `set_config(..., true)` is
 * transaction-local, not statement-local, so calling it on a transaction someone
 * else owns widens THEIR session for the rest of it — see
 * `syncWorkflowDefinitionScheduleInTransaction` below, which is why the publish
 * path does not come through here.
 */
async function applyWorkflowScheduleSession(trx: Transaction<DB>, tenantId?: string) {
  await sql`select set_config('app.roles', ${WORKFLOW_WORKER_ROLE}, true)`.execute(trx);
  await sql`select set_config('app.worker_role', ${WORKFLOW_WORKER_ROLE}, true)`.execute(trx);
  if (tenantId) {
    await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
  }
}

/**
 * Row security for a bare transaction that is nobody's request.
 *
 * The standalone `syncWorkflowDefinitionSchedule` wrapper opens its own
 * transaction, so no session exists on it at all and the tenant predicate would
 * see `app.tenant_id` unset. It sets the tenant and nothing else: rebuilding one
 * tenant's `workflow.schedules` rows needs no cross-tenant reach, and the plain
 * tenant predicate already admits it.
 */
async function applyWorkflowScheduleTenantSession(trx: Transaction<DB>, tenantId: string) {
  await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
}

async function loadLatestPublishedDefinition(
  trx: Transaction<DB>,
  tenantId: string,
  definitionId: string,
): Promise<PublishedScheduleDefinition | null> {
  const result = await sql<{
    version_id: string;
    version: number;
    definition: unknown;
    published_by: string | null;
  }>`
    select
      v.id::text as version_id,
      v.version,
      v.definition,
      v.published_by::text
    from workflow.definitions d
    join workflow.definition_versions v
      on v.tenant_id = d.tenant_id
      and v.definition_id = d.id
    where d.tenant_id = cast(${tenantId} as uuid)
      and d.id = cast(${definitionId} as uuid)
      and d.is_active = true
      and v.published_at is not null
    order by v.version desc
    limit 1
  `.execute(trx);

  const row = result.rows[0];
  if (!row) return null;
  return {
    versionId: row.version_id,
    version: row.version,
    definition: row.definition,
    publishedBy: row.published_by,
  };
}

/**
 * Sets no session: this runs under both the worker (which already set one on its
 * own transaction) and the publish path (whose caller owns the transaction and
 * whose session must not be touched). Writing one tenant's `workflow.schedules`
 * rows is admitted by the plain tenant predicate either way.
 */
async function deactivateScheduleInTransaction(
  trx: Transaction<DB>,
  tenantId: string,
  definitionId: string,
  reason: string,
) {
  await sql`
    update workflow.schedules
    set
      status = 'inactive',
      generation = generation + 1,
      next_fire_at = null,
      locked_at = null,
      locked_by = null,
      last_result = ${jsonbLiteral({ status: "deactivated", reason })},
      updated_at = now()
    where tenant_id = cast(${tenantId} as uuid)
      and definition_id = cast(${definitionId} as uuid)
  `.execute(trx);
}

export async function deactivateWorkflowDefinitionScheduleInTransaction(
  trx: Transaction<DB>,
  tenantId: string,
  definitionId: string,
  reason: string,
) {
  await deactivateScheduleInTransaction(trx, tenantId, definitionId, reason);
}

/**
 * Rebuild one definition's schedule row, on a transaction the CALLER owns.
 *
 * This is the publish path: it runs inside the request's `withDbSession`
 * transaction. It therefore sets no session at all. It used to set
 * `app.roles`, `app.worker_role` and `app.tenant_id` here, and because
 * `set_config(..., true)` is transaction-local rather than statement-local, that
 * widened the caller's session for the remainder of its transaction — clobbering
 * the request's real roles and handing it read access to every tenant's
 * `workflow.control_commands`, `schedules` and `schedule_fires`, the three
 * tables whose policies name `app.worker_role`.
 *
 * That is the one thing the worker axis rests on not happening: the API's
 * request path never presents the worker role, and a worker's boot path does.
 * The widening was invisible at the call site — a publish resolver calling this
 * looks like ordinary bookkeeping.
 *
 * Nothing here needs the widening. Every statement below touches one tenant's
 * own rows, which the plain tenant predicate already admits under the caller's
 * session. Callers that have no session — the standalone wrapper — set the
 * tenant themselves.
 */
export async function syncWorkflowDefinitionScheduleInTransaction(
  trx: Transaction<DB>,
  tenantId: string,
  definitionId: string,
  options: WorkflowScheduleSyncOptions = {},
) {
  const published = await loadLatestPublishedDefinition(trx, tenantId, definitionId);
  if (!published) {
    await deactivateScheduleInTransaction(
      trx,
      tenantId,
      definitionId,
      "definition_not_schedulable",
    );
    return { status: "inactive" as const };
  }

  const schedules = extractScheduleNodes(published.definition);
  if (schedules.length > 1) {
    throw new Error("A published workflow definition can contain at most one schedule trigger.");
  }

  const schedule = schedules[0];
  if (!schedule) {
    await deactivateScheduleInTransaction(trx, tenantId, definitionId, "no_schedule_trigger");
    return { status: "inactive" as const };
  }

  const now = options.now ?? new Date();
  const upcoming = nextFireAt(schedule.cron, schedule.timezone, now);
  await sql`
    insert into workflow.schedules (
      tenant_id,
      definition_id,
      version_id,
      trigger_node_id,
      cron,
      timezone,
      started_by,
      status,
      generation,
      next_fire_at,
      next_occurrence,
      last_result
    ) values (
      cast(${tenantId} as uuid),
      cast(${definitionId} as uuid),
      cast(${published.versionId} as uuid),
      ${schedule.triggerNodeId},
      ${schedule.cron},
      ${schedule.timezone},
      cast(${published.publishedBy ?? SYSTEM_SCHEDULE_USER_ID} as uuid),
      'active',
      1,
      ${upcoming},
      1,
      ${jsonbLiteral({ status: "scheduled", nextFireAt: upcoming.toISOString() })}
    )
    on conflict (tenant_id, definition_id)
    do update set
      version_id = excluded.version_id,
      trigger_node_id = excluded.trigger_node_id,
      cron = excluded.cron,
      timezone = excluded.timezone,
      started_by = excluded.started_by,
      status = 'active',
      generation = workflow.schedules.generation + 1,
      next_fire_at = excluded.next_fire_at,
      next_occurrence = 1,
      locked_at = null,
      locked_by = null,
      last_result = excluded.last_result,
      updated_at = now()
  `.execute(trx);

  return { status: "active" as const, nextFireAt: upcoming };
}

/**
 * The same rebuild, for a caller that has no transaction of its own.
 *
 * This opens a bare one, so no session exists on it and the tenant predicate
 * would see `app.tenant_id` unset and match nothing. It sets the tenant, and
 * only the tenant — this is not a worker and needs no cross-tenant reach.
 */
export async function syncWorkflowDefinitionSchedule(
  db: OpenShapeForgeDatabase,
  tenantId: string,
  definitionId: string,
  options: WorkflowScheduleSyncOptions = {},
) {
  return db.transaction().execute(async (trx) => {
    await applyWorkflowScheduleTenantSession(trx, tenantId);
    return syncWorkflowDefinitionScheduleInTransaction(trx, tenantId, definitionId, options);
  });
}

async function claimDueSchedules(
  trx: Transaction<DB>,
  options: Required<Pick<WorkflowScheduleWorkerOptions, "workerId" | "batchSize" | "now">>,
) {
  await applyWorkflowScheduleSession(trx);
  const result = await sql<{
    id: string;
    tenant_id: string;
    definition_id: string;
    version_id: string | null;
    trigger_node_id: string;
    cron: string;
    timezone: string;
    generation: number;
    next_fire_at: Date;
    next_occurrence: number;
    started_by: string | null;
  }>`
    select
      id::text,
      tenant_id::text,
      definition_id::text,
      version_id::text,
      trigger_node_id,
      cron,
      timezone,
      generation,
      next_fire_at,
      next_occurrence,
      started_by::text
    from workflow.schedules
    where status = 'active'
      and next_fire_at is not null
      and next_fire_at <= ${options.now}
    order by next_fire_at asc, updated_at asc
    limit ${options.batchSize}
    for update skip locked
  `.execute(trx);

  if (result.rows.length > 0) {
    await sql`
      update workflow.schedules
      set
        locked_at = now(),
        locked_by = ${options.workerId},
        updated_at = now()
      where id in (${sql.join(result.rows.map((row) => sql`cast(${row.id} as uuid)`))})
    `.execute(trx);
  }

  return result.rows.map((row): ClaimedSchedule => ({
    id: row.id,
    tenantId: row.tenant_id,
    definitionId: row.definition_id,
    versionId: row.version_id,
    triggerNodeId: row.trigger_node_id,
    cron: row.cron,
    timezone: row.timezone,
    generation: row.generation,
    nextFireAt: row.next_fire_at,
    nextOccurrence: row.next_occurrence,
    startedBy: row.started_by,
  }));
}

async function processClaimedSchedule(trx: Transaction<DB>, schedule: ClaimedSchedule) {
  await applyWorkflowScheduleSession(trx, schedule.tenantId);
  const published = await loadLatestPublishedDefinition(
    trx,
    schedule.tenantId,
    schedule.definitionId,
  );
  const currentSchedule = published
    ? extractScheduleNodes(published.definition)[0]
    : null;
  if (
    !published ||
    published.versionId !== schedule.versionId ||
    !currentSchedule ||
    currentSchedule.triggerNodeId !== schedule.triggerNodeId ||
    currentSchedule.cron !== schedule.cron ||
    currentSchedule.timezone !== schedule.timezone
  ) {
    await deactivateScheduleInTransaction(
      trx,
      schedule.tenantId,
      schedule.definitionId,
      "schedule_definition_mismatch",
    );
    return { started: 0, skipped: 1 };
  }

  const idempotencyKey = startIdempotencyKey(schedule);
  const fireId = randomUUID();
  const fire = await sql<{ id: string; inserted: boolean }>`
    with inserted as (
      insert into workflow.schedule_fires (
        id,
        tenant_id,
        schedule_id,
        definition_id,
        version_id,
        trigger_node_id,
        scheduled_at,
        occurrence,
        idempotency_key,
        status
      ) values (
        cast(${fireId} as uuid),
        cast(${schedule.tenantId} as uuid),
        cast(${schedule.id} as uuid),
        cast(${schedule.definitionId} as uuid),
        cast(${schedule.versionId} as uuid),
        ${schedule.triggerNodeId},
        ${schedule.nextFireAt},
        ${schedule.nextOccurrence},
        ${idempotencyKey},
        'started'
      )
      on conflict (tenant_id, definition_id, scheduled_at, occurrence)
      do nothing
      returning id::text, true as inserted
    )
    select id, inserted from inserted
    union all
    select id::text, false as inserted
    from workflow.schedule_fires
    where tenant_id = cast(${schedule.tenantId} as uuid)
      and definition_id = cast(${schedule.definitionId} as uuid)
      and scheduled_at = ${schedule.nextFireAt}
      and occurrence = ${schedule.nextOccurrence}
    limit 1
  `.execute(trx);

  const next = nextFireAt(schedule.cron, schedule.timezone, schedule.nextFireAt);
  if (!fire.rows[0]?.inserted) {
    await advanceSchedule(trx, schedule, next, {
      status: "duplicate",
      scheduledAt: schedule.nextFireAt.toISOString(),
      occurrence: schedule.nextOccurrence,
    });
    return { started: 0, skipped: 1 };
  }

  const start = await enqueueWorkflowInstanceStartInTransaction(
    trx,
    schedule.tenantId,
    {
      definitionId: schedule.definitionId,
      startedBy: schedule.startedBy ?? SYSTEM_SCHEDULE_USER_ID,
      context: {},
      triggerType: "schedule",
      triggerMeta: {
        scheduleId: schedule.id,
        triggerNodeId: schedule.triggerNodeId,
        scheduledAt: schedule.nextFireAt.toISOString(),
        occurrence: schedule.nextOccurrence,
        cron: schedule.cron,
        timezone: schedule.timezone,
      },
    },
  );

  await sql`
    update workflow.schedule_fires
    set
      workflow_instance_id = cast(${start.instanceId} as uuid),
      command_id = cast(${start.commandId} as uuid)
    where id = cast(${fire.rows[0].id} as uuid)
  `.execute(trx);

  await advanceSchedule(trx, schedule, next, {
    status: "started",
    scheduledAt: schedule.nextFireAt.toISOString(),
    occurrence: schedule.nextOccurrence,
    instanceId: start.instanceId,
    commandId: start.commandId,
    nextFireAt: next.toISOString(),
  });

  return { started: 1, skipped: 0 };
}

async function advanceSchedule(
  trx: Transaction<DB>,
  schedule: ClaimedSchedule,
  nextFire: Date,
  result: Record<string, unknown>,
) {
  await sql`
    update workflow.schedules
    set
      next_fire_at = ${nextFire},
      next_occurrence = ${schedule.nextOccurrence + 1},
      last_fired_at = ${schedule.nextFireAt},
      last_result = ${jsonbLiteral(result)},
      locked_at = null,
      locked_by = null,
      updated_at = now()
    where id = cast(${schedule.id} as uuid)
      and generation = ${schedule.generation}
  `.execute(trx);
}

export async function processWorkflowScheduleBatch(
  db: OpenShapeForgeDatabase,
  options: WorkflowScheduleWorkerOptions = {},
) {
  const workerOptions = {
    workerId: options.workerId ?? `workflow-schedule-worker-${randomUUID()}`,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    now: options.now ?? new Date(),
  };

  return db.transaction().execute(async (trx) => {
    const schedules = await claimDueSchedules(trx, workerOptions);
    let started = 0;
    let skipped = 0;

    for (const schedule of schedules) {
      const result = await processClaimedSchedule(trx, schedule);
      started += result.started;
      skipped += result.skipped;
    }

    return {
      processed: schedules.length,
      started,
      skipped,
    };
  });
}

export function startWorkflowScheduleWorker(
  db: OpenShapeForgeDatabase,
  options: WorkflowScheduleWorkerOptions = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let active = false;

  const tick = async () => {
    if (stopped || active) return;
    active = true;
    try {
      await processWorkflowScheduleBatch(db, options);
    } finally {
      active = false;
    }
  };

  const interval = setInterval(() => {
    void tick().catch((error) => {
      console.error({ error }, "Workflow schedule worker tick failed.");
    });
  }, pollIntervalMs);
  void tick().catch((error) => {
    console.error({ error }, "Workflow schedule worker initial tick failed.");
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
