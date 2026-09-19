// SPDX-License-Identifier: BUSL-1.1
/**
 * The `job-worker` role: one poll loop draining platform.jobs across tenants.
 *
 * It follows the workflow control-command worker exactly, because the
 * properties it needs are the same ones. The poll runs under the worker
 * session — `app.worker_role = 'job-worker'`, which the table's policy admits
 * across tenants because it declares `workerAccess: job-worker`; nothing is
 * bypassed. Each claimed job then runs its handler under an ordinary tenant
 * session for the job's tenant and the person who enqueued it, so every row
 * the handler touches is fenced the way that person's own request would be.
 *
 * The outcome is settled in a third, separate transaction. The handler's
 * tenant transaction commits before the settle, so a crash between the two
 * leaves a `running` row whose lease expires and is reclaimed — the handler
 * may run twice, which is why handlers that cause external effects must end
 * `outcome_unknown` when they cannot tell whether the effect happened,
 * rather than throw.
 */
import { sql, type Transaction } from "kysely";
import type { RuntimeJobError, RuntimeJobOutcome } from "@openshapeforge/plugin-runtime";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import type { ModuleWorkerHandle, ModuleWorkerLogger } from "../modules/contract.js";
import type { JobHandlerRegistry } from "./handlers.js";
import { sweepDoneJobs } from "./queries.js";
import { claimJobs, settleJob, type ClaimedJob, type SettleJobInput } from "./store.js";

/**
 * The worker role platform.jobs names in its policy (`workerAccess`). The
 * compiler wrote the same literal into the manifest; `jobs/__tests__` asserts
 * the two agree, because a mismatch fails silently as an empty queue.
 */
export const JOB_WORKER_ROLE = "job-worker";

export type JobWorkerOptions = {
  batchSize?: number;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  /** Restrict the poll to these kinds; every kind when absent. */
  kinds?: readonly string[];
  /** `done` jobs finished longer ago than this are swept; 0 disables the sweep. */
  doneRetentionDays?: number;
  sweepIntervalMs?: number;
};

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_DONE_RETENTION_DAYS = 30;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/** Read the worker's tunables from the environment; every one has a default. */
export function readJobWorkerOptions(env: NodeJS.ProcessEnv = process.env): JobWorkerOptions {
  const positive = (value: string | undefined, fallback: number, integer = true) => {
    const parsed = integer ? Number.parseInt(value ?? "", 10) : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && (!integer || Number.isInteger(parsed)) ? parsed : fallback;
  };
  return {
    batchSize: Math.max(1, positive(env.OPENSHAPEFORGE_JOBS_BATCH_SIZE, DEFAULT_BATCH_SIZE)),
    pollIntervalMs: Math.max(1, positive(env.OPENSHAPEFORGE_JOBS_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS)),
    leaseSeconds: Math.max(1, positive(env.OPENSHAPEFORGE_JOBS_LEASE_SECONDS, DEFAULT_LEASE_SECONDS)),
    doneRetentionDays: positive(env.OPENSHAPEFORGE_JOBS_DONE_RETENTION_DAYS, DEFAULT_DONE_RETENTION_DAYS),
  };
}

/**
 * The worker session: only the GUC, as the workflow worker sets it. The other
 * half of the policy predicate is the connection itself, which connects as
 * `openshapeforge_worker` and which nothing in a transaction can change.
 */
export async function withJobWorkerSession<T>(
  db: OpenShapeForgeDatabase,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.roles', ${JOB_WORKER_ROLE}, true)`.execute(trx);
    await sql`select set_config('app.worker_role', ${JOB_WORKER_ROLE}, true)`.execute(trx);
    return fn(trx);
  });
}

function errorOf(error: unknown): RuntimeJobError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { message: error.message, ...(typeof code === "string" ? { code } : {}) };
  }
  return { message: String(error) };
}

function isOutcome(value: unknown): value is RuntimeJobOutcome {
  return !!value && typeof value === "object" &&
    ["done", "retry", "failed", "outcome_unknown"].includes(String((value as { outcome?: unknown }).outcome));
}

/**
 * Run one claimed job to an outcome. Never throws: a handler that throws is a
 * `retry`, and a kind nobody handles is `dead` at once — retrying it would only
 * spend the attempt budget on a configuration problem.
 */
