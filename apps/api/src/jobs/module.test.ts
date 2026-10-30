// SPDX-License-Identifier: BUSL-1.1
/**
 * What the core `osf-jobs` module contributes, and the one thing it must not.
 *
 * `roles/worker.ts` constructs the durable broker as soon as a worker
 * contributes `resolveOperationWork`, and the broker validates its endpoints
 * at construction. So contributing the resolvers on a host with no service
 * identity configured would stop `job-worker` from starting at all — taking
 * `mail.deliver` with it on every deployment that has no inbound endpoints.
 * That regression is what this file exists to catch.
 */
import { expect, test } from "bun:test";
import { MAIL_DELIVER_KIND } from "./mail/deliver.js";
import { INBOUND_DISPATCH_KIND } from "./inbound/kind.js";
import { createJobsRuntimeModule, durableDispatchConfigured, JOB_WORKER_ROLE } from "./module.js";

const configured = {
  OPENSHAPEFORGE_OPERATION_API_URL: "https://api.example.test",
  OPENSHAPEFORGE_SERVICE_IDENTITY_TOKEN_URL: "https://auth.example.test/token",
} satisfies NodeJS.ProcessEnv;

function worker(env: NodeJS.ProcessEnv) {
  const module = createJobsRuntimeModule({
    modules: () => [], env,
    mailProvider: { name: "test", send: async () => ({ providerMessageId: "test" }) },
  });
  return { module, contributed: module.workers?.[JOB_WORKER_ROLE] };
}

test("both job kinds are registered whatever the host can authorize", () => {
  for (const env of [{}, configured]) {
    const { module } = worker(env);
    expect(Object.keys(module.jobHandlers ?? {}).sort()).toEqual([INBOUND_DISPATCH_KIND, MAIL_DELIVER_KIND].sort());
  }
});

test("a host with a service identity contributes the durable work store, all three parts", () => {
  const { contributed } = worker(configured);
  expect(durableDispatchConfigured(configured)).toBe(true);
  expect(typeof contributed?.resolveOperationWork).toBe("function");
  expect(typeof contributed?.pinOperationContract).toBe("function");
  // Without the dispatch mark, core would infer uncertainty from `attempt > 1`
  // and refuse retries it can in fact prove never reached the Operation.
  expect(typeof contributed?.markOperationDispatch).toBe("function");
});

test("a host that cannot authorize a machine dispatch still drains its queue", () => {
  for (const env of [
    {},
    { OPENSHAPEFORGE_OPERATION_API_URL: configured.OPENSHAPEFORGE_OPERATION_API_URL },
    { OPENSHAPEFORGE_SERVICE_IDENTITY_TOKEN_URL: configured.OPENSHAPEFORGE_SERVICE_IDENTITY_TOKEN_URL },
    { ...configured, OPENSHAPEFORGE_OPERATION_API_URL: "not-a-url" },
    // HTTP off loopback is refused by the endpoint rule, so it is not a
    // configuration this may quietly accept either.
    { ...configured, OPENSHAPEFORGE_SERVICE_IDENTITY_TOKEN_URL: "http://auth.example.test/token" },
  ] as NodeJS.ProcessEnv[]) {
    expect(durableDispatchConfigured(env)).toBe(false);
    const { contributed } = worker(env);
    // Nothing contributed, so roles/worker.ts builds no broker and the worker
    // starts exactly as it did before inbound deliveries existed.
    expect(contributed?.resolveOperationWork).toBeUndefined();
    expect(contributed?.pinOperationContract).toBeUndefined();
    expect(contributed?.markOperationDispatch).toBeUndefined();
    // And it is still a worker: the queue keeps draining.
    expect(typeof contributed?.start).toBe("function");
  }
});
