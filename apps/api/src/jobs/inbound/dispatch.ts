// SPDX-License-Identifier: BUSL-1.1
/**
 * The `osf-inbound.dispatch` job handler: an admitted delivery becomes one
 * canonical Operation invocation under the organization's service identity.
 *
 * The handler itself decides almost nothing. It hands the broker a claim
 * reference, and the broker (operations/durable-worker.ts) does the work that
 * matters: it exchanges the service identity for a fresh token, re-reads the
 * Operation's current contract, refuses a contract that changed since the pin,
 * refuses a write that an earlier attempt may already have performed, records
 * the dispatch before the request leaves, and executes with the delivery's
 * stable idempotency key.
 *
 * What this file owns is the translation of that answer into a job outcome,
 * and it is deliberately conservative:
 *
 *   success                      → done, delivery `delivered`
 *   retryable canonical error    → retry, delivery stays open
 *   OPERATION_OUTCOME_UNKNOWN    → outcome_unknown; an operator decides
 *   anything else                → failed (terminal), delivery `failed`
 *
 * No exactly-once claim is made or implied. The receipt and the queued work
 * commit atomically, and a delivery is dispatched under one stable key — so
 * repetition is BOUNDED and a repeat is recognisable to the Operation. Whether
 * the Operation's own external effect happened exactly once is the Operation's
 * contract to keep, and where it cannot be known the honest answer is
 * `outcome_unknown` rather than a retry.
 */
import type {
  RuntimeDurableOperationRequest, RuntimeJobError, RuntimeJobOutcome,
  RuntimeOperationExecutionResult, RuntimeWorkerOperationBroker,
} from "@openshapeforge/plugin-runtime";
import type { ModuleJobHandler, ModuleJobHandlerContext } from "../../modules/contract.js";
import { settleInboundDeliverySql, type InboundDeliverySettlement } from "./work.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical codes that mean the Operation may already have run. */
const UNCERTAIN = new Set(["OPERATION_OUTCOME_UNKNOWN"]);

/**
 * A thrown broker failure as a job error. The broker's own code and message are
 * kept when it supplied them — they are server-authored and say more than a
 * generic line — and the fallbacks name what this handler could establish.
 */
function failureOf(cause: unknown, code: string, message: string): RuntimeJobError {
  const thrown = cause as { code?: unknown; message?: unknown } | null;
  return {
    code: typeof thrown?.code === "string" && thrown.code.length > 0 ? thrown.code : code,
    message: typeof thrown?.message === "string" && thrown.message.length > 0 ? thrown.message : message,
  };
}

function errorOf(result: RuntimeOperationExecutionResult): RuntimeJobError | undefined {
  const error = (result as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    message: typeof message === "string" ? message : "The inbound dispatch failed.",
    ...(typeof code === "string" ? { code } : {}),
  };
}

export type InboundDispatchHandlerOptions = {
  /**
   * The broker the worker role was started with, read lazily: the handler
   * registry is composed when the module is created, and the broker only
   * exists once `start` receives the worker context.
   */
  broker(): RuntimeWorkerOperationBroker | undefined;
  /** This worker process's identity; telemetry on the claim reference. */
  workerId(): string;
  /**
   * Write the delivery's terminal state. Defaults to the real statement on the
   * handler's own tenant transaction, so it commits together with the job's
   * outcome; a parameter so the outcome translation above can be exercised
   * without a database, which is where its mistakes would be.
   */
  settle?: InboundDeliverySettle;
};

export type InboundDeliverySettle = (
  context: ModuleJobHandlerContext,
  input: { deliveryId: string; state: InboundDeliverySettlement; error: RuntimeJobError | null },
) => Promise<void>;

/** The default: the delivery's own row, in the handler's tenant transaction. */
export const settleInboundDelivery: InboundDeliverySettle = async (context, input) => {
  await settleInboundDeliverySql(
    input.deliveryId, input.state, input.error as Record<string, unknown> | null,
  ).execute(context.db);
};

