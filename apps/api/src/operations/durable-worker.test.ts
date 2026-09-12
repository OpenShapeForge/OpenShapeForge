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
  let deny = false, uncertain = false, wrongTenant = false, wrongClient = false, now = 1000;
  const calls: Array<{ url: string; method: string; body: unknown; redirect: unknown }> = [];
  const definition = { id: "Note.create", intent: "Note.create", effects: { data: "write", external: "none" },
    reliability: { idempotency: { mode } } } as RuntimeOperationDefinition;
  const broker = createDurableWorkerBroker({
    identities: [identity], apiUrl: "http://127.0.0.1:3121", tokenUrl: "http://127.0.0.1:8181/token",
    now: () => now, resolveWork: async () => work,
    verify: async () => ({ tenantId: wrongTenant ? "other" : identity.tenantId, userId: "service-subject",
      serviceIdentityId: wrongClient ? "different-service" : identity.clientId }),
    fetch: (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body, redirect: init?.redirect });
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
    wrongClient: () => { wrongClient = true; }, expire: () => { now += 31_000; } };
}

test("core resolves exact work, mints opaque authority, and uses fresh identity at execution", async () => {
  const f = fixture();
  const request = await f.broker.authorize(reference);
  expect(request.authority).toEqual({ mode: "serviceIdentity", serviceIdentityId: identity.clientId });
  expect(JSON.stringify(request)).not.toContain(identity.clientSecret);
  expect(Object.isFrozen(request.operation.input)).toBe(true);
  expect(await f.broker.execute(request)).toEqual({ data: { id: "created" }, operations: [] });
  expect(f.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(2);
  expect(f.calls.every((call) => call.redirect === "error")).toBe(true);
  expect(f.calls.find((call) => call.url.endsWith("/execute"))?.body).toBe(JSON.stringify({ intent: "Note.create", input: { value: "requested" } }));
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
  const request = await f.broker.authorize({ ...reference, attempt: 2 });
  expect(request.operation.idempotencyKey).toBe("stable-key");
  expect(request.operation.input).toEqual({ value: "requested" });
  expect(await f.broker.execute(request)).toMatchObject({ error: { code: "OPERATION_TEMPORARILY_UNAVAILABLE", retryable: true } });
});
