// SPDX-License-Identifier: BUSL-1.1

import { expect, test } from "bun:test";
import type { RuntimeOperationDefinition, RuntimeResolvedOperationWork } from "@openshapeforge/plugin-runtime";
import { createDurableWorkerBroker } from "./durable-worker.js";

const identity = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "org-worker", clientSecret: "never-print-this" };
const reference = { workId: "command-1", attempt: 1, workerId: "worker-1" };
function fixture(mode: "none" | "keyed" | "natural" = "keyed") {
  let work: RuntimeResolvedOperationWork | undefined = {
    tenantId: identity.tenantId, serviceIdentityId: identity.clientId,
    operation: { id: "Note.create", input: { value: "requested" }, idempotencyKey: "stable-key" },
  };
  let deny = false, uncertain = false, pinFails = false;
  let wrongTenant = false, wrongClient = false, now = 1000;
  let pinCalls = 0;
  const calls: Array<{ url: string; method: string; body: unknown; redirect: unknown; key: string | null }> = [];
  const definition = { id: "Note.create", intent: "Note.create", effects: { data: "write", external: "none" },
    reliability: { idempotency: { mode } } } as RuntimeOperationDefinition;
  const broker = createDurableWorkerBroker({
    identities: [identity], apiUrl: "http://127.0.0.1:3121", tokenUrl: "http://127.0.0.1:8181/token",
    now: () => now, resolveWork: async () => work,
    pinOperationContract: async (_reference, contractFingerprint) => {
      pinCalls += 1;
      if (pinFails) throw new Error("private persistence detail");
      if (work) work = { ...work, operationContractFingerprint: work.operationContractFingerprint ?? contractFingerprint };
    },
    verify: async () => ({ tenantId: wrongTenant ? "other" : identity.tenantId, userId: "service-subject",
      serviceIdentityId: wrongClient ? "different-service" : identity.clientId }),
    fetch: (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body, redirect: init?.redirect,
        key: new Headers(init?.headers).get("idempotency-key") });
      if (String(url).endsWith("/token")) return Response.json({ access_token: `token-${calls.length}` });
      if (String(url).endsWith("/execute")) {
        if (uncertain) throw new Error("private bearer transport details must not escape");
        return Response.json({ data: { id: "created" }, operations: [] });
      }
      return deny ? Response.json({ error: {} }, { status: 403 }) : Response.json(definition);
    }) as typeof fetch,
  });
  return { broker, calls, definition, work: () => work!, setWork: (value: RuntimeResolvedOperationWork | undefined) => { work = value; },
    deny: () => { deny = true; }, uncertain: () => { uncertain = true; }, wrongTenant: () => { wrongTenant = true; },
    wrongClient: () => { wrongClient = true; }, pinFails: () => { pinFails = true; },
    pinCalls: () => pinCalls, expire: () => { now += 31_000; } };
}

