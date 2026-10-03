// SPDX-License-Identifier: BUSL-1.1
/**
 * #885: a 429, 5xx or network error on the worker's token, catalog or
 * execute call is transient. It is retried inside the claim with backoff
 * (honouring Retry-After) and, when the budget runs out, reported retryable
 * with a retryAt. Contract and authorization answers stay permanent, and an
 * uncertain write is still never repeated.
 */
import { expect, test } from "bun:test";
import type { RuntimeOperationDefinition, RuntimeResolvedOperationWork } from "@openshapeforge/plugin-runtime";
import { createDurableWorkerBroker } from "./durable-worker.js";
import { isCanonicalResult, isLimiterRefusal, retryAfterMs } from "./durable-worker-http.js";

const identity = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "org-worker", clientSecret: "never-print-this" };
const reference = { workId: "command-1", attempt: 1, workerId: "worker-1" };
const limiter = (headers: Record<string, string> = {}) =>
  Response.json({ statusCode: 429, code: "RATE_LIMITED", error: "Too Many Requests", message: "Rate limit exceeded. Please retry later." }, { status: 429, headers });

type Answer = Response | Error;
type Options = { tracked?: boolean; sleep?: (ms: number) => Promise<void>; clock?: { now: number } };
function fixture(answers: { token?: Answer[]; catalog?: Answer[]; execute?: Answer[] }, mode: "none" | "keyed" = "keyed", extra: Options = {}) {
  const clock = extra.clock ?? { now: 1000 };
  let work: RuntimeResolvedOperationWork = {
    tenantId: identity.tenantId, serviceIdentityId: identity.clientId,
    operation: { id: "Note.create", input: { value: "requested" }, idempotencyKey: "stable-key" },
    ...(extra.tracked ? { dispatch: { tracked: true as const } } : {}),
  };
  const marks: string[] = [];
  const definition = { id: "Note.create", intent: "Note.create", effects: { data: "write", external: "none" },
    reliability: { idempotency: { mode } } } as RuntimeOperationDefinition;
  const calls = { token: 0, catalog: 0, execute: 0 };
  const sleeps: number[] = [];
  const next = (queue: Answer[] | undefined, fallback: () => Response) => {
    const answer = queue?.shift() ?? fallback();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const broker = createDurableWorkerBroker({
    identities: [identity], apiUrl: "http://127.0.0.1:3121", tokenUrl: "http://127.0.0.1:8181/token",
    now: () => clock.now, resolveWork: async () => work,
    ...(extra.tracked ? { markDispatch: async (reference: { attempt: number }, state: "started" | "not-dispatched") => {
      marks.push(state);
      work = { ...work, dispatch: state === "started" ? { tracked: true, attempt: reference.attempt } : { tracked: true } };
    } } : {}),
    pinOperationContract: async (_reference, fingerprint) => { work = { ...work, operationContractFingerprint: work.operationContractFingerprint ?? fingerprint }; },
    verify: async () => ({ tenantId: identity.tenantId, userId: "service-subject", serviceIdentityId: identity.clientId }),
    transientRetry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 2_000, now: () => clock.now,
      sleep: async (ms) => { sleeps.push(ms); await extra.sleep?.(ms); } },
    fetch: (async (url: URL) => {
      const path = String(url);
      if (path.endsWith("/token")) { calls.token += 1; return next(answers.token, () => Response.json({ access_token: "token" })); }
      if (path.endsWith("/execute")) { calls.execute += 1; return next(answers.execute, () => Response.json({ data: { id: "created" }, operations: [] })); }
      calls.catalog += 1;
      return next(answers.catalog, () => Response.json(definition));
    }) as typeof fetch,
  });
  return { broker, calls, sleeps, marks, work: () => work, setWork: (next: RuntimeResolvedOperationWork) => { work = next; } };
}

async function refusal(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return error as { code: string; retryable: boolean; retryAt?: string }; }
  throw new Error("expected a refusal");
}

test("a throttled catalog read is retried with backoff and Retry-After, then authorizes", async () => {
  const f = fixture({ catalog: [limiter({ "retry-after": "1" }), new Response("busy", { status: 503 })] });
  const request = await f.broker.authorize(reference);
  expect(request.operation.operation.id).toBe("Note.create");
  expect(f.calls.catalog).toBe(3);
  expect(f.sleeps).toEqual([1_000, 200]);
});

