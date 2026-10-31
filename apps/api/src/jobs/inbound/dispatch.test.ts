// SPDX-License-Identifier: BUSL-1.1
/**
 * How an admitted delivery's dispatch ends, and why each ending is the honest
 * one.
 *
 * The broker is stubbed because what this file decides is the TRANSLATION, not
 * the authority: whether a canonical answer becomes `done`, `retry`, `failed`
 * or `outcome_unknown`, and whether a delivery is ever closed as delivered on
 * an answer that did not say so. The authority itself — the service identity,
 * the contract pin, the uncertain-repeat refusal — is
 * operations/durable-worker.test.ts, which already covers it.
 *
 * The case that matters most is `outcome_unknown`: a dispatch whose external
 * effect cannot be ruled out is never retried automatically, because no
 * exactly-once promise exists to fall back on.
 */
import { expect, test } from "bun:test";
import type {
  RuntimeDurableOperationRequest, RuntimeDurableWorkReference, RuntimeJobOutcome,
  RuntimeOperationExecutionResult, RuntimeWorkerOperationBroker,
} from "@openshapeforge/plugin-runtime";
import type { ModuleJobHandlerContext } from "../../modules/contract.js";
import { createInboundDispatchHandler } from "./dispatch.js";

const DELIVERY = "00000000-0000-4000-8000-0000000000e5";
const WORKER = "00000000-0000-4000-8000-0000000000f6";

type Settled = { state: string; deliveryId: string };

/**
 * The handler context, minus a database: the settlement is injected below, and
 * the statement it stands in for is exercised against Postgres in
 * db/__tests__/inbound-deliveries.test.ts.
 */
