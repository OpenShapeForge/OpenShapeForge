// SPDX-License-Identifier: BUSL-1.1
/**
 * The core `osf-jobs` Operation handlers — `jobs.list`, `jobs.get`,
 * `jobs.retry` — bound by `bindOperationHandlers` the way the control and
 * blueprint handlers are, so a deployment without any plugin still
 * administers its queue.
 *
 * Everything runs inside the caller's tenant session: the table's policy
 * fences the rows, so a job of another tenant is NOT_FOUND rather than
 * FORBIDDEN, and the handlers never carry a tenant id of their own.
 */
import { withDbSession } from "../db/session.js";
import type { ModuleOperationErrorResult, ModuleOperationHandler } from "../modules/contract.js";
import type { OperationContract } from "../operations/runtime.js";
import { getJob, listJobs, resolveJob } from "./queries.js";
import { isJobStatus, type JobRecord } from "./store.js";

/** The plugin name every jobs Operation is authored under; matches the compiler's. */
export const JOBS_PLUGIN = "osf-jobs";

function failure(status: number, code: string, message: string): ModuleOperationErrorResult {
  return { ok: false, status, code, body: { error: { code, message } } };
}

/** The Operation's output shape: no actor or payload, which may carry personal data. */
export function jobView(job: JobRecord) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt.toISOString(),
    leaseUntil: job.leaseUntil?.toISOString() ?? null,
    deliveryKey: job.deliveryKey,
    subject: job.subject,
    lastError: job.lastError,
    result: job.result,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

const DEFAULT_LIMIT = 25;

const HANDLERS: Record<string, ModuleOperationHandler> = {
  async list(input, context) {
    const { db, session } = context;
    if (!db) return failure(503, "DATABASE_NOT_CONFIGURED", "The database is unavailable.");
    if (!session?.tenantId || !session.userId) return failure(401, "UNAUTHENTICATED", "An authenticated tenant session is required.");
    const status = input.status;
    if (status !== undefined && !isJobStatus(status)) return failure(400, "BAD_USER_INPUT", "Unknown job status.");
    const subject = input.subject as { entity: string; id: string } | undefined;
    try {
      const page = await withDbSession(db, session, (trx) =>
        listJobs(trx, {
          ...(typeof input.kind === "string" ? { kind: input.kind } : {}),
          ...(status ? { status } : {}),
          ...(subject ? { subject } : {}),
          ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
          limit: typeof input.limit === "number" ? input.limit : DEFAULT_LIMIT,
        }),
      );
      return { value: { items: page.items.map(jobView), nextCursor: page.nextCursor } };
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid jobs cursor.") return failure(400, "BAD_USER_INPUT", error.message);
      throw error;
    }
  },

  async get(input, { db, session }) {
    if (!db) return failure(503, "DATABASE_NOT_CONFIGURED", "The database is unavailable.");
    if (!session?.tenantId || !session.userId) return failure(401, "UNAUTHENTICATED", "An authenticated tenant session is required.");
    const job = await withDbSession(db, session, (trx) => getJob(trx, String(input.id)));
    return job ? { value: jobView(job) } : failure(404, "NOT_FOUND", "No job with that id exists in this tenant.");
  },

  async retry(input, { db, session }) {
    if (!db) return failure(503, "DATABASE_NOT_CONFIGURED", "The database is unavailable.");
    if (!session?.tenantId || !session.userId) return failure(401, "UNAUTHENTICATED", "An authenticated tenant session is required.");
    const action = input.resolution === "done" ? "done" : "requeue";
    return withDbSession(db, session, async (trx) => {
      const resolved = await resolveJob(trx, { id: String(input.id), action });
      if (resolved) return { value: jobView(resolved) };
      const current = await getJob(trx, String(input.id));
      return current
        ? failure(409, "CONFLICT", `A ${current.status} job cannot be retried; only failed, dead and outcome_unknown jobs can.`)
        : failure(404, "NOT_FOUND", "No job with that id exists in this tenant.");
    });
  },
};

export function jobsOperationHandlerNames(): readonly string[] {
  return Object.keys(HANDLERS).sort();
}

export function jobsOperationHandler(operation: Pick<OperationContract, "key" | "handler">): ModuleOperationHandler {
  const handler = HANDLERS[operation.handler];
  if (!handler) throw new Error(`Unknown core jobs handler "${operation.handler}".`);
  return handler;
}