test("a catalog that stays throttled is a RETRYABLE failure with retryAt, never permanent", async () => {
  const f = fixture({ catalog: [limiter(), limiter(), limiter({ "retry-after": "30" })] });
  const error = await refusal(f.broker.authorize(reference));
  expect(error).toMatchObject({ code: "OPERATION_UNAVAILABLE", retryable: true });
  expect(error.retryAt).toBe(new Date(1000 + 30_000).toISOString());
  expect(f.calls.catalog).toBe(3);
});

test("server faults and network errors on token and catalog are transient", async () => {
  const token = fixture({ token: [new Response("", { status: 502 }), new TypeError("connection reset")] });
  await token.broker.authorize(reference);
  expect(token.calls.token).toBe(3);
  const down = fixture({ catalog: [new Response("", { status: 500 }), new Response("", { status: 500 }), new Response("", { status: 500 })] });
  expect(await refusal(down.broker.authorize(reference))).toMatchObject({ code: "OPERATION_UNAVAILABLE", retryable: true });
  const throttledToken = fixture({ token: [limiter(), limiter(), limiter()] });
  expect(await refusal(throttledToken.broker.authorize(reference))).toMatchObject({ code: "SERVICE_IDENTITY_UNAVAILABLE", retryable: true });
});

test("contract and authorization answers are permanent and not retried", async () => {
  for (const status of [400, 401, 403, 404, 422, 501, 505]) {
    const f = fixture({ catalog: [Response.json({ error: { code: "X" } }, { status })] });
    const error = await refusal(f.broker.authorize(reference));
    expect(error).toMatchObject({ code: "OPERATION_UNAVAILABLE", retryable: false });
    expect(error.retryAt).toBeUndefined();
    expect(f.calls.catalog).toBe(1);
  }
  const invalid = fixture({ catalog: [Response.json({ id: "Note.create", intent: "Note.create" })] });
  expect(await refusal(invalid.broker.authorize(reference))).toMatchObject({ code: "OPERATION_CONTRACT_INVALID", retryable: false });
});

test("the limiter's 429 on execute is re-sent within the claim, even for a non-keyed write", async () => {
  const f = fixture({ execute: [limiter({ "retry-after": "1" })] }, "none");
  const request = await f.broker.authorize(reference);
  expect(await f.broker.execute(request)).toEqual({ data: { id: "created" }, operations: [] });
  expect(f.calls.execute).toBe(2);
});

test("a limiter that keeps refusing a non-keyed write: retryable, recorded as not dispatched, and the next attempt may run", async () => {
  const f = fixture({ execute: [limiter(), limiter(), limiter({ "retry-after": "1" })] }, "none", { tracked: true });
  const result = await f.broker.execute(await f.broker.authorize(reference));
  expect(result).toMatchObject({ error: { code: "OPERATION_TEMPORARILY_UNAVAILABLE", retryable: true, retryAt: new Date(2000).toISOString() } });
  expect(f.marks).toEqual(["started", "not-dispatched"]);
  expect(f.work().dispatch).toEqual({ tracked: true });
  // The retry is attempt 2 of the same command: nothing ran, so it is authorized and executes.
  const retried = { ...reference, attempt: 2 };
  expect(await f.broker.execute(await f.broker.authorize(retried))).toEqual({ data: { id: "created" }, operations: [] });
});

test("without persisted dispatch facts a reclaimed non-keyed write stays refused (the conservative default)", async () => {
  const f = fixture({ execute: [limiter(), limiter(), limiter()] }, "none");
  expect(await f.broker.execute(await f.broker.authorize(reference))).toMatchObject({ error: { code: "OPERATION_TEMPORARILY_UNAVAILABLE", retryable: true } });
  expect(await refusal(f.broker.authorize({ ...reference, attempt: 2 }))).toMatchObject({ code: "OPERATION_OUTCOME_UNKNOWN" });
});

test("a transient catalog failure before the pin does not make the next attempt an uncertain write", async () => {
  const f = fixture({ catalog: [limiter(), limiter(), limiter()] }, "none", { tracked: true });
  expect(await refusal(f.broker.authorize(reference))).toMatchObject({ code: "OPERATION_UNAVAILABLE", retryable: true });
  const retried = { ...reference, attempt: 2 };
  expect(await f.broker.execute(await f.broker.authorize(retried))).toEqual({ data: { id: "created" }, operations: [] });
});