function context(attempt = 1): ModuleJobHandlerContext {
  return {
    job: {
      id: "00000000-0000-4000-8000-000000000001", tenantId: "00000000-0000-4000-8000-0000000000a1",
      actorId: "00000000-0000-4000-8000-0000000000d4", kind: "osf-inbound.dispatch",
      attempt, maxAttempts: 5, subject: { entity: "InboundDelivery", id: DELIVERY },
    },
    db: undefined as unknown as ModuleJobHandlerContext["db"],
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
}

function broker(answers: {
  authorize?: (reference: RuntimeDurableWorkReference) => Promise<RuntimeDurableOperationRequest>;
  execute?: () => Promise<RuntimeOperationExecutionResult>;
}): { broker: RuntimeWorkerOperationBroker; references: RuntimeDurableWorkReference[] } {
  const references: RuntimeDurableWorkReference[] = [];
  const request = {
    authority: { mode: "serviceIdentity", serviceIdentityId: "fixture-service-identity" },
    capability: Object.freeze({}),
    operation: { operation: { id: "integrations.jira.receiveAdminEvent" }, idempotencyKey: `inbound.${DELIVERY}.${"a".repeat(64)}` },
  } as unknown as RuntimeDurableOperationRequest;
  return {
    references,
    broker: {
      authorize: async (reference) => {
        references.push(reference);
        return answers.authorize ? answers.authorize(reference) : request;
      },
      execute: async () => (answers.execute ? answers.execute() : { intent: "receive", data: { ok: true } } as unknown as RuntimeOperationExecutionResult),
    },
  };
}

function handler(instance: RuntimeWorkerOperationBroker | undefined, settled: Settled[]) {
  return createInboundDispatchHandler({
    broker: () => instance, workerId: () => WORKER,
    settle: async (_context, input) => { settled.push({ state: input.state, deliveryId: input.deliveryId }); },
  });
}

async function run(
  instance: RuntimeWorkerOperationBroker | undefined, attempt = 1,
): Promise<{ outcome: RuntimeJobOutcome | void; settled: Settled[] }> {
  const settled: Settled[] = [];
  const outcome = await handler(instance, settled)({ deliveryId: DELIVERY }, context(attempt));
  return { outcome, settled };
}

test("a successful dispatch closes the delivery as delivered", async () => {
  const stub = broker({});
  const { outcome, settled } = await run(stub.broker);
  expect(outcome).toEqual({ outcome: "done", result: { deliveryId: DELIVERY } });
  expect(settled).toEqual([{ state: "delivered", deliveryId: DELIVERY }]);
  // The claim reference carries THIS attempt, which is what fences the work.
  expect(stub.references[0]).toEqual({ workId: DELIVERY, attempt: 1, workerId: WORKER });
});

test("a reclaim after a crash carries its own attempt, so the pin can fence it", async () => {
  const stub = broker({});
  await run(stub.broker, 3);
  expect(stub.references[0]?.attempt).toBe(3);
});

test("a retryable canonical refusal retries and leaves the delivery open", async () => {
  const stub = broker({
    execute: async () => ({ error: { code: "OPERATION_TEMPORARILY_UNAVAILABLE", message: "throttled", retryable: true, retryAt: "2026-10-30T12:00:00.000Z" } }),
  });
  const { outcome, settled } = await run(stub.broker);
  expect((outcome as { outcome: string }).outcome).toBe("retry");
  expect((outcome as { retryAt?: Date }).retryAt?.toISOString()).toBe("2026-10-30T12:00:00.000Z");
  // Not settled: the delivery is still owed a dispatch.
  expect(settled).toEqual([]);
});

test("an uncertain write is never retried on its own and waits for an operator", async () => {
  const stub = broker({
    execute: async () => ({ error: { code: "OPERATION_OUTCOME_UNKNOWN", message: "may already have run", retryable: false } }),
  });
  const { outcome, settled } = await run(stub.broker);
  expect((outcome as { outcome: string }).outcome).toBe("outcome_unknown");
  expect(settled).toEqual([{ state: "outcome_unknown", deliveryId: DELIVERY }]);
});

test("a permanent refusal is terminal, and the delivery says so", async () => {
  const stub = broker({
    execute: async () => ({ error: { code: "FORBIDDEN", message: "the service identity may not run this", retryable: false } }),
  });
  const { outcome, settled } = await run(stub.broker);
  expect((outcome as { outcome: string }).outcome).toBe("failed");
  expect(settled).toEqual([{ state: "failed", deliveryId: DELIVERY }]);
});

test("a lost claim is retryable; a changed contract is not", async () => {
  const lost = broker({
    authorize: async () => { throw Object.assign(new Error("claim lost"), { code: "DURABLE_CLAIM_LOST", retryable: true }); },
  });
  const retried = await run(lost.broker);
  expect((retried.outcome as { outcome: string }).outcome).toBe("retry");
  expect(retried.settled).toEqual([]);

  const changed = broker({
    authorize: async () => { throw Object.assign(new Error("contract changed"), { code: "OPERATION_CONTRACT_CHANGED", retryable: false }); },
  });
  const failed = await run(changed.broker);
  expect((failed.outcome as { outcome: string }).outcome).toBe("failed");
  expect(failed.settled).toEqual([{ state: "failed", deliveryId: DELIVERY }]);
});

test("an authorization that already classifies the write as uncertain stays uncertain", async () => {
  const stub = broker({
    authorize: async () => { throw Object.assign(new Error("may already have run"), { code: "OPERATION_OUTCOME_UNKNOWN", retryable: false }); },
  });
  const { outcome, settled } = await run(stub.broker);
  expect((outcome as { outcome: string }).outcome).toBe("outcome_unknown");
  expect(settled).toEqual([{ state: "outcome_unknown", deliveryId: DELIVERY }]);
});

test("a dispatch that throws instead of answering is uncertain, never a retry", async () => {
  // The broker's contract is to RETURN its failures. A throw out of execute is
  // unclassified, and this handler cannot prove it happened before the
  // Operation's external effect — so it must not become an automatic retry.
  const stub = broker({ execute: async () => { throw new Error("the connection dropped mid-request"); } });
  const { outcome, settled } = await run(stub.broker);
  expect((outcome as { outcome: string }).outcome).toBe("outcome_unknown");
  expect(settled).toEqual([{ state: "outcome_unknown", deliveryId: DELIVERY }]);
});

test("a worker without the durable broker fails closed instead of burning retries", async () => {
  const { outcome, settled } = await run(undefined);
  expect(outcome).toEqual({
    outcome: "failed",
    error: { code: "DURABLE_DISPATCH_UNAVAILABLE", message: "This worker cannot authorize an automatic dispatch." },
  });
  expect(settled).toEqual([{ state: "failed", deliveryId: DELIVERY }]);
});

test("a job that names no delivery is terminal and settles nothing", async () => {
  const stub = broker({});
  const settled: Settled[] = [];
  for (const deliveryId of [undefined, "", "not-a-uuid", 42]) {
    const outcome = await handler(stub.broker, settled)({ deliveryId } as Record<string, unknown>, context());
    expect(outcome).toEqual({
      outcome: "failed",
      error: { code: "INBOUND_DELIVERY_INVALID", message: "The job names no inbound delivery." },
    });
  }
  // Nothing to settle and nothing to authorize: there is no delivery named.
  expect(settled).toEqual([]);
  expect(stub.references).toHaveLength(0);
});