test("core resolves exact work, mints opaque authority, and uses fresh identity at execution", async () => {
  const f = fixture();
  const request = await f.broker.authorize(reference);
  expect(request.authority).toEqual({ mode: "serviceIdentity", serviceIdentityId: identity.clientId });
  expect(JSON.stringify(request)).not.toContain(identity.clientSecret);
  expect(Object.isFrozen(request.operation.input)).toBe(true);
  expect(f.work().operationContractFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(f.pinCalls()).toBe(1);
  expect(await f.broker.execute(request)).toEqual({ data: { id: "created" }, operations: [] });
  expect(f.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);
  expect(f.calls.every((call) => call.redirect === "error")).toBe(true);
  expect(f.calls.find((call) => call.url.endsWith("/execute"))?.body).toBe(JSON.stringify({
    intent: "Note.create",
    input: { value: "requested" },
    expectedContractFingerprint: f.work().operationContractFingerprint,
  }));
  expect(await f.broker.execute(request)).toMatchObject({ error: { code: "DURABLE_CAPABILITY_REQUIRED" } });
});

test("forged, tampered and expired capabilities cannot execute", async () => {
  const f = fixture();
  const request = await f.broker.authorize(reference);
  expect(await f.broker.execute({ ...request, capability: {} as any })).toMatchObject({ error: { code: "DURABLE_CAPABILITY_REQUIRED" } });
  expect(await f.broker.execute({ ...request, operation: { ...request.operation, input: { value: "tampered" } } })).toMatchObject({ error: { code: "DURABLE_CAPABILITY_REQUIRED" } });
  f.expire();
  expect(await f.broker.execute(request)).toMatchObject({ error: { code: "DURABLE_CAPABILITY_REQUIRED" } });
  expect(f.calls.some((call) => call.url.endsWith("/execute"))).toBe(false);
});

test("cancellation, changed persisted input and revoked roles fail before execution", async () => {
  for (const scenario of ["cancel", "change", "revoke"] as const) {
    const f = fixture(); const request = await f.broker.authorize(reference);
    if (scenario === "cancel") f.setWork(undefined);
    if (scenario === "change") f.setWork({ ...f.work(), operation: { ...f.work().operation, input: { value: "changed" } } });
    if (scenario === "revoke") f.deny();
    expect(await f.broker.execute(request)).toHaveProperty("error");
    expect(f.calls.some((call) => call.url.endsWith("/execute"))).toBe(false);
  }
});

test("authorization fails closed when the contract cannot be persistently pinned", async () => {
  const f = fixture(); f.pinFails();
  await expect(f.broker.authorize(reference)).rejects.toMatchObject({
    code: "DURABLE_CONTRACT_PIN_UNAVAILABLE",
    retryable: true,
  });
  expect(f.calls.some((call) => call.url.endsWith("/execute"))).toBe(false);
});

test("neither stored tenant nor token tenant/client can cross an organization binding", async () => {
  const f = fixture(); f.setWork({ ...f.work(), tenantId: "another" });
  await expect(f.broker.authorize(reference)).rejects.toHaveProperty("code", "SERVICE_IDENTITY_REQUIRED");
  const g = fixture(); g.wrongTenant();
  await expect(g.broker.authorize(reference)).rejects.toHaveProperty("code", "SERVICE_IDENTITY_MISMATCH");
  const h = fixture(); h.wrongClient();
  await expect(h.broker.authorize(reference)).rejects.toHaveProperty("code", "SERVICE_IDENTITY_MISMATCH");
});

test("unknown non-keyed write outcomes never blindly retry, including reclaims", async () => {
  const f = fixture("none"); const request = await f.broker.authorize(reference); f.uncertain();
  expect(await f.broker.execute(request)).toMatchObject({ error: { code: "OPERATION_OUTCOME_UNKNOWN", retryable: false } });
  await expect(f.broker.authorize(reference)).rejects.toHaveProperty("code", "OPERATION_OUTCOME_UNKNOWN");
  await expect(f.broker.authorize({ ...reference, attempt: 2 })).rejects.toHaveProperty("code", "OPERATION_OUTCOME_UNKNOWN");
  expect(JSON.stringify(await f.broker.execute(request))).not.toContain("private bearer");
});

test("keyed retries preserve the same key; no lease/challenge/confirmation is fabricated", async () => {
  const f = fixture("keyed"); f.uncertain();
  const first = await f.broker.authorize(reference);
  expect(await f.broker.execute(first)).toMatchObject({ error: { code: "OPERATION_TEMPORARILY_UNAVAILABLE", retryable: true } });
  const request = await f.broker.authorize({ ...reference, attempt: 2 });
  expect(request.operation.idempotencyKey).toBe("stable-key");
  expect(request.operation.input).toEqual({ value: "requested" });
  expect(await f.broker.execute(request)).toMatchObject({ error: { code: "OPERATION_TEMPORARILY_UNAVAILABLE", retryable: true } });
});

test("an authored Operation delivery key is preserved independently of the durable visit key", async () => {
  const f = fixture();
  f.definition.reliability.idempotency.inputField = "deduplicationKey";
  f.setWork({ ...f.work(), operation: { ...f.work().operation,
    input: { value: "requested", deduplicationKey: "notification-delivery" } } });
  const request = await f.broker.authorize(reference);
  expect(request.operation.idempotencyKey).toBe("notification-delivery");
  expect(request.operation.input).toEqual({ value: "requested", deduplicationKey: "notification-delivery" });
  expect(f.work().operation.idempotencyKey).toBe("stable-key");
  expect(Object.isFrozen(request.operation.input)).toBe(true);
  expect(await f.broker.execute(request)).toHaveProperty("data");
  const dispatched = f.calls.find(call => call.url.endsWith("/execute"))!;
  expect(dispatched.key).toBe("notification-delivery");
  expect(JSON.parse(String(dispatched.body)).input).toEqual(request.operation.input);
});

test("a missing declared key is injected into the immutable canonical body and header", async () => {
  const f = fixture();
  f.definition.reliability.idempotency.inputField = "idempotencyKey";
  const request = await f.broker.authorize(reference);
  expect(request.operation.input).toEqual({ value: "requested", idempotencyKey: "stable-key" });
  expect(f.work().operation.input).toEqual({ value: "requested" });
  expect(await f.broker.execute(request)).toHaveProperty("data");
  const dispatched = f.calls.find(call => call.url.endsWith("/execute"))!;
  expect(dispatched.key).toBe("stable-key");
  expect(JSON.parse(String(dispatched.body)).input.idempotencyKey).toBe(dispatched.key);
});

test("authored delivery keys survive transport retries and may intentionally deduplicate later visits", async () => {
  const f = fixture();
  f.definition.reliability.idempotency.inputField = "deduplicationKey";
  f.setWork({ ...f.work(), operation: { ...f.work().operation,
    input: { value: "requested", deduplicationKey: "same-delivery" } } });
  f.uncertain();
  const first = await f.broker.authorize(reference);
  expect(await f.broker.execute(first)).toMatchObject({ error: { retryable: true } });
  const retry = await f.broker.authorize({ ...reference, attempt: 2 });
  expect(retry.operation).toEqual(first.operation);
  expect(await f.broker.execute(retry)).toMatchObject({ error: { retryable: true } });
  f.setWork({ ...f.work(), operation: { ...f.work().operation, idempotencyKey: "next-visit-key" } });
  const next = await f.broker.authorize({ ...reference, workId: "command-2" });
  expect(next.operation.idempotencyKey).toBe("same-delivery");
  expect(f.work().operation.idempotencyKey).toBe("next-visit-key");
});

test("the canonical key remains bound to the exact capability and persisted input", async () => {
  const f = fixture();
  f.definition.reliability.idempotency.inputField = "deduplicationKey";
  f.setWork({ ...f.work(), operation: { ...f.work().operation, input: { deduplicationKey: "original" } } });
  const first = await f.broker.authorize(reference);
  expect(await f.broker.execute({ ...first, operation: { ...first.operation, idempotencyKey: "forged" } }))
    .toMatchObject({ error: { code: "DURABLE_CAPABILITY_REQUIRED" } });
  f.setWork({ ...f.work(), operation: { ...f.work().operation, input: { deduplicationKey: "changed" } } });
  expect(await f.broker.execute(first)).toMatchObject({ error: { code: "DURABLE_CLAIM_CHANGED" } });
  expect(f.calls.some(call => call.url.endsWith("/execute"))).toBe(false);
});

test("changing the declared key field changes the pinned contract before dispatch or retry", async () => {
  const f = fixture();
  f.definition.reliability.idempotency.inputField = "deduplicationKey";
  const request = await f.broker.authorize(reference);
  f.definition.reliability.idempotency.inputField = "idempotencyKey";
  expect(await f.broker.execute(request)).toMatchObject({ error: { code: "OPERATION_CONTRACT_CHANGED" } });
  await expect(f.broker.authorize({ ...reference, attempt: 2 })).rejects.toHaveProperty("code", "OPERATION_CONTRACT_CHANGED");
  expect(f.calls.some(call => call.url.endsWith("/execute"))).toBe(false);
});

test("invalid authored keys are refused before dispatch rather than retried as transport failures", async () => {
  for (const key of [null, 42, "", "bad\nheader", " padded "]) {
    const f = fixture();
    f.definition.reliability.idempotency.inputField = "deduplicationKey";
    f.setWork({ ...f.work(), operation: { ...f.work().operation, input: { deduplicationKey: key } } });
    await expect(f.broker.authorize(reference)).rejects.toMatchObject({ code: "OPERATION_INPUT_INVALID", retryable: false });
    expect(f.calls.some(call => call.url.endsWith("/execute"))).toBe(false);
  }
});

test("a reclaimed write without a persisted contract never infers safety from the current catalog", async () => {
  const f = fixture("keyed");
  await expect(f.broker.authorize({ ...reference, attempt: 2 })).rejects.toMatchObject({
    code: "OPERATION_OUTCOME_UNKNOWN",
    retryable: false,
  });
  expect(f.pinCalls()).toBe(0);
});

test("same-intent contract drift is refused before dispatch and across broker restarts", async () => {
  const f = fixture("keyed");
  const request = await f.broker.authorize(reference);
  f.definition.effects = { data: "write", external: "write" };
  expect(await f.broker.execute(request)).toMatchObject({ error: { code: "OPERATION_CONTRACT_CHANGED" } });
  expect(f.calls.some((call) => call.url.endsWith("/execute"))).toBe(false);

  // The fingerprint is in persisted work, not process memory. A fresh broker
  // therefore refuses the changed contract on a reclaimed attempt too.
  const restarted = createDurableWorkerBroker({
    identities: [identity], apiUrl: "http://127.0.0.1:3121", tokenUrl: "http://127.0.0.1:8181/token",
    resolveWork: async () => f.work(), pinOperationContract: async () => {},
    verify: async () => ({ tenantId: identity.tenantId, userId: "service-subject", serviceIdentityId: identity.clientId }),
    fetch: (async (url: URL) => String(url).endsWith("/token")
      ? Response.json({ access_token: "fresh-token" })
      : Response.json(f.definition)) as typeof fetch,
  });
  await expect(restarted.authorize({ ...reference, attempt: 2 })).rejects.toMatchObject({
    code: "OPERATION_CONTRACT_CHANGED",
  });
});
