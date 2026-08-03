// SPDX-License-Identifier: BUSL-1.1
/**
 * The `timer` node: park a run until a wall-clock deadline, then continue.
 *
 * This is the first node in the shipped catalog that parks. Everything else
 * either computes an answer from its config (`decision`) or does one thing to
 * one table (the generated entity bridges), and both return an output handle in
 * the same transaction they were called in. A timer cannot: the answer is "not
 * yet", and the run has to end and be picked up again later.
 *
 * ## How parking works, and why the check below cannot use `node_states`
 *
 * A bridge parks by returning `wait: { waitToken, waitKind }`. The runtime then
 * writes a node-state row marked waiting and ends the pass, leaving the
 * instance `running`. Later a `workflow.instance.resume` command re-enters the
 * graph at this node and **runs this bridge again** — there is no stored
 * continuation, so a parking bridge must recognise its own earlier park and
 * return a real handle the second time.
 *
 * The obvious place to look for that earlier park is the node-state row, and it
 * is the wrong place. `upsertStartedNodeState` runs before every bridge call,
 * including the replay, and its second statement unconditionally overwrites
 * `shared_output` with `{ runtime: { visitCount } }` — so by the time this
 * function runs on the resume pass, the waiting marker the runtime wrote is
 * already gone and the node looks freshly started. The row in `workflow.waits`
 * is therefore not bookkeeping; it is the only durable record that this node
 * ever parked.
 *
 * ## Why the deadline is sweep-driven rather than a durable sleep
 *
 * A deployment may configure an external durable-execution service to dispatch
 * control commands, and that service offers a durable sleep which would remove
 * the polling entirely. It is deliberately not used here:
 *
 * - It is optional. With no such service configured the runtime dispatches
 *   commands in process, and a timer built on it would silently not exist in
 *   the default deployment.
 * - The two dispatchers are interchangeable by construction, and a node type
 *   that works under only one of them ends that property.
 * - The engine's parking model is command-driven: every wake-up, from any
 *   source, arrives as a `workflow.instance.resume` row. A bridge-native sleep
 *   would be a second, parallel resume path.
 *
 * The sweep and that service are complementary rather than alternatives — the
 * sweep decides only *when* a wait is due and enqueues the resume; dispatching
 * that resume durably is still the dispatcher's job.
 *
 * ## The authored contract
 *
 * `flow/timer.yaml` declares five config fields and no output handles, so this
 * returns `default` — the handle an unlabelled edge matches. Two of its
 * validation rules do not survive into runtime validation: fields are only
 * runtime-required when they declare `runtime.required` (none here do), and the
 * `min` on `durationAmount` is an object rather than a scalar, which the runtime
 * schema builder does not read. So an absent `untilAt` and a zero or negative
 * `durationAmount` both reach this function and are checked here.
 */
import { sql } from "kysely";
import { jsonbLiteral } from "../../../../apps/api/src/db/sql-helpers.js";
import {
  registerWorkflowNodeBridge,
  type WorkflowNodeBridgeContext,
  type WorkflowNodeBridgeOutput,
} from "./node-bridge.js";

const TIMER_NODE_TYPE = "timer" as const;

/** The `wait_kind` the sweep in `timer-waits.ts` filters on. */
export const TIMER_WAIT_KIND = "timer" as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type TimerConfig = {
  mode?: unknown;
  durationAmount?: unknown;
  durationUnit?: unknown;
  untilAt?: unknown;
  skipWeekends?: unknown;
};

/**
 * Saturday and Sunday in UTC.
 *
 * A weekend is a local-calendar fact and this engine has no per-tenant
 * timezone, so there is no correct answer available — only a stated one. UTC is
 * chosen because it is the only choice that is not a guess about where the
 * tenant is; a regional default would silently be wrong for everyone else and
 * right for nobody in particular. When tenants carry a timezone, this is the
 * line that should read it.
 */
