// SPDX-License-Identifier: BUSL-1.1
/**
 * Terminal transitions: when a node is done, and when the run is done.
 *
 * Both questions live in one module because the second is a consequence of the
 * first and must not be answerable without it. A node reaching a terminal
 * status is a row write; an instance reaching one is an aggregate over every
 * row that instance has. Whoever moves a node is therefore also the one who has
 * to ask whether that was the last one, and keeping the two apart would let a
 * caller mark a node terminal and never ask.
 *
 * The invariant this module owns: **an instance terminates only when every one
 * of its node states is terminal, and its final status is the worst outcome
 * among them** — failed if anything failed, else cancelled if anything was
 * cancelled, else completed. Nothing else may write a terminal value into
 * `workflow.instances.status`; a caller that did would strand parked nodes and
 * orphan whatever parent run is waiting on this one.
 *
 * The cascade is deliberately blind to what a node is waiting for. It counts
 * statuses, and a parked node counts as not-terminal — see
 * `markNodeStateWaitingInTransaction`. That is the entire mechanism by which a
 * human approval, a timer, or a child run keeps its instance open: no wait
 * registry is consulted, so a new kind of wait needs no change here.
 *
 * Finishing a child run is also what resumes its parent, and that hand-off is a
 * row on `workflow.control_commands` rather than a call. It is written in the
 * same transaction as the child's terminal status, so a crash between "child
 * finished" and "parent resumed" cannot lose the parent — the queue still holds
 * the intent. The key is derived from the child instance, so a redelivered
 * completion enqueues nothing new.
 */
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { jsonbLiteral } from "../../../../apps/api/src/db/sql-helpers.js";
import type { DB, Json } from "../../../../apps/api/src/generated/db/types.js";
import { appendScopedEntityEventInTransaction } from "../../../../apps/api/src/platform/entity-events.js";

type JsonRecord = Record<string, unknown>;

/**
 * The statuses that mean a node will not move again. `skipped` is here because
 * a branch the graph did not take is settled, not pending — an instance whose
 * only open node was skipped is finished, not stuck.
 */
const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "skipped"];

type WorkflowNodeTerminalStatus = "completed" | "failed" | "cancelled" | "skipped";

type WorkflowInstanceFinalStatus = "completed" | "failed" | "cancelled";

/**
 * A `JsonRecord` carries `unknown` leaves that `Json` cannot express. The
 * assertion restates what the caller already established rather than widening
 * anything: these values came out of, or are going into, a `jsonb` column.
 */
function toJson(value: unknown): Json {
  return value as Json;
}

/**
 * Postgres hands back parsed jsonb, but a driver or a nested string column can
 * still deliver the document as text; a value that fails to parse is treated as
 * absent rather than thrown on, because a malformed output must not be able to
 * stop an instance from completing.
 */
function asRecord(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

/**
 * Fold a resume result back into the resumed instance's process variables.
 *
 * Only keys the instance already declares are written: `process_variables` is
 * the authored variable set, and a child run returning an unexpected key must
 * not be able to invent a variable the graph never declared. Values arrive from
 * three places of increasing specificity — the child's own process variables,
 * an explicit `payload`, then the result's own top level — so a caller can be
 * as precise as it likes without the shape being mandatory.
 */
async function mergeResumeResultIntoProcessVariablesInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    result: JsonRecord;
  },
) {
  const target = await trx
    .selectFrom("workflow.instances")
    .select(["process_variables"])
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.instanceId)
    .forUpdate()
    .executeTakeFirst();

  if (!target) return;

  const current = asRecord(target.process_variables);
  const declaredKeys = Object.keys(current);
  if (declaredKeys.length === 0) return;

  const candidates: JsonRecord = {
    ...asRecord(input.result.processVariables),
    ...asRecord(input.result.payload),
    ...input.result,
  };
  const next: JsonRecord = { ...current };
  let changed = false;
  for (const key of declaredKeys) {
    if (!Object.prototype.hasOwnProperty.call(candidates, key)) continue;
    const value = candidates[key];
    if (value === undefined) continue;
    // Structural comparison rather than identity: the values are parsed JSON,
    // so an unchanged object arrives as a fresh reference every time and would
    // otherwise make every resume look like a write.
    if (JSON.stringify(next[key]) === JSON.stringify(value)) continue;
    next[key] = value;
    changed = true;
  }
  if (!changed) return;

  await sql`
    update workflow.instances
    set process_variables = ${jsonbLiteral(next)}
    where tenant_id = cast(${input.tenantId} as uuid)
      and id = cast(${input.instanceId} as uuid)
  `.execute(trx);
}

