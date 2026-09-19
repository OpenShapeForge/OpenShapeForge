// SPDX-License-Identifier: BUSL-1.1
/**
 * The durable outbox end to end: a `mail.deliver` job enqueued under a tenant
 * session, drained by one worker batch through the null mail provider, and
 * administered through the `jobs.*` Operations on their REST and GraphQL
 * projections. Runs against the shared e2e database like every other suite
 * here; the rows it creates are its own and are removed in afterAll.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/rest/__tests__/jobs.e2e.test.ts 2>&1
 */
import { afterAll, beforeAll, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { withDbSession } from "../../db/session.js";
import { composeJobHandlers } from "../../jobs/handlers.js";
import { createNullMailProvider, type MailMessage } from "../../jobs/mail/provider.js";
import { createJobsRuntimeModule } from "../../jobs/module.js";
import { enqueueJob } from "../../jobs/store.js";
import { processJobBatch } from "../../jobs/worker.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { DEV_WORKER_ROLE_PASSWORD_DEFAULT, WORKER_ROLE } from "../../db/migrations/worker-role.js";
import {
  apiApp, describe, expectData, getRuntime, getSeedRuntime, registerSuiteLifecycle, remoteUrl, tenantA, tenantB, test,
  type Identity,
} from "../../graphql/__tests__/e2e/harness.js";

registerSuiteLifecycle();

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;
const MANAGE_ROLE = "Platform.Jobs.Manage";
const operator: Identity = { tenantId: tenantA.tenantId, userId: randomUUID(), roles: [MANAGE_ROLE] };
const otherTenant: Identity = { tenantId: tenantB.tenantId, userId: randomUUID(), roles: [MANAGE_ROLE] };
const noRole: Identity = { tenantId: tenantA.tenantId, userId: randomUUID(), roles: [] };
const subject = { entity: "Relation", id: randomUUID() };
const kind = "mail.deliver";

let app: Awaited<ReturnType<typeof apiApp>> | null = null;
let worker: DatabaseRuntime | null = null;

/** The worker's own connection, derived from the suite's URL the way .env.example does. */
function workerUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://openshapeforge_app:openshapeforge_app@localhost:5434/openshapeforge_dev");
  url.username = WORKER_ROLE;
  url.password = DEV_WORKER_ROLE_PASSWORD_DEFAULT;
  return url.toString();
}

beforeAll(async () => {
  app = await apiApp();
  worker = createDatabaseRuntime({ databaseUrl: workerUrl(), maxConnections: 2 });
});

afterAll(async () => {
  await sql`delete from platform.jobs where subject_id = ${subject.id}::uuid`.execute(getSeedRuntime().db);
  await worker?.close();
});

async function post(identity: Identity, url: string, payload: unknown): Promise<{ status: number; body: any }> {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  const body = JSON.stringify(payload);
  if (remoteUrl) {
    const response = await fetch(`${remoteUrl}${url}`, { method: "POST", headers, body });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }
  const response = await app!.inject({ method: "POST", url, headers: Object.fromEntries(headers.entries()), payload: body });
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

function enqueue(payload: Record<string, unknown>, deliveryKey?: string) {
  return withDbSession(getRuntime().db, operator, (trx) =>
    enqueueJob(trx, { tenantId: operator.tenantId, actorId: operator.userId, kind, payload, subject, ...(deliveryKey ? { deliveryKey } : {}) }));
}

describe("durable jobs end to end", () => {
  test("a mail job is enqueued, refused by the null provider as undelivered, and readable on REST and GraphQL", async () => {
    const sent: MailMessage[] = [];
    const module = createJobsRuntimeModule({ modules: () => [], mailProvider: createNullMailProvider({ sent, log: () => {} }) });
    const handlers = composeJobHandlers([module]);
    expect([...handlers.keys()]).toEqual([kind]);

    const key = `e2e-${randomUUID()}`;
    const good = await enqueue({ to: "someone@example.test", subject: "Your link", text: "Follow the link." }, key);
    expect((await enqueue({ to: "ignored@example.test", subject: "dup", text: "dup" }, key)).id).toBe(good.id);
    const bad = await enqueue({ to: "not-an-address", subject: "x", text: "y" });

    const queued = await post(operator, "/api/jobs/get", { id: good.id });
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({ id: good.id, kind, status: "queued", attempts: 0, subject, deliveryKey: key });

    const silent = { info() {}, warn() {}, error() {} };
    // Only this suite's kind, and both of its jobs: the shared database may
    // hold other suites' rows, which are not this test's to claim.
    await processJobBatch(worker!.db, handlers, silent, { kinds: [kind], batchSize: 50 });
    expect(sent.map((message) => message.to)).toEqual([["someone@example.test"]]);

    // The null provider logged the message and did not send it: never `done`.
    const undelivered = await post(operator, "/api/jobs/get", { id: good.id });
    expect(undelivered.body).toMatchObject({ status: "failed", attempts: 1, result: null, leaseUntil: null, lastError: { code: "MAIL_NOT_CONFIGURED" } });
    expect(undelivered.body.completedAt).not.toBeNull();

    const failed = await post(operator, "/api/jobs/get", { id: bad.id });
    expect(failed.body).toMatchObject({ status: "failed", lastError: { code: "MAIL_INVALID" } });

    const listed = await post(operator, "/api/jobs/list", { subject, status: "failed" });
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((job: { id: string }) => job.id).sort()).toEqual([bad.id, good.id].sort());
    expect(listed.body.nextCursor).toBeNull();

    const data = await expectData(operator, /* GraphQL */ `query Job($input: JSON!) { job(input: $input) }`, { input: { id: good.id } });
    expect(data.job).toMatchObject({ id: good.id, status: "failed" });
  });

  test("retry requeues a failed job, refuses a done one, and is fenced by tenant and role", async () => {
    const bad = await enqueue({ to: "still-not-an-address", subject: "x", text: "y" });
    const module = createJobsRuntimeModule({ modules: () => [], mailProvider: createNullMailProvider({ log: () => {} }) });
    await processJobBatch(worker!.db, composeJobHandlers([module]), { info() {}, warn() {}, error() {} }, { kinds: [kind], batchSize: 50 });
    expect((await post(operator, "/api/jobs/get", { id: bad.id })).body.status).toBe("failed");

    expect((await post(noRole, "/api/jobs/retry", { id: bad.id })).status).toBe(403);
    expect((await post(otherTenant, "/api/jobs/retry", { id: bad.id })).status).toBe(404);
    const retried = await post(operator, "/api/jobs/retry", { id: bad.id });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ id: bad.id, status: "queued", attempts: 0 });
    const conflict = await post(operator, "/api/jobs/retry", { id: bad.id });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("CONFLICT");
    expect((await post(operator, "/api/jobs/retry", { id: randomUUID() })).status).toBe(404);
  });
});
