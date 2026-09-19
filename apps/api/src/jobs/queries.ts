// SPDX-License-Identifier: BUSL-1.1
/**
 * The operator's side of platform.jobs — read, retry, sweep — under whatever
 * session the caller holds; the queue mechanics live in `store.ts`.
 */
import { sql, type Transaction } from "kysely";
import type { RuntimeJobSubject } from "@openshapeforge/plugin-runtime";
import type { DB } from "../generated/db/types.js";
import type { JobStatus } from "../db/migrations/jobs.js";
import { ROW_COLUMNS, toRecord, type JobExecutor, type JobRecord, type Row } from "./store.js";

export type ResolveJobInput = { id: string; action: "requeue" | "done" };

/**
 * An operator's decision on a job that stopped: `requeue` gives a
 * `failed`, `dead` or `outcome_unknown` job a fresh attempt budget; `done`
 * closes it as delivered (the effect was confirmed out of band). Returns the
 * job, or undefined when it is not in a resolvable state.
 */
export async function resolveJob(trx: Transaction<DB>, input: ResolveJobInput): Promise<JobRecord | undefined> {
  const row = await trx
    .updateTable("platform.jobs")
    .set(
      input.action === "requeue"
        ? { status: "queued", attempts: 0, available_at: sql<Date>`now()`, completed_at: null, updated_at: sql<Date>`now()` }
        : { status: "done", completed_at: sql<Date>`now()`, updated_at: sql<Date>`now()` },
    )
    .where("id", "=", input.id)
    .where("status", "in", ["failed", "dead", "outcome_unknown"])
    .returning(ROW_COLUMNS)
    .executeTakeFirst();
  return row ? toRecord(row as Row) : undefined;
}

export async function getJob(db: JobExecutor, id: string): Promise<JobRecord | undefined> {
  const row = await db.selectFrom("platform.jobs").select(ROW_COLUMNS).where("id", "=", id).executeTakeFirst();
  return row ? toRecord(row as Row) : undefined;
}

export type ListJobsInput = {
  kind?: string;
  status?: JobStatus;
  subject?: RuntimeJobSubject;
  limit: number;
  /** The `sequence` of the last row seen. */
  cursor?: string;
};

const CURSOR = /^[1-9][0-9]{0,18}$/;
const BIGINT_MAX = 9223372036854775807n;

/** A `sequence` value: digits only, within bigint, so a bad cursor is a 400 and never a database error. */
function cursorOf(value: string): string {
  if (!CURSOR.test(value) || BigInt(value) > BIGINT_MAX) throw new Error("Invalid jobs cursor.");
  return value;
}

/**
 * Newest first, paged on the insertion `sequence`: a bigint identity, so two
 * jobs enqueued in one transaction — which share `created_at` — never
 * straddle a page boundary unseen.
 */
export async function listJobs(db: JobExecutor, input: ListJobsInput): Promise<{ items: JobRecord[]; nextCursor: string | null }> {
  let query = db.selectFrom("platform.jobs").select(ROW_COLUMNS);
  if (input.kind) query = query.where("kind", "=", input.kind);
  if (input.status) query = query.where("status", "=", input.status);
  if (input.subject) {
    query = query.where("subject_entity", "=", input.subject.entity).where("subject_id", "=", input.subject.id);
  }
  if (input.cursor) query = query.where("sequence", "<", cursorOf(input.cursor));
  const rows = await query.orderBy("sequence", "desc").limit(input.limit + 1).execute();
  const items = rows.slice(0, input.limit).map((row) => toRecord(row as Row));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > input.limit && last ? last.sequence : null,
  };
}

/** Delete `done` jobs finished more than `olderThanDays` ago; returns how many. */
export async function sweepDoneJobs(db: JobExecutor, olderThanDays: number): Promise<number> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) throw new Error("Job retention must be a positive number of days.");
  const result = await db
    .deleteFrom("platform.jobs")
    .where("status", "=", "done")
    .where("completed_at", "<", sql<string>`now() - (${olderThanDays} || ' days')::interval`)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