/**
 * Mark a `workflow.node_states` row terminal, inserting it if the node never
 * got one. Idempotent on (instance, node): a row already in a terminal status
 * is reported as such and left untouched, because the first terminal answer is
 * the true one and a redelivered command must not rewrite history.
 */
async function markNodeStateTerminalInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    nodeId: string;
    status: WorkflowNodeTerminalStatus;
    sharedOutput: JsonRecord;
    nodeType: string | undefined;
    error: { code: string; message: string; details?: JsonRecord | undefined } | undefined;
  },
): Promise<{ status: WorkflowNodeTerminalStatus | "already_terminal" }> {
  const existing = await trx
    .selectFrom("workflow.node_states")
    .select(["id", "status"])
    .where("tenant_id", "=", input.tenantId)
    .where("instance_id", "=", input.instanceId)
    .where("node_id", "=", input.nodeId)
    .forUpdate()
    .executeTakeFirst();

  if (existing) {
    if (TERMINAL_STATUSES.includes(existing.status)) {
      return { status: "already_terminal" };
    }
    await sql`
      update workflow.node_states
      set
        status = ${input.status},
        shared_output = ${jsonbLiteral(input.sharedOutput)},
        error = ${input.error ? jsonbLiteral(input.error) : sql`error`},
        completed_at = now()
      where id = cast(${existing.id} as uuid)
    `.execute(trx);
    return { status: input.status };
  }

  await trx
    .insertInto("workflow.node_states")
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      instance_id: input.instanceId,
      node_id: input.nodeId,
      // A resume knows the node id it was told to settle, not what kind of node
      // it is; the graph is the authority on that and is not read here.
      node_type: input.nodeType ?? "unknown",
      status: input.status,
      input: {},
      resolved_parameters: {},
      shared_output: toJson(input.sharedOutput),
      private_output: {},
      error: input.error ? toJson(input.error) : null,
      started_at: new Date(),
      completed_at: new Date(),
    })
    .execute();
  return { status: input.status };
}

/**
 * Settle a node as `completed`, stamping the result into `shared_output` so
 * later nodes can resolve `{{nodes.<id>.output.<field>}}` out of it.
 */
export async function markNodeStateCompletedInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    nodeId: string;
    result: JsonRecord;
    nodeType?: string | undefined;
  },
): Promise<{ status: "completed" | "already_terminal" }> {
  const outcome = await markNodeStateTerminalInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    nodeId: input.nodeId,
    status: "completed",
    sharedOutput: input.result,
    nodeType: input.nodeType,
    error: undefined,
  });
  return outcome as { status: "completed" | "already_terminal" };
}

/**
 * Settle a node as `failed`.
 *
 * The failure is written to `shared_output.error` as well as to `error`, so an
 * observer reading the same column it reads for every other outcome learns the
 * cause without a second query — and so a downstream node can branch on it
 * through the ordinary output placeholders.
 *
 * Called by the process runtime when a node bridge throws, or when a runtime
 * invariant is violated (missing edge, ambiguous edge, unresolved variable).
 * The instance is then driven to `failed` by the ordinary cascade below rather
 * than by a second, special path.
 */
export async function markNodeStateFailedInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    nodeId: string;
    nodeType?: string | undefined;
    error: { code: string; message: string; details?: JsonRecord | undefined };
  },
): Promise<{ status: "failed" | "already_terminal" }> {
  const errorPayload = {
    code: input.error.code,
    message: input.error.message,
    ...(input.error.details ? { details: input.error.details } : {}),
  };

  const outcome = await markNodeStateTerminalInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    nodeId: input.nodeId,
    status: "failed",
    sharedOutput: { error: errorPayload },
    nodeType: input.nodeType,
    error: errorPayload,
  });
  return outcome as { status: "failed" | "already_terminal" };
}

export async function markNodeStateCancelledInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    nodeId: string;
    result: JsonRecord;
    nodeType?: string | undefined;
  },
): Promise<{ status: "cancelled" | "already_terminal" }> {
  const outcome = await markNodeStateTerminalInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    nodeId: input.nodeId,
    status: "cancelled",
    sharedOutput: input.result,
    nodeType: input.nodeType,
    error: undefined,
  });
  return outcome as { status: "cancelled" | "already_terminal" };
}

