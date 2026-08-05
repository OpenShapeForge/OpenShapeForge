// SPDX-License-Identifier: BUSL-1.1
/**
 * Waking runs whose timer deadline has passed.
 *
 * `timer-bridge.ts` parks a run by writing a `workflow.waits` row with a
 * `resume_at`. Nothing about that row wakes anything on its own — this sweep is
 * the half that notices, and it is the only reason a parked timer ever
 * continues.
 *
 * ## Two phases, and why they are not one query
 *
 * The claim is cross-tenant: one worker drains every tenant's due timers, so a
 * tenant with none needs no worker of its own. `workflow.waits` declares
 * `workerAccess`, so its policy admits a session connected as
 * `openshapeforge_worker` and presenting `app.worker_role` — nothing is
 * bypassed, and the widening stops at that table.
 *
 * The resuming is not. `enqueueWorkflowInstanceResume` reads
 * `workflow.instances`, which deliberately carries no worker axis, so it runs
 * in a session scoped to the wait's own tenant — which is why the loop below is
 * outside the claiming transaction rather than inside it. That split is the
 * whole design: the cross-tenant surface is the queue, not the work. Setting
 * `app.bypass_rls` here instead would grant this worker read and write on every
 * tenant's business data in order to read one column.
 *
 * ## Why a claim column rather than just reading due rows
 *
 * `resumed_at` retires the row. Without it the same wait is selected on every
 * tick forever: the resume command would dedupe on its idempotency key so
 * nothing would break, but the scan would grow without bound and the row would
 * never mean anything other than "still here".
 *
 * ## The claim is unbounded
 *
 * There is no LIMIT, mirroring the collection-wait timeout sweep. A backlog
 * large enough to matter would claim it all in one statement. That is a real if
 * remote risk; bounding it needs a CTE, since Postgres has no `UPDATE ... LIMIT`.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import { WORKFLOW_WORKER_ROLE } from "../worker-role.js";
import { enqueueWorkflowInstanceResume } from "./instance-commands.js";
import { TIMER_WAIT_KIND } from "./timer-bridge.js";

export type WorkflowTimerWaitWorkerOptions = {
  pollIntervalMs?: number;
};

/**
 * The system identity a worker-enqueued resume is attributed to.
 *
 * `workflow-operator` is not decoration: `enqueueWorkflowInstanceResume`
 * asserts a writer role and `workflow-worker` is not one of them, so a session
 * carrying only the worker role is refused.
 */
const workerUserId = "00000000-0000-4000-8000-000000000000";
const workerRoles = [WORKFLOW_WORKER_ROLE, "workflow-operator"];

export async function processDueWorkflowTimerWaits(db: OpenShapeForgeDatabase) {
  const due = await db.transaction().execute(async (trx) => {
    await sql`select set_config('app.worker_role', ${WORKFLOW_WORKER_ROLE}, true)`.execute(
      trx,
    );
    const rows = await sql<{
      tenant_id: string;
      instance_id: string;
      node_id: string;
      wait_token: string;
    }>`
      update workflow.waits
      set
        resumed_at = now(),
        updated_at = now()
      where wait_kind = ${TIMER_WAIT_KIND}
        and resume_at is not null
        and resumed_at is null
        and resume_at <= now()
      returning
        tenant_id::text,
        instance_id::text,
        node_id,
        wait_token
    `.execute(trx);
    return rows.rows;
  });

  for (const wait of due) {
    await enqueueWorkflowInstanceResume(
      db,
      {
        tenantId: wait.tenant_id,
        userId: workerUserId,
        roles: workerRoles,
      },
      {
        instanceId: wait.instance_id,
        nodeId: wait.node_id,
        waitToken: wait.wait_token,
        reason: "timer-deadline",
        // Empty on purpose. A resume's `input` never reaches the bridge — the
        // runtime re-executes the node from its own state — so anything here
        // would be recorded and never read. `reason` carries the only fact a
        // reader of the command row needs.
        input: {},
      },
    );
  }

  return { fired: due.length };
}

export function startWorkflowTimerWaitWorker(
  db: OpenShapeForgeDatabase,
  options: WorkflowTimerWaitWorkerOptions = {},
) {
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000);
  let stopped = false;
  let active = false;

  const tick = async () => {
    if (stopped || active) return;
    active = true;
    try {
      const result = await processDueWorkflowTimerWaits(db);
      if (result.fired > 0) {
        console.info({ fired: result.fired }, "Workflow timer waits resumed.");
      }
    } finally {
      active = false;
    }
  };

  const interval = setInterval(() => {
    void tick().catch((error) => {
      console.error({ error }, "Workflow timer wait worker tick failed.");
    });
  }, pollIntervalMs);
  void tick().catch((error) => {
    console.error({ error }, "Workflow timer wait worker initial tick failed.");
  });

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      // Settle only after the in-flight tick finishes: it may have claimed rows
      // whose resume has not been enqueued yet, and those runs would stay
      // parked with `resumed_at` already set — never swept again.
      while (active) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}
