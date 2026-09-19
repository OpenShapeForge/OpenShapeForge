// SPDX-License-Identifier: BUSL-1.1
/**
 * The durable job store — every statement that touches platform.jobs.
 *
 * Nothing here opens a session. A handler enqueues inside its own tenant
 * transaction (the outbox: the job commits with the domain write or not at
 * all), an operator lists and retries inside a request's tenant session, and
 * the worker claims, settles and sweeps inside the worker session that
 * `jobs/worker.ts` opens. The row-level policy on the table admits each of
 * those and nothing else, so the same SQL is safe from every caller.
 *
 * A claim is a conditional update guarded by `for update skip locked`, so two
 * workers polling at once hand each job to exactly one of them. The claim
 * returns a one-time token whose SHA-256 is the only thing stored; locking
 * and settling (`settle.ts`) require the token, so a worker whose lease
 * expired and was reclaimed by another cannot overwrite that worker's
 * outcome with its own.
 */
import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { RuntimeJobEnqueueResult, RuntimeJobError, RuntimeJobSubject } from "@openshapeforge/plugin-runtime";
import type { DB } from "../generated/db/types.js";
import { JOB_STATUSES, type JobStatus } from "../db/migrations/jobs.js";
import { actorSessionOf, type JobActorSession } from "./actor-session.js";

export type JobExecutor = Kysely<DB> | Transaction<DB>;

export type JobRecord = {
  id: string;
  /** Monotonic insertion order across tenants; the list cursor. */
  sequence: string;
  tenantId: string;
  actorId: string;
  actorSession: JobActorSession;
  kind: string;
  payload: Record<string, unknown>;
  deliveryKey: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  leaseUntil: Date | null;
  lastError: RuntimeJobError | null;
  result: Record<string, unknown> | null;
  subject: RuntimeJobSubject | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type ClaimedJob = JobRecord & { claimToken: string };

export type EnqueueJobInput = {
  tenantId: string;
  actorId: string;
  /** Omitted: no roles, no groups, scope `self` — the least a session can be. */
  actorSession?: Partial<JobActorSession>;
  kind: string;
  payload: Record<string, unknown>;
  deliveryKey?: string;
  availableAt?: Date;
  maxAttempts?: number;
  subject?: RuntimeJobSubject;
};

export const DEFAULT_MAX_ATTEMPTS = 5;

/** Namespaced: at least `<namespace>.<name>`, lowercase, as the table check enforces. */
export const JOB_KIND = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return jsonRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export type Row = {
  id: string;
  sequence: string | number | bigint;
  tenant_id: string;
  actor_id: string;
  actor_session: unknown;
  kind: string;
  payload: unknown;
  delivery_key: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  available_at: string | Date;
  lease_until: string | Date | null;
  last_error: unknown;
  result: unknown;
  subject_entity: string | null;
  subject_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
};

export const ROW_COLUMNS = [
  "id", "sequence", "tenant_id", "actor_id", "actor_session", "kind", "payload", "delivery_key", "status", "attempts", "max_attempts",
  "available_at", "lease_until", "last_error", "result", "subject_entity", "subject_id",
  "created_at", "updated_at", "completed_at",
] as const;

export function toRecord(row: Row): JobRecord {
  if (!isJobStatus(row.status)) throw new Error(`platform.jobs row ${row.id} has unknown status "${row.status}".`);
  const lastError = row.last_error ? jsonRecord(row.last_error) : null;
  return {
    id: row.id,
    sequence: String(row.sequence),
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    actorSession: actorSessionOf(jsonRecord(row.actor_session)),
    kind: row.kind,
    payload: jsonRecord(row.payload),
    deliveryKey: row.delivery_key,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: new Date(row.available_at),
    leaseUntil: row.lease_until ? new Date(row.lease_until) : null,
    lastError: lastError && typeof lastError.message === "string" ? (lastError as RuntimeJobError) : null,
    result: row.result ? jsonRecord(row.result) : null,
    subject: row.subject_entity && row.subject_id ? { entity: row.subject_entity, id: row.subject_id } : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  };
}

function assertEnqueueInput(input: EnqueueJobInput) {
  if (!JOB_KIND.test(input.kind)) {
    throw new Error(`Job kind "${input.kind}" must be namespaced lowercase, like "mail.deliver".`);
  }
  if (input.maxAttempts !== undefined && (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)) {
    throw new Error("Job maxAttempts must be a positive integer.");
  }
  if (input.deliveryKey !== undefined && input.deliveryKey.trim().length === 0) {
    throw new Error("Job deliveryKey must not be empty.");
  }
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new Error("Job payload must be an object.");
  }
}