/**
 * Park a node: record that it reached a wait and stopped there.
 *
 * **The status written is `running`, not `waiting`, and that is the point.**
 * The completion cascade counts terminal node states against the total, so a
 * parked node — non-terminal by construction — holds its instance open for as
 * long as the wait lasts, without the cascade knowing that waits exist. Writing
 * a terminal status here, or inventing one the cascade also had to learn about,
 * would complete the instance out from under whoever is still expected to
 * answer. The wait's own identity lives in `shared_output`, so re-entering the
 * node can recognise the token it already issued.
 *
 * Written as insert-if-absent plus update rather than an upsert because
 * `(tenant_id, instance_id, node_id)` is indexed but not unique; the instance
 * row lock held by every caller is what serializes the pair.
 */
export async function markNodeStateWaitingInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    nodeId: string;
    nodeType: string;
    wait: { waitToken: string; waitKind: string };
    payload: JsonRecord;
    executionVisit: number;
  },
): Promise<void> {
  const waitOutput = {
    waiting: true,
    waitToken: input.wait.waitToken,
    waitKind: input.wait.waitKind,
    payload: input.payload,
    runtime: { visitCount: input.executionVisit },
  };

  await sql`
    insert into workflow.node_states (
      tenant_id, instance_id, node_id, node_type,
      status, input, resolved_parameters,
      shared_output, private_output, started_at, completed_at, error
    )
    select
      cast(${input.tenantId} as uuid),
      cast(${input.instanceId} as uuid),
      ${input.nodeId},
      ${input.nodeType},
      'running',
      '{}'::jsonb,
      '{}'::jsonb,
      ${jsonbLiteral(waitOutput)},
      '{}'::jsonb,
      now(),
      null,
      null
    where not exists (
      select 1 from workflow.node_states
      where tenant_id = cast(${input.tenantId} as uuid)
        and instance_id = cast(${input.instanceId} as uuid)
        and node_id = ${input.nodeId}
    )
  `.execute(trx);

  // Clearing completed_at and error matters when a loop re-enters a node that
  // previously ran to completion: the row must read as open again, or the
  // cascade would count a node that is actively waiting.
  await sql`
    update workflow.node_states
    set
      node_type = ${input.nodeType},
      status = 'running',
      shared_output = ${jsonbLiteral(waitOutput)},
      completed_at = null,
      error = null
    where tenant_id = cast(${input.tenantId} as uuid)
      and instance_id = cast(${input.instanceId} as uuid)
      and node_id = ${input.nodeId}
  `.execute(trx);
}

/**
 * Terminate the instance if every node it has is settled, and cascade upward.
 *
 * Returns the chosen final status, or null when the run is not finished — which
 * is the ordinary answer, since most nodes completing are not the last one.
 */
