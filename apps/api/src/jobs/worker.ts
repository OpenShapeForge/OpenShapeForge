// SPDX-License-Identifier: BUSL-1.1
/**
 * The `job-worker` role: one poll loop draining platform.jobs across tenants.
 *
 * The poll runs under the worker
 * session — `app.worker_role = 'job-worker'`, which the table's policy admits
 * across tenants because it declares `workerAccess: job-worker`; nothing is
 * bypassed. Each claimed job then runs its handler under an ordinary tenant
 * session that replays the session of the person who enqueued it — tenant,
 * user, roles, groups, RelationGroup memberships and scope, as the row
 * persisted them — so every row the handler touches is fenced the way that
 * person's own request would be. That session never names `job-worker`, in
 * `app.roles` or in `app.worker_role`: the worker GUC is the cross-tenant
 * widen of the queue's own policy, and a handler that held it could read
 * every tenant's jobs. The lock and the settle below reach the job's row
 * through the tenant predicate alone, and the `workerDml` tables through
 * the GRANTs the connection already holds.
 *
 * One job per claim, claimed immediately before it runs, so the lease is
 * measured from the start of the run and a slow neighbour cannot eat it. The
 * handler's transaction first locks its own job row against the claim token:
 * a claim that was reclaimed meanwhile stops before any effect, and a held
 * lock keeps `claimJobs` (`skip locked`) from handing the job out while it
 * runs. The outcome is settled inside that same transaction, so the handler's
 * writes and the outcome commit together. Once a handler starts, the generic
 * worker cannot prove that a thrown error happened before an external effect,
 * so an unclassified throw is settled apart as `outcome_unknown`. A handler
 * that knows repetition is safe returns the explicit `retry` outcome instead.
 *
 * Between that lock and the handler sits the host execution admission guard
 * (operations/execution-policy.ts). A job is the one execution path whose
 * authorization is older than its effects — it was admitted when it was
 * enqueued, and it runs whenever a worker gets to it — so a tenant that may
 * no longer change anything must be refused here, before the handler writes a
 * row or delivers a message. That refusal is a KNOWN outcome: nothing ran, so
 * it is never `outcome_unknown`.
 */
import { sql, type Transaction } from "kysely";
import type { OperationError } from "@openshapeforge/operations";
import type { RuntimeJobError, RuntimeJobOutcome } from "@openshapeforge/plugin-runtime";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import type { ModuleWorkerHandle, ModuleWorkerLogger } from "../modules/contract.js";
import { operationAdmissionRefusal } from "../operations/execution-policy.js";
import type { JobHandlerRegistry } from "./handlers.js";
import { sweepDoneJobs } from "./queries.js";
import {
  lockClaimedJob,
  retryDelayMs,
  settleJob,
  type SettleJobInput,
  type SettleJobResult,
} from "./settle.js";
import { claimJobs, type ClaimedJob } from "./store.js";
import {
  inboundBodyRetention, overdueInboundDeliveryBodies, purgeInboundDeliveryBodies,
  type InboundBodyRetention, type OverdueInboundBodies,
} from "./inbound/retention.js";

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
  /**
   * Bounds on how long a SETTLED inbound delivery keeps its retained payload,
   * and the age at which an unsettled one is reported overdue. Not disableable,
   * unlike the job sweep above: the payload is tenant data, and "keep it until
   * someone notices" is not a lifecycle (jobs/inbound/retention.ts).
   */
  inboundBodyRetention?: InboundBodyRetention;
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
    inboundBodyRetention: inboundBodyRetention(env),
  };
}

/**
 * The worker session: only the GUC. The other
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
 * What a queued job is, as far as a host execution policy is concerned.
 *
 * A job handler is a function; nothing in the compiler declares what it
 * writes, and the payload that would claim to is the caller's. So core
 * classifies every queued run as the governed case — a data change that may
 * also write externally — which is what `mail.deliver` is and what any
 * handler is allowed to be. The identity is the registered kind, never a
 * value from the row's payload.
 */
const QUEUED_JOB_EFFECTS = { data: "write", external: "write" } as const;

/**
 * The session a claimed job runs under: the verified session snapshot the
 * enqueue persisted, replayed whole.
 *
 * Whole, because this is both the database session the handler writes through
 * AND the session a host execution policy decides on — and the public session
 * contract declares `credential` required. A snapshot of roles and groups
 * alone would hand a policy `credential: undefined`, so an API-key rule that
 * refuses interactive writes would admit the same work here. Core adds
 * nothing to the snapshot and infers nothing: `jobs/actor-session.ts` refuses
 * a row whose credential is not one a job may carry.
 */