function isWeekendUtc(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function asPositiveUnitMs(unit: unknown): number {
  switch (unit) {
    case "minutes":
      return MINUTE_MS;
    case "hours":
      return HOUR_MS;
    case "days":
    case undefined:
    case null:
      return DAY_MS; // the authored default
    default:
      throw new Error(
        `Timer node has an unknown durationUnit "${String(unit)}"; expected minutes, hours or days.`,
      );
  }
}

/**
 * The deadline this timer is waiting for, computed once when the node first
 * parks and never again — see the upsert below, which does not touch
 * `resume_at` on conflict. Recomputing on replay would slide a duration timer
 * forward by its own length every time the run was resumed, so it would never
 * fire.
 *
 * Exported for the unit test: this is pure, and the alternative is proving
 * weekend arithmetic through a database.
 */
export function computeTimerDeadline(config: TimerConfig, now: Date): Date {
  const mode = config.mode === undefined || config.mode === null ? "duration" : config.mode;

  if (mode === "until") {
    if (typeof config.untilAt !== "string" || !config.untilAt.trim()) {
      throw new Error("Timer node is in `until` mode with no untilAt configured.");
    }
    const until = new Date(config.untilAt);
    if (Number.isNaN(until.getTime())) {
      throw new Error(`Timer node has an unparseable untilAt "${config.untilAt}".`);
    }
    // A deadline already in the past is not an error — it fires at once, which
    // is what "wait until a moment that has passed" means.
    return until;
  }

  if (mode !== "duration") {
    throw new Error(
      `Timer node has an unknown mode "${String(mode)}"; expected duration or until.`,
    );
  }

  const rawAmount = config.durationAmount;
  const amount =
    rawAmount === undefined || rawAmount === null ? 1 : Math.trunc(Number(rawAmount));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(
      `Timer node has an invalid durationAmount "${String(rawAmount)}"; expected a non-negative whole number.`,
    );
  }

  const unitMs = asPositiveUnitMs(config.durationUnit);
  const skipWeekends =
    config.skipWeekends === true && (config.durationUnit ?? "days") === "days";

  if (!skipWeekends) {
    return new Date(now.getTime() + amount * unitMs);
  }

  // Count `amount` working days forward, one at a time, skipping any day that
  // lands on a weekend. Stepping rather than multiplying is what makes a
  // weekend that falls inside the span extend it rather than be absorbed by it.
  let deadline = new Date(now.getTime());
  for (let step = 0; step < amount; step += 1) {
    deadline = new Date(deadline.getTime() + DAY_MS);
    while (isWeekendUtc(deadline)) {
      deadline = new Date(deadline.getTime() + DAY_MS);
    }
  }
  return deadline;
}

/**
 * Stable across the park and the replay, which is the whole requirement.
 *
 * The runtime defaults `resolvedConfig.idempotencyKey` to a key derived from
 * the instance, the node and the visit count, and on a resume it reuses the
 * parked visit rather than incrementing — so the replay pass computes the same
 * string. A loop that reaches this node twice gets two visits, two tokens and
 * two independent timers, which is correct.
 */
function timerWaitToken(context: WorkflowNodeBridgeContext): string {
  const key = context.resolvedConfig.idempotencyKey;
  return `timer:${typeof key === "string" && key ? key : `${context.instanceId}:${context.nodeId}`}`;
}

/**
 * Exported so a test can drive the bridge without going through the global
 * registry. Registering into that registry from a test leaks across files —
 * `bun test` shares module state — and the registration is one-shot, so a
 * second registration either throws or silently no-ops depending on which
 * module instance won.
 */
export const timerNodeBridge = async (
  context: WorkflowNodeBridgeContext,
): Promise<WorkflowNodeBridgeOutput> => {
  const config = context.resolvedConfig as TimerConfig;
  const waitToken = timerWaitToken(context);
  const now = new Date();
  const deadline = computeTimerDeadline(config, now);

  // Register, or read back what a previous pass registered. `do update set
  // updated_at` rather than `do nothing` so the row is returned either way;
  // `resume_at` is deliberately absent from the update, so the deadline is the
  // one computed on the first pass and this call's `deadline` is discarded.
  const registered = await sql<{ resume_at: string | null; resumed_at: string | null }>`
    insert into workflow.waits (
      tenant_id, instance_id, node_id, wait_token, wait_kind, wait_metadata, resume_at
    ) values (
      cast(${context.tenantId} as uuid),
      cast(${context.instanceId} as uuid),
      ${context.nodeId},
      ${waitToken},
      ${TIMER_WAIT_KIND},
      ${jsonbLiteral({
        mode: config.mode ?? "duration",
        durationAmount: config.durationAmount ?? null,
        durationUnit: config.durationUnit ?? null,
        skipWeekends: config.skipWeekends === true,
        untilAt: typeof config.untilAt === "string" ? config.untilAt : null,
        computedAt: now.toISOString(),
      })},
      ${deadline}
    )
    on conflict (tenant_id, wait_token) do update set updated_at = now()
    returning resume_at::text, resumed_at::text
  `.execute(context.db);

  const row = registered.rows[0];
  const resumeAt = row?.resume_at ?? deadline.toISOString();

  if (!row?.resumed_at) {
    // Claim it here if it is already due. This covers a deadline that was
    // always in the past — a past `untilAt`, or a zero duration — which would
    // otherwise park for a whole sweep interval to answer a question already
    // settled. It also closes the race where the sweep claims between
    // enqueueing the resume and this replay running.
    const claimed = await sql<{ wait_token: string }>`
      update workflow.waits
      set resumed_at = now(), updated_at = now()
      where tenant_id = cast(${context.tenantId} as uuid)
        and wait_token = ${waitToken}
        and resume_at is not null
        and resumed_at is null
        and resume_at <= now()
      returning wait_token
    `.execute(context.db);

    if (claimed.rows.length === 0) {
      return {
        outputHandle: "default",
        payload: { mode: config.mode ?? "duration", resumeAt, waiting: true },
        wait: { waitToken, waitKind: TIMER_WAIT_KIND },
      };
    }
  }

  return {
    outputHandle: "default",
    payload: {
      mode: config.mode ?? "duration",
      resumeAt,
      firedAt: now.toISOString(),
      waited: true,
    },
  };
};

export function registerTimerNodeBridge(): void {
  registerWorkflowNodeBridge(TIMER_NODE_TYPE, timerNodeBridge);
}