export async function tryCompleteInstanceInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    completedBy: string;
    sharedResult?: JsonRecord | undefined;
  },
): Promise<{
  finalStatus: WorkflowInstanceFinalStatus | null;
  parentResumeCommandId: string | null;
}> {
  // The lock is taken before anything is counted: two nodes finishing
  // concurrently would otherwise both see the other as outstanding, and the run
  // would never terminate.
  const instance = await trx
    .selectFrom("workflow.instances")
    .select(["id", "status", "parent_instance_id", "parent_node_id", "process_variables"])
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.instanceId)
    .forUpdate()
    .executeTakeFirst();

  if (!instance) {
    return { finalStatus: null, parentResumeCommandId: null };
  }
  if (TERMINAL_STATUSES.includes(instance.status)) {
    return { finalStatus: null, parentResumeCommandId: null };
  }

  const summary = await trx
    .selectFrom("workflow.node_states")
    .select((eb) => [
      eb.fn.countAll().as("total"),
      eb.fn.count(eb.case().when("status", "=", "failed").then(1).end()).as("failed_count"),
      eb.fn.count(eb.case().when("status", "=", "cancelled").then(1).end()).as("cancelled_count"),
      eb.fn
        .count(eb.case().when("status", "in", TERMINAL_STATUSES).then(1).end())
        .as("terminal_count"),
    ])
    .where("tenant_id", "=", input.tenantId)
    .where("instance_id", "=", input.instanceId)
    .executeTakeFirst();

  const total = Number(summary?.total ?? 0);
  const terminal = Number(summary?.terminal_count ?? 0);
  const failed = Number(summary?.failed_count ?? 0);
  const cancelled = Number(summary?.cancelled_count ?? 0);

  // This test is what keeps a waiting instance open, and it is not obvious from
  // reading it: a parked node is stored at `running` (see
  // `markNodeStateWaitingInTransaction`), so it counts toward `total` and never
  // toward `terminal`. An instance with a human approval outstanding, a timer
  // pending, or a child run in flight therefore falls out here every time the
  // cascade is asked — with no knowledge of waits anywhere in this function.
  //
  // `total === 0` is the other half: between the instance row being inserted
  // and the runtime writing its first node state there is nothing to aggregate,
  // and a run that has not started has certainly not finished.
  if (total === 0 || terminal < total) {
    return { finalStatus: null, parentResumeCommandId: null };
  }

  const finalStatus: WorkflowInstanceFinalStatus =
    failed > 0 ? "failed" : cancelled > 0 ? "cancelled" : "completed";

  await sql`
    update workflow.instances
    set status = ${finalStatus}, completed_at = now()
    where tenant_id = cast(${input.tenantId} as uuid)
      and id = cast(${input.instanceId} as uuid)
  `.execute(trx);

  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: "workflow.instance",
    aggregateId: input.instanceId,
    eventType: `workflow.instance.${finalStatus}`,
    payload: {
      instanceId: input.instanceId,
      finalStatus,
      parentInstanceId: instance.parent_instance_id ?? null,
      parentNodeId: instance.parent_node_id ?? null,
    },
  });

  let parentResumeCommandId: string | null = null;
  if (instance.parent_instance_id && instance.parent_node_id) {
    const processVariables = asRecord(instance.process_variables);
    parentResumeCommandId = await enqueueParentResumeCommandInTransaction(trx, {
      tenantId: input.tenantId,
      parentInstanceId: instance.parent_instance_id,
      parentNodeId: instance.parent_node_id,
      childInstanceId: input.instanceId,
      childFinalStatus: finalStatus,
      // Flattened for `{{input.<field>}}` in the parent and repeated under
      // `processVariables` for callers that want the child's variable set
      // whole; an explicit sharedResult wins over both.
      result: {
        ...processVariables,
        ...(input.sharedResult ?? {}),
        processVariables,
      },
      completedBy: input.completedBy,
    });
  }

  return { finalStatus, parentResumeCommandId };
}

/**
 * Fail the instance outright, for a failure no node state can carry.
 *
 * The cascade above infers a failure from a node that failed. Some failures
 * have no such node. A graph that cannot be routed out of a node breaks *after*
 * that node did its job perfectly — two edges share one output handle, an edge
 * points at a target that is not in the graph, a trigger fans out, the walk hits
 * its visit ceiling. The node is `completed` and must stay `completed`;
 * `markNodeStateTerminalInTransaction` refuses to rewrite a settled row, and
 * that refusal is right. But it leaves the cascade nothing to infer from: every
 * node terminal, none failed, so it would answer `completed` — a run that went
 * nowhere, indistinguishable from one that finished.
 *
 * So this is the one path that asserts the instance's status instead of reading
 * it off the node rows, and it is the only one that writes
 * `workflow.instances.error`, because it is the only place the reason can live.
 * The cascade deliberately leaves that column alone: there the failing node's
 * own `error` is the record, and a second copy could only drift from it.
 *
 * `atNodeId` annotates the node the walk stopped at — where, not who. Only its
 * `error` is written; its status and `completed_at` are its own account of what
 * it did, and it did nothing wrong.
 */
