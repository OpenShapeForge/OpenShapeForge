// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import type { DB } from "../../../../apps/api/src/generated/db/types.js";
import { WORKFLOW_WORKER_ROLE } from "../worker-role.js";
import {
  applyWorkflowCommandRuntimeCancel,
  applyWorkflowCommandRuntimeResume,
  applyWorkflowCommandRuntimeStart,
} from "./command-runtime.js";
import { createRestateWorkflowControlCommandDispatcher } from "./restate-dispatcher.js";

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

export type WorkflowRestateDispatchConfig = {
  ingressUrl: string;
  workflowCommandServiceName: string;
  timeoutMs: number;
};

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROCESSING_TIMEOUT_MS = 120_000;
const DEFAULT_RESTATE_TIMEOUT_MS = 120_000;

/**
 * The exact value `OPENSHAPEFORGE_WORKFLOW_RESTATE_CONTRACT` must carry before
 * commands are dispatched to a durable-execution service.
 *
 * A reachable ingress is not consent. An ingress URL can arrive from a shared
 * environment, a copied deployment manifest or a sidecar's own defaults, and
 * any of those would silently move every workflow in the deployment onto a
 * service the operator never chose. Requiring a token nobody sets by accident
 * makes that impossible, and pins which request shape the deployed handlers
 * expect — a later incompatible shape takes a new token rather than quietly
 * meeting an ingress that still answers on the old one.
 */
const RESTATE_DISPATCH_CONTRACT = "workflow-command-v1";

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

function normalizeUrl(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized.replace(/\/$/, "") : null;
}

function normalizePositiveInteger(
  value: string | number | null | undefined,
  fallback: number,
) {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The durable-execution configuration, or null when this deployment has not
 * asked for one. Both the contract token and an ingress are required; either
 * alone is not an answer.
 */
export function readWorkflowRestateDispatchConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkflowRestateDispatchConfig | null {
  if (env.OPENSHAPEFORGE_WORKFLOW_RESTATE_CONTRACT !== RESTATE_DISPATCH_CONTRACT) {
    return null;
  }

  const ingressUrl = normalizeUrl(
    env.OPENSHAPEFORGE_WORKFLOW_RESTATE_INGRESS_URL ?? env.RESTATE_INGRESS_URL,
  );
  if (!ingressUrl) {
    return null;
  }

  return {
    ingressUrl,
    workflowCommandServiceName:
      env.OPENSHAPEFORGE_WORKFLOW_RESTATE_COMMAND_SERVICE ?? "WorkflowCommandRuntime",
    timeoutMs: normalizePositiveInteger(
      env.OPENSHAPEFORGE_WORKFLOW_RESTATE_TIMEOUT_MS,
      DEFAULT_RESTATE_TIMEOUT_MS,
    ),
  };
}

/**
 * The dispatcher this deployment should drain the queue with.
 *
 * In-process is the default and durable execution is the upgrade — deliberately
 * that way round. The shape this follows treats an absent Restate config as
 * "command dispatch off", which is a defensible posture for a deployment that
 * always runs a Restate sidecar and never intends to run without one. It is the
 * wrong posture here: a default deployment of this repo has no sidecar, so
 * "off" would mean no workflow can start, resume or cancel at all, and the
 * queue would fill with commands nothing ever claims. A workflow engine whose
 * out-of-the-box behaviour is to accept work and never do it is not a safer
 * default, it is a broken one.
 *
 * Callers take the dispatcher and hand it to the worker. Which one they got is
 * not their business: both satisfy the same interface, and correctness does not
 * depend on the answer — see the note on idempotency in `command-runtime.ts`.
 */
export function createWorkflowControlCommandDispatcher(
  db: OpenShapeForgeDatabase,
  env: NodeJS.ProcessEnv = process.env,
): WorkflowControlCommandDispatcher {
  const restateConfig = readWorkflowRestateDispatchConfig(env);
  return restateConfig
    ? createRestateWorkflowControlCommandDispatcher(restateConfig)
    : createInProcessWorkflowControlCommandDispatcher(db);
}

/**
 * Row security for a worker poll.
 *
 * The queue is tenant-scoped and RLS'd, but a claim is cross-tenant by nature:
 * it scans every pending command, precisely so one tenant's backlog does not
 * need its own worker.
 *
 * Nothing here is bypassed. `workflow.control_commands` declares
 * `workerAccess: WORKFLOW_WORKER_ROLE` (see the plugin's `index.ts`), so its
 * policy admits a session presenting that role directly:
 *
 *   USING (app.bypass_rls()
 *          OR app.current_worker_role() = 'workflow-worker'
 *          OR (tenant_id = app.current_tenant()))
 *
 * That is the whole grant. A session holding only `app.worker_role` reaches the
 * three queue tables that asked for it and no others — reading `erp.relations`
 * from here returns nothing, which is the property that makes this worth doing.
 * Setting `app.bypass_rls` instead would have granted read AND write on every
 * tenant-scoped table in the manifest, to read a queue.
 *
 * No audit row, because there is no bypass to audit — which is also why the
 * poll loop's rate stops being a problem for the break-glass trail.
 */
async function applyWorkerSession(trx: Transaction<DB>) {
  await sql`select set_config('app.roles', ${WORKFLOW_WORKER_ROLE}, true)`.execute(trx);
  await sql`select set_config('app.worker_role', ${WORKFLOW_WORKER_ROLE}, true)`.execute(trx);
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
