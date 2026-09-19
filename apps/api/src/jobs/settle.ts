// SPDX-License-Identifier: BUSL-1.1
/**
 * The end of a claimed run: the lock a running handler holds on its own
 * row, and the settle that records the outcome. Both are guarded by the
 * one-time claim token `store.ts` issued at claim, so only the holder of the
 * live claim can do either.
 */
import { sql, type Transaction } from "kysely";
import type { RuntimeJobError } from "@openshapeforge/plugin-runtime";
import type { DB } from "../generated/db/types.js";
import type { JobStatus } from "../db/migrations/jobs.js";
import { hashClaimToken } from "./store.js";

export type SettleJobInput = {
  id: string;
  claimToken: string;
} & (
  | { outcome: "done"; result?: Record<string, unknown> }
  | { outcome: "retry"; error: RuntimeJobError; retryAt?: Date }
  | { outcome: "failed"; error: RuntimeJobError }
  | { outcome: "outcome_unknown"; error: RuntimeJobError }
  /** Worker-internal: a kind no module handles is closed at once, not retried. */
  | { outcome: "dead"; error: RuntimeJobError }
);

export type SettleJobResult =
  | { settled: true; status: JobStatus }
  /** The claim no longer holds: the lease expired and another worker owns the job now. */
  | { settled: false };

const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 60 * 60 * 1_000;
/** A dead-letter or unknown outcome keeps the last 2 KiB of a message, like the workflow queue. */
const MAX_ERROR_MESSAGE = 2_000;

/**
 * Exponential with a cap and ±20% jitter, so a burst of failures against one
 * dependency does not come back as one synchronized burst of retries.
 */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.round(exponential * jitter);
}

function boundedError(error: RuntimeJobError): RuntimeJobError {
  return {
    message: String(error.message ?? "").slice(0, MAX_ERROR_MESSAGE),
    ...(error.code ? { code: String(error.code) } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
  };
}

/**
 * Lock the claimed row for the rest of the calling transaction, proving the
 * claim still holds. The handler's own transaction calls this before it does
 * anything: a claim whose lease expired and was handed to another worker
 * matches nothing here, so the stale holder stops before any effect — and
 * while the lock is held, `claimJobs` (`skip locked`) cannot hand the job to
 * anyone else, however long the run takes.
 */
export async function lockClaimedJob(trx: Transaction<DB>, input: { id: string; claimToken: string }): Promise<boolean> {
  const held = await sql<{ present: number }>`
    select 1 as present from platform.jobs
    where id = ${input.id}::uuid and status = 'running' and claim_token_hash = ${hashClaimToken(input.claimToken)}
    for update
  `.execute(trx);
  return held.rows.length === 1;
}

/**
 * Record how a claimed run ended. Only the holder of the live claim can:
 * the predicate checks the token hash and `running`, so a settle after the
 * lease was reclaimed matches nothing and reports `settled: false` — the
 * later claimer's outcome is the one that stands.
 */
export async function settleJob(trx: Transaction<DB>, input: SettleJobInput): Promise<SettleJobResult> {
  const current = await trx
    .selectFrom("platform.jobs")
    .select(["attempts", "max_attempts"])
    .where("id", "=", input.id)
    .where("status", "=", "running")
    .where("claim_token_hash", "=", hashClaimToken(input.claimToken))
    .forUpdate()
    .executeTakeFirst();
  if (!current) return { settled: false };

  const terminal = (status: JobStatus, error: RuntimeJobError | null, result: Record<string, unknown> | null) => ({
    status,
    last_error: error ? JSON.stringify(boundedError(error)) : null,
    result: result ? JSON.stringify(result) : null,
    completed_at: sql<Date>`now()`,
  });
  const exhausted = input.outcome === "retry" && current.attempts >= current.max_attempts;
  const next = input.outcome === "done"
    ? terminal("done", null, input.result ?? null)
    : input.outcome === "failed"
      ? terminal("failed", input.error, null)
      : input.outcome === "outcome_unknown"
        ? terminal("outcome_unknown", input.error, null)
        : input.outcome === "dead"
          ? terminal("dead", input.error, null)
        : exhausted
          ? terminal("dead", input.error, null)
          : {
              status: "queued" as JobStatus,
              last_error: JSON.stringify(boundedError(input.error)),
              result: null,
              completed_at: null,
              available_at: input.retryAt ?? sql<Date>`now() + (${retryDelayMs(current.attempts)} || ' milliseconds')::interval`,
            };

  await trx
    .updateTable("platform.jobs")
    .set({ ...next, lease_until: null, claim_token_hash: null, updated_at: sql<Date>`now()` })
    .where("id", "=", input.id)
    .execute();
  return { settled: true, status: next.status };
}