/**
 * Insert a queued job, or return the one an equal delivery key already named.
 *
 * `on conflict do nothing` rather than an upsert: the earlier job is the
 * truth, whatever its state — a second enqueue of the same key after the first
 * was delivered must not deliver again, which is the whole point of the key.
 */
export async function enqueueJob(db: JobExecutor, input: EnqueueJobInput): Promise<RuntimeJobEnqueueResult> {
  assertEnqueueInput(input);
  const actorSession = actorSessionOf(input.actorSession);
  const inserted = await db
    .insertInto("platform.jobs")
    .values({
      tenant_id: input.tenantId,
      actor_id: input.actorId,
      actor_session: JSON.stringify(actorSession),
      kind: input.kind,
      payload: JSON.stringify(input.payload),
      delivery_key: input.deliveryKey ?? null,
      max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      // The database clock, which is also the one the claim compares against;
      // a process clock ahead of it would hide the job for the difference.
      available_at: input.availableAt ?? sql<Date>`now()`,
      subject_entity: input.subject?.entity ?? null,
      subject_id: input.subject?.id ?? null,
    })
    .onConflict((oc) => oc.columns(["tenant_id", "kind", "delivery_key"]).where("delivery_key", "is not", null).doNothing())
    .returning(["id", "status"])
    .executeTakeFirst();
  if (inserted) return { id: inserted.id, created: true, status: inserted.status as JobStatus };
  const existing = await db
    .selectFrom("platform.jobs")
    .select(["id", "status"])
    .where("tenant_id", "=", input.tenantId)
    .where("kind", "=", input.kind)
    .where("delivery_key", "=", input.deliveryKey ?? null)
    .executeTakeFirstOrThrow();
  return { id: existing.id, created: false, status: existing.status as JobStatus };
}

export type ClaimJobsInput = {
  limit: number;
  leaseSeconds: number;
  /** Restrict the poll to these kinds; every kind when absent. */
  kinds?: readonly string[];
};

/**
 * Move up to `limit` due jobs to `running` and hand them out with fresh claim
 * tokens. A `running` job whose lease has expired is reclaimable the same way,
 * bounded by `max_attempts`: one at the bound is closed as `dead` here, with
 * the expiry named as its error, because a claim is the only thing that ever
 * observes such a row.
 */
export async function claimJobs(trx: Transaction<DB>, input: ClaimJobsInput): Promise<ClaimedJob[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Job claim limit must be a positive integer.");
  if (!(input.leaseSeconds > 0)) throw new Error("Job lease must be positive.");
  const kinds = input.kinds ? [...new Set(input.kinds)].sort() : undefined;
  const kindFilter = kinds ? sql`and kind in (${sql.join(kinds)})` : sql``;

  await sql`
    update platform.jobs
    set
      status = 'dead',
      lease_until = null,
      claim_token_hash = null,
      completed_at = now(),
      updated_at = now(),
      last_error = jsonb_build_object(
        'code', 'LEASE_EXPIRED',
        'message', 'The job was claimed ' || attempts || ' times without a worker reporting back.'
      )
    where id in (
      select id from platform.jobs
      where status = 'running' and lease_until < now() and attempts >= max_attempts ${kindFilter}
      order by available_at asc
      limit ${input.limit}
      for update skip locked
    )
  `.execute(trx);

  const due = await sql<{ id: string }>`
    select id from platform.jobs
    where (
        (status = 'queued' and available_at <= now())
        or (status = 'running' and lease_until < now() and attempts < max_attempts)
      ) ${kindFilter}
    order by available_at asc
    limit ${input.limit}
    for update skip locked
  `.execute(trx);

  const claimed: ClaimedJob[] = [];
  for (const { id } of due.rows) {
    const claimToken = randomBytes(32).toString("hex");
    const row = await trx
      .updateTable("platform.jobs")
      .set({
        status: "running",
        attempts: sql`attempts + 1`,
        lease_until: sql<Date>`now() + (${input.leaseSeconds} || ' seconds')::interval`,
        claim_token_hash: hashClaimToken(claimToken),
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", id)
      .returning(ROW_COLUMNS)
      .executeTakeFirstOrThrow();
    claimed.push({ ...toRecord(row as Row), claimToken });
  }
  return claimed;
}