export function createInboundDispatchHandler(options: InboundDispatchHandlerOptions): ModuleJobHandler {
  const settleDelivery = options.settle ?? settleInboundDelivery;
  return async function dispatch(payload, context): Promise<RuntimeJobOutcome> {
    const settle = (state: InboundDeliverySettlement, deliveryId: string, error: RuntimeJobError | null) =>
      settleDelivery(context, { deliveryId, state, error });
    const deliveryId = typeof payload.deliveryId === "string" ? payload.deliveryId : "";
    if (!UUID.test(deliveryId)) {
      // Nothing to dispatch and nothing to settle: a payload core did not
      // write. Terminal, because no retry turns it into a delivery.
      return { outcome: "failed", error: { code: "INBOUND_DELIVERY_INVALID", message: "The job names no inbound delivery." } };
    }
    const broker = options.broker();
    if (!broker) {
      // A worker without the durable broker cannot authorize a machine
      // dispatch at all. Terminal rather than retried: it is a configuration
      // problem, and burning the attempt budget on it hides that.
      const error = { code: "DURABLE_DISPATCH_UNAVAILABLE", message: "This worker cannot authorize an automatic dispatch." };
      await settle("failed", deliveryId, error);
      return { outcome: "failed", error };
    }

    const reference = { workId: deliveryId, attempt: context.job.attempt, workerId: options.workerId() };
    // Two try blocks, not one, and the split is the point. Authorization runs
    // strictly BEFORE any request reaches the Operation, so a throw there
    // proves nothing ran. Execution is different: the broker's contract is to
    // RETURN its failures, so a throw out of it is something nobody
    // classified — and this handler cannot prove it happened before the
    // external effect. Collapsing the two would turn that case into a retry.
    let request: RuntimeDurableOperationRequest;
    try {
      // Authorization mints a short-lived capability bound to this exact
      // claim, work and request; nothing it returns can be replayed or widened.
      request = await broker.authorize(reference);
    } catch (cause) {
      const failure = failureOf(cause, "DURABLE_AUTHORIZATION_FAILED",
        "The inbound delivery could not be authorized for dispatch.");
      // An uncertainty the broker already established — a reclaimed write it
      // cannot vouch for — is never retried on its own.
      if (UNCERTAIN.has(failure.code!)) {
        await settle("outcome_unknown", deliveryId, failure);
        return { outcome: "outcome_unknown", error: failure };
      }
      if ((cause as { retryable?: boolean } | null)?.retryable === true) {
        return { outcome: "retry", error: failure };
      }
      await settle("failed", deliveryId, failure);
      return { outcome: "failed", error: failure };
    }

    let result: RuntimeOperationExecutionResult;
    try {
      result = await broker.execute(request);
    } catch (cause) {
      const failure = failureOf(cause, "OPERATION_OUTCOME_UNKNOWN",
        "The inbound dispatch did not report back. Check the result before the delivery is retried.");
      await settle("outcome_unknown", deliveryId, failure);
      return { outcome: "outcome_unknown", error: failure };
    }

    const error = errorOf(result);
    if (!error) {
      await settle("delivered", deliveryId, null);
      return { outcome: "done", result: { deliveryId } };
    }
    if (error.code && UNCERTAIN.has(error.code)) {
      await settle("outcome_unknown", deliveryId, error);
      return { outcome: "outcome_unknown", error };
    }
    if ((result as { error?: { retryable?: boolean } }).error?.retryable === true) {
      const retryAt = (result as { error?: { retryAt?: string } }).error?.retryAt;
      const parsed = retryAt ? Date.parse(retryAt) : Number.NaN;
      return {
        outcome: "retry", error,
        ...(Number.isFinite(parsed) ? { retryAt: new Date(parsed) } : {}),
      };
    }
    await settle("failed", deliveryId, error);
    return { outcome: "failed", error };
  };
}