export async function failInstanceInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    failedBy: string;
    error: { code: string; message: string; details?: JsonRecord | undefined };
    atNodeId?: string | null | undefined;
  },
): Promise<{
  status: "failed" | "already_terminal" | "not_found";
  parentResumeCommandId: string | null;
}> {
  const instance = await trx
    .selectFrom("workflow.instances")
    .select(["id", "status", "parent_instance_id", "parent_node_id", "process_variables"])
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.instanceId)
    .forUpdate()
    .executeTakeFirst();

  if (!instance) {
    return { status: "not_found", parentResumeCommandId: null };
  }
  if (TERMINAL_STATUSES.includes(instance.status)) {
    return { status: "already_terminal", parentResumeCommandId: null };
  }

  const errorPayload = {
    code: input.error.code,
    message: input.error.message,
    ...(input.error.details ? { details: input.error.details } : {}),
  };

  if (input.atNodeId) {
    await sql`
      update workflow.node_states
      set error = ${jsonbLiteral(errorPayload)}
      where tenant_id = cast(${input.tenantId} as uuid)
        and instance_id = cast(${input.instanceId} as uuid)
        and node_id = ${input.atNodeId}
    `.execute(trx);
  }

  await sql`
    update workflow.instances
    set status = 'failed', error = ${jsonbLiteral(errorPayload)}, completed_at = now()
    where tenant_id = cast(${input.tenantId} as uuid)
      and id = cast(${input.instanceId} as uuid)
  `.execute(trx);

  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: "workflow.instance",
    aggregateId: input.instanceId,
    eventType: "workflow.instance.failed",
    payload: {
      instanceId: input.instanceId,
      finalStatus: "failed",
      error: toJson(errorPayload),
      nodeId: input.atNodeId ?? null,
      parentInstanceId: instance.parent_instance_id ?? null,
      parentNodeId: instance.parent_node_id ?? null,
    },
  });

  // A parent waiting on this run has to hear about it, and a failure it never
  // hears about parks it forever. Same hand-off as every other terminal path.
  let parentResumeCommandId: string | null = null;
  if (instance.parent_instance_id && instance.parent_node_id) {
    const processVariables = asRecord(instance.process_variables);
    parentResumeCommandId = await enqueueParentResumeCommandInTransaction(trx, {
      tenantId: input.tenantId,
      parentInstanceId: instance.parent_instance_id,
      parentNodeId: instance.parent_node_id,
      childInstanceId: input.instanceId,
      childFinalStatus: "failed",
      result: { ...processVariables, error: errorPayload, processVariables },
      completedBy: input.failedBy,
    });
  }

  return { status: "failed", parentResumeCommandId };
}

/**
 * Cancel a run outright, without waiting for its nodes to settle themselves.
 *
 * This is the one terminal transition that does not go through the cascade,
 * because the cascade asks whether the run is finished and the answer here is
 * "it no longer matters". Every open node is settled as cancelled first so the
 * instance is left consistent with its own aggregate — a cancelled instance
 * with nodes still reading `running` would be a run the cascade could later be
 * asked about and answer wrongly.
 */
export async function cancelWorkflowInstanceInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    cancelledBy: string;
    reason?: string | null | undefined;
    sharedResult?: JsonRecord | undefined;
  },
): Promise<{
  status: "cancelled" | "already_terminal" | "not_found";
  parentResumeCommandId: string | null;
}> {
  const instance = await trx
    .selectFrom("workflow.instances")
    .select(["id", "status", "parent_instance_id", "parent_node_id", "process_variables"])
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.instanceId)
    .forUpdate()
    .executeTakeFirst();

  if (!instance) {
    return { status: "not_found", parentResumeCommandId: null };
  }
  if (TERMINAL_STATUSES.includes(instance.status)) {
    return { status: "already_terminal", parentResumeCommandId: null };
  }

  const reason = input.reason ?? "cancelled";

  await sql`
    update workflow.node_states
    set
      status = 'cancelled',
      shared_output = coalesce(shared_output, '{}'::jsonb) || ${jsonbLiteral({
        reason,
        cancelledBy: input.cancelledBy,
      })},
      completed_at = coalesce(completed_at, now())
    where tenant_id = cast(${input.tenantId} as uuid)
      and instance_id = cast(${input.instanceId} as uuid)
      and status not in ('completed', 'failed', 'cancelled', 'skipped')
  `.execute(trx);

  await sql`
    update workflow.instances
    set status = 'cancelled', completed_at = coalesce(completed_at, now())
    where tenant_id = cast(${input.tenantId} as uuid)
      and id = cast(${input.instanceId} as uuid)
      and status not in ('completed', 'failed', 'cancelled')
  `.execute(trx);

  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: "workflow.instance",
    aggregateId: input.instanceId,
    eventType: "workflow.instance.cancelled",
    payload: {
      instanceId: input.instanceId,
      finalStatus: "cancelled",
      reason,
      parentInstanceId: instance.parent_instance_id ?? null,
      parentNodeId: instance.parent_node_id ?? null,
    },
  });

  let parentResumeCommandId: string | null = null;
  if (instance.parent_instance_id && instance.parent_node_id) {
    const processVariables = asRecord(instance.process_variables);
    parentResumeCommandId = await enqueueParentResumeCommandInTransaction(trx, {
      tenantId: input.tenantId,
      parentInstanceId: instance.parent_instance_id,
      parentNodeId: instance.parent_node_id,
      childInstanceId: input.instanceId,
      childFinalStatus: "cancelled",
      result: {
        ...processVariables,
        ...(input.sharedResult ?? {}),
        processVariables,
        reason,
      },
      completedBy: input.cancelledBy,
    });
  }

  return { status: "cancelled", parentResumeCommandId };
}