export function replayedJobSession(job: ClaimedJob): TrustedSessionContext {
  const { credential, roles, groups, relationGroupIds, relationId, scope,
    oauthScopes, locale, userDisplayName } = job.actorSession;
  return {
    tenantId: job.tenantId,
    userId: job.actorId,
    credential,
    roles: [...roles],
    groups: [...groups],
    relationGroupIds,
    scope,
    ...(relationId ? { relationId } : {}),
    ...(oauthScopes ? { oauthScopes: [...oauthScopes] } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(userDisplayName !== undefined ? { userDisplayName } : {}),
  } as TrustedSessionContext;
}

/**
 * The refusal settlement for a job a policy would not admit: requeued for
 * the moment the refusal names, attempt-neutral, or terminally `failed` when
 * the refusal names no end. Either way the queue records the structured
 * denial — never the worker's generic `outcome_unknown`, which would claim an
 * external effect may have happened when the handler never started.
 */
export function refusedJobSettlement(
  job: ClaimedJob,
  denial: OperationError,
  now: number = Date.now(),
): SettleJobInput {
  const error: RuntimeJobError = {
    code: denial.code,
    message: denial.message,
    ...(denial.detail ? { detail: { reason: denial.detail } } : {}),
  };
  const base = { id: job.id, claimToken: job.claimToken, error };
  const named = typeof denial.retryAt === "string" ? Date.parse(denial.retryAt) : Number.NaN;
  if (Number.isFinite(named)) {
    return { ...base, outcome: "not_admitted", retryAt: new Date(Math.max(named, now)) };
  }
  // Retryable with no named end: come back on the ordinary backoff rather
  // than closing work the host may well admit in a minute.
  if (denial.retryable) {
    return {
      ...base,
      outcome: "not_admitted",
      retryAt: new Date(now + retryDelayMs(job.attempts)),
    };
  }
  return { ...base, outcome: "failed" };
}

/**
 * Run one claimed job to its settled outcome. A kind nobody handles is `dead`
 * at once — retrying it would only spend the attempt budget on a configuration
 * problem. A run a host execution policy refuses is settled without starting
 * the handler ({@link refusedJobSettlement}). Once the handler has started, an
 * unclassified failure is
 * `outcome_unknown`: the worker cannot know whether an external effect already
 * happened. Handlers opt into automatic retry by returning `retry` explicitly.
 *
 * A handler's classified outcome is remembered outside its tenant transaction.
 * If settling or committing that transaction fails, the worker records that
 * same `retry`, `failed`, or `outcome_unknown` outcome in a fresh worker
 * transaction. `done` is the sole exception: after a commit failure the worker
 * cannot prove whether the handler's effects committed, so it becomes
 * `outcome_unknown` and requires reconciliation.
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
  let handlerStarted = false;
  let handlerSettlement: SettleJobInput | undefined;
  const replayed = replayedJobSession(job);
  try {
    return await withDbSession(
      db,
      replayed,
      async (trx): Promise<JobRunResult> => {
        if (!(await lockClaimedJob(trx, job))) return { ran: false };
        // Admission inside the claim's own transaction, after the claim is
        // proven to still hold and immediately before the handler: the policy
        // reads the live persisted state through this very transaction, so a
        // tenant that lost its writes while this job waited in the queue — or
        // while this worker waited for the lock — is refused here rather than
        // on the admission its enqueue once had. The claim and the settle
        // around it are the host's own queue bookkeeping and stay outside.
        const denial = await operationAdmissionRefusal(
          db,
          replayed,
          { id: job.kind, intent: "job", effects: QUEUED_JOB_EFFECTS },
        );
        if (denial) {
          const settlement = refusedJobSettlement(job, denial);
          return { ran: true, settlement, result: await settleJob(trx, settlement) };
        }
        handlerStarted = true;
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
        handlerSettlement = settlement;
        return { ran: true, settlement, result: await settleJob(trx, settlement) };
      },
    );
  } catch (error) {
    if (handlerSettlement) {
      if (handlerSettlement.outcome !== "done") return settleApart(handlerSettlement);
      return settleApart({
        id: job.id,
        claimToken: job.claimToken,
        outcome: "outcome_unknown",
        error: {
          code: "JOB_COMMIT_OUTCOME_UNKNOWN",
          message: "The handler completed, but its transaction outcome could not be confirmed.",
        },
      });
    }
    const failure = errorOf(error);
    return settleApart({
      id: job.id,
      claimToken: job.claimToken,
      outcome: handlerStarted ? "outcome_unknown" : "retry",
      error: failure,
    });
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

/**
 * Remove retained payloads of settled inbound deliveries past their bounds, and
 * report the unsettled ones past the same age that were deliberately kept.
 * Beside `sweepJobs` because it rides the same tick and the same worker
 * session, and separate from it because it has no "0 disables it" case.
 */
export function sweepInboundBodies(
  db: OpenShapeForgeDatabase, retention: InboundBodyRetention,
): Promise<{ purged: number; overdue: OverdueInboundBodies }> {
  return withJobWorkerSession(db, async (trx) => ({
    purged: await purgeInboundDeliveryBodies(trx, retention),
    overdue: await overdueInboundDeliveryBodies(trx, retention),
  }));
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
  const bodyRetention = options.inboundBodyRetention ?? inboundBodyRetention();
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
        // Separate from the job sweep: this one removes tenant payload rather
        // than finished bookkeeping, so it runs whatever the job retention is
        // set to and reports what it removed.
        const bodies = await sweepInboundBodies(db, bodyRetention);
        if (bodies.purged > 0) {
          log.info(
            { purged: bodies.purged, ...bodyRetention },
            "Removed retained payloads of settled inbound deliveries past retention.",
          );
        }
        // Accepted work that has not settled is kept, however old: the 2xx the
        // provider got was a durable acceptance and these are the only bytes
        // left. A log line is the whole of the escalation today — an operator
        // alert on this count, and admission backpressure so the backlog stops
        // growing at the edge, are not implemented.
        if (bodies.overdue.count > 0) {
          log.warn(
            {
              overdue: bodies.overdue.count,
              oldestReceivedAt: bodies.overdue.oldestReceivedAt?.toISOString(),
              maxAgeDays: bodyRetention.maxAgeDays,
            },
            "Inbound deliveries accepted long ago have still not settled; their payloads are retained and need operator action.",
          );
        }
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
