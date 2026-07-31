// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import type { DB } from "../../../../apps/api/src/generated/db/types.js";
import {
  applyWorkflowCommandRuntimeCancel,
  applyWorkflowCommandRuntimeResume,
  applyWorkflowCommandRuntimeStart,
} from "./command-runtime.js";

export type WorkflowControlCommandRecord = {
  id: string;
  tenantId: string;
  commandType: string;
  workflowInstanceId: string | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

export type WorkflowControlCommandDispatcher = {
  dispatch: (command: WorkflowControlCommandRecord) => Promise<void>;
};

export type WorkflowControlCommandWorkerOptions = {
  workerId?: string;
  batchSize?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  /**
   * Visibility timeout for rows stuck in 'processing'. A worker that crashes
   * between claiming a command and marking it completed/failed would otherwise
   * strand the row forever; rows older than this are reclaimed by the next
   * poll. A redispatch is idempotent because the command row is consumed
   * conditionally, and reclaim is bounded by maxAttempts.
   */
  processingTimeoutMs?: number;
};

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROCESSING_TIMEOUT_MS = 120_000;

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return normalizeRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/**
 * The one way a claimed command becomes work.
 *
 * A single method, because the queue is where durability lives: a command is a
 * row claimed with `for update skip locked`, and a worker that dies mid-command
 * leaves it reclaimable by the visibility timeout below. An external
 * durable-execution service is therefore one possible implementation of this
 * interface rather than a dependency — and the in-process one below is enough,
 * because idempotency comes from the command row's conditional consume and the
 * instance row lock, not from whoever dispatches.
 */
export function createInProcessWorkflowControlCommandDispatcher(
  db: OpenShapeForgeDatabase,
): WorkflowControlCommandDispatcher {
  return {
    dispatch: async (command) => {
      const instanceId = command.workflowInstanceId;
      if (!instanceId) {
        throw new Error(
          `Workflow control command ${command.id} (${command.commandType}) carries no instance id.`,
        );
      }
      const input = {
        commandId: command.id,
        tenantId: command.tenantId,
        instanceId,
        payload: command.payload,
      };
      switch (command.commandType) {
        case "workflow.instance.start":
          await applyWorkflowCommandRuntimeStart(db, input);
          return;
        case "workflow.instance.resume":
          await applyWorkflowCommandRuntimeResume(db, input);
          return;
        case "workflow.instance.cancel":
          await applyWorkflowCommandRuntimeCancel(db, input);
          return;
        default:
          throw new Error(
            `Unsupported workflow control command type: ${command.commandType}`,
          );
      }
    },
  };
}

/**
 * Row security for a worker poll.
 *
 * The queue is tenant-scoped and RLS'd, but a claim is cross-tenant by nature:
 * it scans every pending command, precisely so one tenant's backlog does not
 * need its own worker. So the claim must run with the policy bypassed.
 *
 * This repo's sanctioned bypass is `withSystemSession`, which requires the
 * bypass role and a reason and writes an audit row before and after — designed
 * for rare, justified operations. A poll loop is neither: at the default
 * one-second interval it would write roughly 172,000 audit rows a day per
 * worker and drown the break-glass trail it exists to keep readable.
 *
 * Until that is settled the session is applied directly: same GUCs, no audit
 * row. This is a deliberate, narrow exception to the repo's bypass discipline,
 * and it is why no role starts this worker yet — nothing calls it in
 * production. It must not ship that way.
 */
async function applyWorkerSession(trx: Transaction<DB>) {
  await sql`select set_config('app.roles', 'workflow-worker', true)`.execute(trx);
  await sql`select set_config('app.bypass_rls', 'true', true)`.execute(trx);
}

async function claimPendingCommands(
  db: OpenShapeForgeDatabase,
  options: Required<
    Pick<
      WorkflowControlCommandWorkerOptions,
      "workerId" | "batchSize" | "maxAttempts" | "processingTimeoutMs"
    >
  >,
) {
  return db.transaction().execute(async (trx) => {
    await applyWorkerSession(trx);
    // Claims fresh 'pending' commands plus 'processing' commands orphaned by a
    // crashed worker (locked longer than processingTimeoutMs). A reclaimed
    // redispatch is idempotent because the consume is conditional. Reclaim
    // is bounded by maxAttempts so a perpetually-stuck command eventually stops.
    const result = await sql<{
      id: string;
      tenant_id: string;
      command_type: string;
      workflow_instance_id: string | null;
      idempotency_key: string | null;
      payload: unknown;
      attempts: number;
    }>`
      update workflow.control_commands
      set
        status = 'processing',
        attempts = attempts + 1,
        locked_at = now(),
        locked_by = ${options.workerId},
        updated_at = now()
      where id in (
        select id
        from workflow.control_commands
        where (
            status = 'pending'
            and (next_attempt_at is null or next_attempt_at <= now())
          )
          or (
            status = 'processing'
            and attempts < ${options.maxAttempts}
            and locked_at < now() - (${options.processingTimeoutMs} || ' milliseconds')::interval
          )
        order by created_at asc
        limit ${options.batchSize}
        for update skip locked
      )
      returning
        id::text,
        tenant_id::text,
        command_type,
        workflow_instance_id::text,
        idempotency_key,
        payload,
        attempts
    `.execute(trx);

    return result.rows.map((row): WorkflowControlCommandRecord => ({
      id: row.id,
      tenantId: row.tenant_id,
      commandType: row.command_type,
      workflowInstanceId: row.workflow_instance_id,
      idempotencyKey: row.idempotency_key,
      payload: normalizeRecord(row.payload),
      attempts: row.attempts,
    }));
  });
}

async function markCommandCompleted(db: OpenShapeForgeDatabase, commandId: string) {
  await db.transaction().execute(async (trx) => {
    await applyWorkerSession(trx);
    await sql`
      update workflow.control_commands
      set
        status = 'completed',
        locked_at = null,
        locked_by = null,
        last_error = null,
        updated_at = now()
      where id = cast(${commandId} as uuid)
    `.execute(trx);
  });
}

async function markCommandFailed(
  db: OpenShapeForgeDatabase,
  command: WorkflowControlCommandRecord,
  error: unknown,
  maxAttempts: number,
) {
  const message = error instanceof Error ? error.message : String(error);
  const terminal = command.attempts >= maxAttempts;

  await db.transaction().execute(async (trx) => {
    await applyWorkerSession(trx);
    await sql`
      update workflow.control_commands
      set
        status = ${terminal ? "failed" : "pending"},
        locked_at = null,
        locked_by = null,
        last_error = ${message.slice(0, 2_000)},
        next_attempt_at = ${terminal ? sql`null` : sql`now() + interval '30 seconds'`},
        updated_at = now()
      where id = cast(${command.id} as uuid)
    `.execute(trx);
  });
}

export async function processWorkflowControlCommandBatch(
  db: OpenShapeForgeDatabase,
  dispatcher: WorkflowControlCommandDispatcher,
  options: WorkflowControlCommandWorkerOptions = {},
) {
  const workerOptions = {
    workerId: options.workerId ?? `workflow-worker-${randomUUID()}`,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    processingTimeoutMs: options.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS,
  };

  const commands = await claimPendingCommands(db, workerOptions);
  for (const command of commands) {
    try {
      await dispatcher.dispatch(command);
      await markCommandCompleted(db, command.id);
    } catch (error) {
      await markCommandFailed(db, command, error, workerOptions.maxAttempts);
    }
  }

  return {
    processed: commands.length,
  };
}

export function startWorkflowControlCommandWorker(
  db: OpenShapeForgeDatabase,
  dispatcher: WorkflowControlCommandDispatcher,
  options: WorkflowControlCommandWorkerOptions = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number) => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void tick().catch((error) => {
        console.error({ error }, "Workflow control command worker tick failed.");
      });
    }, delayMs);
  };

  const tick = async () => {
    if (stopped || active) return;
    active = true;
    let nextDelayMs = pollIntervalMs;
    try {
      const result = await processWorkflowControlCommandBatch(db, dispatcher, options);
      nextDelayMs = result.processed > 0 ? 0 : pollIntervalMs;
    } finally {
      active = false;
      schedule(nextDelayMs);
    }
  };

  schedule(0);

  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      while (active) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}