/**
 * Tell the parent that its child run is over, by writing the intent rather than
 * making the call.
 *
 * The key is the child instance, so every path that can observe a child
 * finishing — the cascade, an outright cancel, a redelivered command — converges
 * on one parent resume. The insert races with itself by design; the conflict
 * clause absorbs it and the union below returns whichever row won, so the caller
 * always learns the command id that actually exists.
 */
async function enqueueParentResumeCommandInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    parentInstanceId: string;
    parentNodeId: string;
    childInstanceId: string;
    childFinalStatus: WorkflowInstanceFinalStatus;
    result: JsonRecord;
    completedBy: string;
  },
): Promise<string> {
  const commandId = randomUUID();
  const idempotencyKey = `child-terminal:${input.childInstanceId}`;
  const payload = {
    instanceId: input.parentInstanceId,
    nodeId: input.parentNodeId,
    waitToken: null,
    actionId: null,
    reason: `child_${input.childFinalStatus}`,
    completedBy: input.completedBy,
    result: {
      ...input.result,
      childInstanceId: input.childInstanceId,
      childFinalStatus: input.childFinalStatus,
    },
  };

  const result = await sql<{ id: string }>`
    with inserted as (
      insert into workflow.control_commands (
        id,
        tenant_id,
        command_type,
        workflow_instance_id,
        idempotency_key,
        payload,
        status,
        next_attempt_at
      ) values (
        cast(${commandId} as uuid),
        cast(${input.tenantId} as uuid),
        'workflow.instance.resume',
        cast(${input.parentInstanceId} as uuid),
        ${idempotencyKey},
        ${jsonbLiteral(payload)},
        'pending',
        now()
      )
      on conflict (tenant_id, idempotency_key) do nothing
      returning id::text
    )
    select id from inserted
    union all
    select id::text
    from workflow.control_commands
    where tenant_id = cast(${input.tenantId} as uuid)
      and idempotency_key = ${idempotencyKey}
    limit 1
  `.execute(trx);

  return result.rows[0]?.id ?? commandId;
}

/**
 * Apply a resume signal to a node that is not itself re-entered by the process
 * runtime: settle it, then ask whether that finished the run.
 *
 * A child run that failed or was cancelled must not settle the parent's node as
 * completed — the parent's graph would then take its success edge out of a node
 * whose work did not succeed. The child's own outcome, carried on the resume
 * payload, therefore decides which terminal status the parent's node gets.
 */
export async function applyResumeAndCascadeInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    nodeId: string;
    result: JsonRecord;
    completedBy: string;
  },
): Promise<{
  nodeStateChange: WorkflowNodeTerminalStatus | "already_terminal";
  finalStatus: WorkflowInstanceFinalStatus | null;
  parentResumeCommandId: string | null;
}> {
  await mergeResumeResultIntoProcessVariablesInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    result: input.result,
  });

  const childFinalStatus =
    input.result.childFinalStatus === "failed" || input.result.childFinalStatus === "cancelled"
      ? input.result.childFinalStatus
      : null;

  const nodeStateChange =
    childFinalStatus === "failed"
      ? await markNodeStateFailedInTransaction(trx, {
          tenantId: input.tenantId,
          instanceId: input.instanceId,
          nodeId: input.nodeId,
          error: {
            code: "CHILD_WORKFLOW_FAILED",
            message: "Child workflow failed.",
            details: input.result,
          },
        })
      : childFinalStatus === "cancelled"
        ? await markNodeStateCancelledInTransaction(trx, {
            tenantId: input.tenantId,
            instanceId: input.instanceId,
            nodeId: input.nodeId,
            result: input.result,
          })
        : await markNodeStateCompletedInTransaction(trx, {
            tenantId: input.tenantId,
            instanceId: input.instanceId,
            nodeId: input.nodeId,
            result: input.result,
          });

  const completion = await tryCompleteInstanceInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    completedBy: input.completedBy,
    sharedResult: input.result,
  });

  return {
    nodeStateChange: nodeStateChange.status,
    finalStatus: completion.finalStatus,
    parentResumeCommandId: completion.parentResumeCommandId,
  };
}