test("a request that may have reached the write keeps its dispatch on record and is an unknown outcome", async () => {
  const f = fixture({ execute: [new TypeError("socket hang up")] }, "none", { tracked: true });
  expect(await f.broker.execute(await f.broker.authorize(reference))).toMatchObject({ error: { code: "OPERATION_OUTCOME_UNKNOWN" } });
  expect(f.work().dispatch).toEqual({ tracked: true, attempt: 1 });
  expect(await refusal(f.broker.authorize({ ...reference, attempt: 2 }))).toMatchObject({ code: "OPERATION_OUTCOME_UNKNOWN" });
});

test("an abort while waiting out a limiter refusal is not an unknown outcome", async () => {
  const f = fixture({ execute: [limiter()] }, "none", { tracked: true, sleep: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } });
  const result = await f.broker.execute(await f.broker.authorize(reference));
  expect(result).toMatchObject({ error: { code: "OPERATION_TEMPORARILY_UNAVAILABLE", retryable: true } });
  expect(f.work().dispatch).toEqual({ tracked: true });
});

test("waiting that outlives the 30 s capability is retryable and dispatches nothing", async () => {
  const clock = { now: 1000 };
  const f = fixture({ execute: [limiter({ "retry-after": "2" }), limiter()] }, "none", { tracked: true, clock, sleep: async (ms) => { clock.now += ms + 29_000; } });
  const result = await f.broker.execute(await f.broker.authorize(reference));
  expect(result).toMatchObject({ error: { code: "DURABLE_CAPABILITY_EXPIRED", retryable: true } });
  expect(f.calls.execute).toBe(1);
  expect(f.work().dispatch).toEqual({ tracked: true });
});

test("a Retry-After beyond the in-claim budget is handed back, not slept through", async () => {
  const f = fixture({ execute: [limiter({ "retry-after": "60" })] }, "none", { tracked: true });
  const result = await f.broker.execute(await f.broker.authorize(reference));
  expect(result).toMatchObject({ error: { code: "OPERATION_TEMPORARILY_UNAVAILABLE", retryable: true, retryAt: new Date(61_000).toISOString() } });
  expect(f.sleeps).toEqual([]);
  expect(f.calls.execute).toBe(1);
});

test("a canonical 429 from the Operation and a write's 5xx are never re-sent", async () => {
  const canonical = { error: { code: "LOCKED", message: "Bezet.", retryable: true } };
  const own = fixture({ execute: [Response.json(canonical, { status: 429 })] }, "none");
  expect(await own.broker.execute(await own.broker.authorize(reference))).toEqual(canonical);
  expect(own.calls.execute).toBe(1);
  const fault = fixture({ execute: [Response.json({ error: { code: "INTERNAL" } }, { status: 503 })] }, "none");
  expect(await fault.broker.execute(await fault.broker.authorize(reference))).toMatchObject({ error: { code: "OPERATION_OUTCOME_UNKNOWN" } });
  expect(fault.calls.execute).toBe(1);
});

test("helpers: Retry-After forms and what counts as canonical", async () => {
  expect(retryAfterMs(new Response("", { headers: { "retry-after": "5" } }), 0)).toBe(5_000);
  expect(retryAfterMs(new Response("", { headers: { "retry-after": new Date(10_000).toUTCString() } }), 0)).toBe(10_000);
  expect(retryAfterMs(new Response(""), 0)).toBeUndefined();
  expect(isCanonicalResult({ data: null })).toBe(true);
  expect(isCanonicalResult({ error: { code: "X" } })).toBe(true);
  expect(isCanonicalResult({ error: "Too Many Requests" })).toBe(false);
  expect(await isLimiterRefusal(limiter())).toBe(true);
  expect(await isLimiterRefusal(Response.json({ error: { code: "LOCKED" } }, { status: 429 }))).toBe(false);
  // Neither the limiter's code nor its headers: not provably the limiter.
  expect(await isLimiterRefusal(Response.json({ error: "Too Many Requests" }, { status: 429 }))).toBe(false);
  expect(await isLimiterRefusal(Response.json({ error: "Too Many Requests" }, { status: 429, headers: { "x-ratelimit-limit": "600" } }))).toBe(true);
});