export async function runClaimedJob(
  db: OpenShapeForgeDatabase,
  job: ClaimedJob,
  handlers: JobHandlerRegistry,
  log: ModuleWorkerLogger,
): Promise<SettleJobInput> {
  const base = { id: job.id, claimToken: job.claimToken };
  const registered = handlers.get(job.kind);
  if (!registered) {
    return {
      ...base,
      outcome: "dead",
      error: { code: "NO_HANDLER", message: `No active runtime module handles job kind "${job.kind}".` },
    };
  }
  try {
    const outcome = await withDbSession(
      db,
      { tenantId: job.tenantId, userId: job.actorId, roles: [JOB_WORKER_ROLE] },
      (trx) =>
        registered.handler(job.payload, {
          job: {
            id: job.id,
            tenantId: job.tenantId,
            actorId: job.actorId,
            kind: job.kind,
            attempt: job.attempts,
            maxAttempts: job.maxAttempts,
            subject: job.subject,
          },
          db: trx,
          log,
        }),
    );
    if (outcome === undefined) return { ...base, outcome: "done" };
    if (!isOutcome(outcome)) {
      return { ...base, outcome: "failed", error: { code: "INVALID_OUTCOME", message: `Handler for "${job.kind}" returned an unrecognised outcome.` } };
    }
    return { ...base, ...outcome };
  } catch (error) {
    return { ...base, outcome: "retry", error: errorOf(error) };
  }
}

export type ProcessJobBatchResult = { processed: number };

export async function processJobBatch(
  db: OpenShapeForgeDatabase,
  handlers: JobHandlerRegistry,
  log: ModuleWorkerLogger,
  options: JobWorkerOptions = {},
): Promise<ProcessJobBatchResult> {
  const claimed = await withJobWorkerSession(db, (trx) =>
    claimJobs(trx, {
      limit: options.batchSize ?? DEFAULT_BATCH_SIZE,
      leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      ...(options.kinds ? { kinds: options.kinds } : {}),
    }),
  );
  for (const job of claimed) {
    const settlement = await runClaimedJob(db, job, handlers, log);
    const result = await withJobWorkerSession(db, (trx) => settleJob(trx, settlement));
    if (!result.settled) {
      log.warn({ job: job.id, kind: job.kind }, "Job lease was reclaimed before its outcome was recorded; discarding it.");
      continue;
    }
    if (settlement.outcome !== "done") {
      log.warn(
        { job: job.id, kind: job.kind, attempt: job.attempts, status: result.status, error: settlement.error },
        `Job ended ${result.status}.`,
      );
    }
  }
  return { processed: claimed.length };
}

/** Sweep `done` jobs past retention; a no-op when retention is 0. */
export async function sweepJobs(db: OpenShapeForgeDatabase, doneRetentionDays: number): Promise<number> {
  if (doneRetentionDays < 1) return 0;
  return withJobWorkerSession(db, (trx) => sweepDoneJobs(trx, doneRetentionDays));
}

export function startJobWorker(
  db: OpenShapeForgeDatabase,
  handlers: JobHandlerRegistry,
  log: ModuleWorkerLogger,
  options: JobWorkerOptions = {},
): ModuleWorkerHandle {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const doneRetentionDays = options.doneRetentionDays ?? DEFAULT_DONE_RETENTION_DAYS;
  let stopped = false;
  let active = false;
  let lastSweep = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number) => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void tick().catch((error) => log.error({ error: errorOf(error) }, "Job worker tick failed."));
    }, delayMs);
  };

  const tick = async () => {
    if (stopped || active) return;
    active = true;
    let nextDelayMs = pollIntervalMs;
    try {
      if (Date.now() - lastSweep >= sweepIntervalMs) {
        lastSweep = Date.now();
        const swept = await sweepJobs(db, doneRetentionDays);
        if (swept > 0) log.info({ swept, doneRetentionDays }, "Swept done jobs past retention.");
      }
      const result = await processJobBatch(db, handlers, log, options);
      nextDelayMs = result.processed > 0 ? 0 : pollIntervalMs;
    } finally {
      active = false;
      schedule(nextDelayMs);
    }
  };

  schedule(0);

  return {
    // Settles only after the in-flight tick: a job whose handler committed but
    // whose outcome was not yet recorded would otherwise wait for its lease.
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      while (active) await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}
