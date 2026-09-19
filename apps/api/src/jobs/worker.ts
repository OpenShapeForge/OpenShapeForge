// SPDX-License-Identifier: BUSL-1.1
/**
 * The `job-worker` role: one poll loop draining platform.jobs across tenants.
 *
 * It follows the workflow control-command worker exactly, because the
 * properties it needs are the same ones. The poll runs under the worker
 * session — `app.worker_role = 'job-worker'`, which the table's policy admits
 * across tenants because it declares `workerAccess: job-worker`; nothing is
 * bypassed. Each claimed job then runs its handler under an ordinary tenant
 * session that replays the session of the person who enqueued it — tenant,
 * user, roles, groups, RelationGroup memberships and scope, as the row
 * persisted them — so every row the handler touches is fenced the way that
 * person's own request would be. `job-worker` is added to that session only
 * as `app.worker_role`, never as a role: it opens the `workerDml` tables and
 * widens nothing else.
 *
 * One job per claim, claimed immediately before it runs, so the lease is
 * measured from the start of the run and a slow neighbour cannot eat it. The
 * handler's transaction first locks its own job row against the claim token:
 * a claim that was reclaimed meanwhile stops before any effect, and a held
 * lock keeps `claimJobs` (`skip locked`) from handing the job out while it
 * runs. The outcome is settled inside that same transaction, so the handler's
 * writes and the outcome commit together; only a handler that throws is
 * settled apart, as a `retry`, after its transaction rolled back.
 */
import { sql, type Transaction } from "kysely";
import type { RuntimeJobError, RuntimeJobOutcome } from "@openshapeforge/plugin-runtime";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import type { ModuleWorkerHandle, ModuleWorkerLogger } from "../modules/contract.js";
import type { JobHandlerRegistry } from "./handlers.js";
import { sweepDoneJobs } from "./queries.js";
import { claimJobs, lockClaimedJob, settleJob, type ClaimedJob, type SettleJobInput, type SettleJobResult } from "./store.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJobError(value: unknown): value is RuntimeJobError {
  return isRecord(value) && typeof value.message === "string" &&
    (value.code === undefined || typeof value.code === "string") &&
    (value.detail === undefined || isRecord(value.detail));
}

/**
 * The outcome a handler returned, or the `failed` that stands in for one it
 * did not: nothing is `done`, and anything else — an unknown outcome, a retry
 * without an error to record — is a handler bug, which no retry will fix.
 */
export function settlementOf(job: ClaimedJob, outcome: RuntimeJobOutcome | void): SettleJobInput {
  const base = { id: job.id, claimToken: job.claimToken };
  if (outcome === undefined) return { ...base, outcome: "done" };
  const invalid = (reason: string): SettleJobInput => ({
    ...base,
    outcome: "failed",
    error: { code: "INVALID_OUTCOME", message: `Handler for "${job.kind}" ${reason}.` },
  });
  if (!isRecord(outcome)) return invalid("returned something other than an outcome");
  const value = outcome as Record<string, unknown>;
  switch (value.outcome) {
    case "done":
      if (value.result !== undefined && !isRecord(value.result)) return invalid("returned a result that is not an object");
      return { ...base, outcome: "done", ...(value.result !== undefined ? { result: value.result } : {}) };
    case "retry":
      if (!isJobError(value.error)) return invalid("asked for a retry without an error");
      if (value.retryAt !== undefined && !(value.retryAt instanceof Date && Number.isFinite(value.retryAt.getTime()))) {
        return invalid("asked for a retry at an invalid time");
      }
      return { ...base, outcome: "retry", error: value.error, ...(value.retryAt !== undefined ? { retryAt: value.retryAt } : {}) };
    case "failed":
    case "outcome_unknown":
      if (!isJobError(value.error)) return invalid(`ended ${value.outcome} without an error`);
      return { ...base, outcome: value.outcome, error: value.error };
    default:
      return invalid(`returned an unrecognised outcome "${String(value.outcome)}"`);
  }
}

export type JobRunResult =
  | { ran: true; settlement: SettleJobInput; result: SettleJobResult }
  /** The claim no longer held when the run began: another worker owns the job now. */
  | { ran: false };

/**
 * Run one claimed job to its settled outcome. Never throws: a handler that
 * throws is a `retry`, and a kind nobody handles is `dead` at once — retrying
 * it would only spend the attempt budget on a configuration problem.
 */
export async function runClaimedJob(
  db: OpenShapeForgeDatabase,
  job: ClaimedJob,
  handlers: JobHandlerRegistry,
  log: ModuleWorkerLogger,
): Promise<JobRunResult> {
  const settleApart = async (settlement: SettleJobInput): Promise<JobRunResult> => ({
    ran: true,
    settlement,
    result: await withJobWorkerSession(db, (trx) => settleJob(trx, settlement)),
  });
  const registered = handlers.get(job.kind);
  if (!registered) {
    return settleApart({
      id: job.id,
      claimToken: job.claimToken,
      outcome: "dead",
      error: { code: "NO_HANDLER", message: `No active runtime module handles job kind "${job.kind}".` },
    });
  }
  try {
    return await withDbSession(
      db,
      { tenantId: job.tenantId, userId: job.actorId, ...job.actorSession },
      async (trx): Promise<JobRunResult> => {
        if (!(await lockClaimedJob(trx, job))) return { ran: false };
        await sql`select set_config('app.worker_role', ${JOB_WORKER_ROLE}, true)`.execute(trx);
        const outcome = await registered.handler(job.payload, {
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
        });
        const settlement = settlementOf(job, outcome);
        return { ran: true, settlement, result: await settleJob(trx, settlement) };
      },
    );
  } catch (error) {
    return settleApart({ id: job.id, claimToken: job.claimToken, outcome: "retry", error: errorOf(error) });
  }
}

export type ProcessJobBatchResult = { processed: number };

/**
 * Claim and run up to `batchSize` jobs, one claim per job, stopping early
 * when `shouldStop` says so — a job never claimed needs no releasing.
 */
export async function processJobBatch(
  db: OpenShapeForgeDatabase,
  handlers: JobHandlerRegistry,
  log: ModuleWorkerLogger,
  options: JobWorkerOptions = {},
  shouldStop: () => boolean = () => false,
): Promise<ProcessJobBatchResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let processed = 0;
  while (processed < batchSize && !shouldStop()) {
    const [job] = await withJobWorkerSession(db, (trx) =>
      claimJobs(trx, {
        limit: 1,
        leaseSeconds: options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
        ...(options.kinds ? { kinds: options.kinds } : {}),
      }),
    );
    if (!job) break;
    processed += 1;
    const run = await runClaimedJob(db, job, handlers, log);
    if (!run.ran || !run.result.settled) {
      log.warn({ job: job.id, kind: job.kind }, "Job lease was reclaimed by another worker; leaving the outcome to it.");
      continue;
    }
    if (run.settlement.outcome !== "done") {
      log.warn(
        { job: job.id, kind: job.kind, attempt: job.attempts, status: run.result.status, error: run.settlement.error },
        `Job ended ${run.result.status}.`,
      );
    }
  }
  return { processed };
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
      const result = await processJobBatch(db, handlers, log, options, () => stopped);
      nextDelayMs = result.processed > 0 ? 0 : pollIntervalMs;
    } finally {
      active = false;
      schedule(nextDelayMs);
    }
  };

  schedule(0);

  return {
    // Settles only after the in-flight job: the tick checks `stopped` before
    // every claim, so the jobs it has not started stay queued for the next
    // worker and the one it is running finishes and records its outcome.
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
