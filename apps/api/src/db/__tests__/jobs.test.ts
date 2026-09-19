// SPDX-License-Identifier: BUSL-1.1
/**
 * platform.jobs — the durable outbox — proved against a real database under
 * the two roles that reach it: `openshapeforge_app` inside a tenant session
 * (enqueue, list, retry) and `openshapeforge_worker` under the job-worker
 * session (claim, settle, sweep). Every visibility assertion is a raw count
 * with no app-layer WHERE, as in worker-role-rls.test.ts.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/jobs.test.ts 2>&1
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely, type Transaction } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { withDbSession } from "../session.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { DEV_WORKER_ROLE_PASSWORD_DEFAULT, WORKER_ROLE } from "../migrations/worker-role.js";
import { composeJobHandlers } from "../../jobs/handlers.js";
import { jobsOperationHandler } from "../../jobs/operations.js";
import { getJob, listJobs, resolveJob, sweepDoneJobs } from "../../jobs/queries.js";
import { claimJobs, enqueueJob, lockClaimedJob, settleJob, type ClaimedJob } from "../../jobs/store.js";
import { JOB_WORKER_ROLE, processJobBatch, runClaimedJob, withJobWorkerSession } from "../../jobs/worker.js";
import type { ModuleJobHandler, ModuleOperationContext, ModuleWorkerLogger } from "../../modules/contract.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 90_000;
const MANAGE_ROLE = "Platform.Jobs.Manage";

function scratchUrl(name: string, role?: { user: string; pass: string }): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") throw new Error("admin URL must not point at openshapeforge_dev");
  url.pathname = `/${name}`;
  if (role) {
    url.username = role.user;
    url.password = role.pass;
  }
  return url.toString();
}

const silent: ModuleWorkerLogger = { info() {}, warn() {}, error() {} };

type Suite = { admin: SQL; name: string; root: DatabaseRuntime; app: DatabaseRuntime; worker: DatabaseRuntime };
let suite: Suite;

const tenantA = randomUUID();
const tenantB = randomUUID();
const actor = randomUUID();
const sessionA = { tenantId: tenantA, userId: actor, roles: [MANAGE_ROLE] };
const sessionB = { tenantId: tenantB, userId: actor, roles: [MANAGE_ROLE] };

function appSession<T>(session: typeof sessionA, fn: (trx: Transaction<DB>) => Promise<T>) {
  return withDbSession<DB, T>(suite.app.db as Kysely<DB>, session, (trx) => fn(trx));
}

async function enqueue(session: typeof sessionA, kind: string, extra: Partial<Parameters<typeof enqueueJob>[1]> = {}) {
  return appSession(session, (trx) => enqueueJob(trx, { tenantId: session.tenantId, actorId: session.userId, kind, payload: { n: 1 }, ...extra }));
}

async function claim(limit = 10, kinds?: string[], leaseSeconds = 60) {
  return withJobWorkerSession(suite.worker.db, (trx) => claimJobs(trx, { limit, leaseSeconds, ...(kinds ? { kinds } : {}) }));
}

/** Backdate a lease as the privileged role, which is what a dead worker leaves behind. */
async function expireLease(id: string) {
  await sql`update platform.jobs set lease_until = now() - interval '1 second' where id = ${id}::uuid`.execute(suite.root.db);
}

async function rawStatus(id: string) {
  const row = await sql<{ status: string; attempts: number; lease_until: Date | null; claim_token_hash: string | null; completed_at: Date | null }>`
    select status, attempts, lease_until, claim_token_hash, completed_at from platform.jobs where id = ${id}::uuid
  `.execute(suite.root.db);
  return row.rows[0]!;
}

beforeAll(async () => {
  const name = `jobs_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${name}"`);
  const root = createDatabaseRuntime({ databaseUrl: scratchUrl(name), maxConnections: 2 });
  await root.db.connection().execute((conn) => runMigrationChain(conn));
  suite = {
    admin,
    name,
    root,
    app: createDatabaseRuntime({ databaseUrl: scratchUrl(name, { user: APP_ROLE, pass: "openshapeforge_app" }), maxConnections: 4 }),
    worker: createDatabaseRuntime({ databaseUrl: scratchUrl(name, { user: WORKER_ROLE, pass: DEV_WORKER_ROLE_PASSWORD_DEFAULT }), maxConnections: 8 }),
  };
}, TEST_TIMEOUT);

afterAll(async () => {
  await suite.app.close();
  await suite.worker.close();
  await suite.root.close();
  await suite.admin.unsafe(`drop database if exists "${suite.name}" with (force)`);
  await suite.admin.close();
});

describe("platform.jobs", () => {
  test("the manifest names the same worker role the worker presents", () => {
    const table = manifest.tables.find((entry) => entry.schema === "platform" && entry.table === "jobs") as { workerAccess?: string } | undefined;
    expect(table?.workerAccess).toBe(JOB_WORKER_ROLE);
  });

  test("enqueue is idempotent per tenant and kind on the delivery key", async () => {
    const first = await enqueue(sessionA, "test.keyed", { deliveryKey: "k1" });
    const again = await enqueue(sessionA, "test.keyed", { deliveryKey: "k1", payload: { n: 2 } });
    const other = await enqueue(sessionB, "test.keyed", { deliveryKey: "k1" });
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false, status: "queued" });
    expect(other.created).toBe(true);
    expect(other.id).not.toBe(first.id);
    await expect(enqueue(sessionA, "NotNamespaced")).rejects.toThrow(/namespaced/);
  });

  test("a tenant session sees only its own jobs; the worker session sees every tenant's", async () => {
    const a = await enqueue(sessionA, "test.visible");
    await enqueue(sessionB, "test.visible");
    const fromB = await appSession(sessionB, (trx) => getJob(trx, a.id));
    expect(fromB).toBeUndefined();
    const listedA = await appSession(sessionA, (trx) => listJobs(trx, { kind: "test.visible", limit: 10 }));
    expect(listedA.items.map((job) => job.tenantId)).toEqual([tenantA]);

    const workerCount = await withJobWorkerSession(suite.worker.db, async (trx) =>
      (await sql<{ n: string }>`select count(*)::text as n from platform.jobs where kind = 'test.visible'`.execute(trx)).rows[0]!.n);
    expect(workerCount).toBe("2");

    // The app role naming the worker GUC by hand is not a worker: the policy
    // compares current_user, which a session cannot change.
    const impostor = await suite.app.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.worker_role', ${JOB_WORKER_ROLE}, true)`.execute(trx);
      return (await sql<{ n: string }>`select count(*)::text as n from platform.jobs`.execute(trx)).rows[0]!.n;
    });
    expect(impostor).toBe("0");
  });

  test("concurrent claims hand each job to exactly one claimer", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 6; i += 1) ids.add((await enqueue(sessionA, "test.race")).id);
    const claims = await Promise.all([claim(10, ["test.race"]), claim(10, ["test.race"]), claim(10, ["test.race"])]);
    const seen = claims.flat().map((job) => job.id);
    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toEqual(ids);
    for (const job of claims.flat()) {
      expect(job.status).toBe("running");
      expect(job.attempts).toBe(1);
      expect(job.claimToken).toHaveLength(64);
      expect(job.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
    }
    expect(await claim(10, ["test.race"])).toEqual([]);
  });

  test("settle: done stores the result, a stale token is refused, retry backs off and dead-letters at the bound", async () => {
    const { id } = await enqueue(sessionA, "test.settle", { maxAttempts: 2 });
    const [first] = await claim(1, ["test.settle"]);
    const retry = await withJobWorkerSession(suite.worker.db, (trx) =>
      settleJob(trx, { id, claimToken: first!.claimToken, outcome: "retry", error: { message: "boom" } }));
    expect(retry).toEqual({ settled: true, status: "queued" });
    const queued = await rawStatus(id);
    expect(queued.attempts).toBe(1);
    expect(queued.claim_token_hash).toBeNull();
    const backoff = await appSession(sessionA, (trx) => getJob(trx, id));
    expect(backoff!.availableAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(backoff!.lastError).toEqual({ message: "boom" });
    // Not due yet, so a claim leaves it alone; pull it forward to run again.
    expect(await claim(10, ["test.settle"])).toEqual([]);
    await sql`update platform.jobs set available_at = now() where id = ${id}::uuid`.execute(suite.root.db);
    const [second] = await claim(1, ["test.settle"]);
    expect(second!.attempts).toBe(2);
    const stale = await withJobWorkerSession(suite.worker.db, (trx) =>
      settleJob(trx, { id, claimToken: first!.claimToken, outcome: "done" }));
    expect(stale).toEqual({ settled: false });
    const dead = await withJobWorkerSession(suite.worker.db, (trx) =>
      settleJob(trx, { id, claimToken: second!.claimToken, outcome: "retry", error: { message: "boom again" } }));
    expect(dead).toEqual({ settled: true, status: "dead" });
    expect((await rawStatus(id)).completed_at).not.toBeNull();

    const { id: done } = await enqueue(sessionA, "test.settle-done");
    const [claimed] = await claim(1, ["test.settle-done"]);
    await withJobWorkerSession(suite.worker.db, (trx) =>
      settleJob(trx, { id: done, claimToken: claimed!.claimToken, outcome: "done", result: { ok: true } }));
    const finished = await appSession(sessionA, (trx) => getJob(trx, done));
    expect(finished!.status).toBe("done");
    expect(finished!.result).toEqual({ ok: true });
    expect(finished!.completedAt).not.toBeNull();
    expect(finished!.leaseUntil).toBeNull();
  });

  test("an expired lease is reclaimed by the next claim, and closed dead at the attempt bound", async () => {
    const { id } = await enqueue(sessionA, "test.lease", { maxAttempts: 2 });
    const [first] = await claim(1, ["test.lease"]);
    expect(await claim(1, ["test.lease"])).toEqual([]); // fresh lease: left alone
    await expireLease(id);
    const [second] = await claim(1, ["test.lease"]);
    expect(second?.id).toBe(id);
    expect(second!.attempts).toBe(2);
    expect(second!.claimToken).not.toBe(first!.claimToken);
    await expireLease(id);
    expect(await claim(1, ["test.lease"])).toEqual([]);
    const closed = await appSession(sessionA, (trx) => getJob(trx, id));
    expect(closed!.status).toBe("dead");
    expect(closed!.lastError?.code).toBe("LEASE_EXPIRED");
  });

  test("outcome_unknown is terminal until an operator resolves it", async () => {
    const { id } = await enqueue(sessionA, "test.unknown");
    const [claimed] = await claim(1, ["test.unknown"]);
    await withJobWorkerSession(suite.worker.db, (trx) =>
      settleJob(trx, { id, claimToken: claimed!.claimToken, outcome: "outcome_unknown", error: { message: "timed out after DATA" } }));
    expect((await rawStatus(id)).status).toBe("outcome_unknown");
    expect(await claim(10, ["test.unknown"])).toEqual([]);
    // Terminal rows hold no lease; the shape check refuses one being put back.
    await expect(expireLease(id)).rejects.toThrow(/jobs_status_shape/);

    const requeued = await appSession(sessionA, (trx) => resolveJob(trx, { id, action: "requeue" }));
    expect(requeued?.status).toBe("queued");
    expect(requeued?.attempts).toBe(0);
    const [again] = await claim(1, ["test.unknown"]);
    expect(again?.id).toBe(id);
    // A running job is not resolvable.
    expect(await appSession(sessionA, (trx) => resolveJob(trx, { id, action: "done" }))).toBeUndefined();
  });

  test("processJobBatch replays the enqueuing session for the handler and settles every outcome", async () => {
    const seen: string[] = [];
    const guc = async (db: Transaction<DB>, name: string) =>
      (await sql<{ v: string }>`select coalesce(current_setting(${name}, true), '') as v`.execute(db)).rows[0]!.v;
    const handlers = composeJobHandlers([
      {
        name: "probe",
        jobHandlers: {
          "probe.ok": (async (payload, { db, job }) => {
            const tenant = (await sql<{ t: string }>`select app.current_tenant()::text as t`.execute(db)).rows[0]!.t;
            seen.push(`${job.kind}:${tenant}:${JSON.stringify(payload)}`);
            seen.push(`roles=${await guc(db, "app.roles")} worker=${await guc(db, "app.worker_role")} scope=${await guc(db, "app.scope")} relation_groups=${await guc(db, "app.relation_group_ids")}`);
            return { outcome: "done", result: { echoed: payload } };
          }) as ModuleJobHandler,
          "probe.throws": (async () => { throw new Error("handler exploded"); }) as ModuleJobHandler,
          "probe.unknown": (async () => ({ outcome: "outcome_unknown", error: { message: "maybe sent" } })) as ModuleJobHandler,
          "probe.malformed": (async () => ({ outcome: "retry" })) as unknown as ModuleJobHandler,
          "probe.after": (async () => ({ outcome: "done" })) as ModuleJobHandler,
        },
      },
    ]);
    const relationGroup = randomUUID();
    const ok = await enqueue(sessionA, "probe.ok", {
      payload: { hello: "world" },
      actorSession: { roles: ["Zebra.Role", "Alpha.Role"], relationGroupIds: [relationGroup], scope: "tenant" },
    });
    const throws = await enqueue(sessionB, "probe.throws");
    const unknown = await enqueue(sessionA, "probe.unknown");
    const orphan = await enqueue(sessionA, "probe.nobody");
    // A malformed outcome is that job's failure, not the batch's: the job after it still runs.
    const malformed = await enqueue(sessionA, "probe.malformed");
    const after = await enqueue(sessionA, "probe.after");
    const kinds = ["probe.ok", "probe.throws", "probe.unknown", "probe.nobody", "probe.malformed", "probe.after"];
    expect(await processJobBatch(suite.worker.db, handlers, silent, { kinds })).toEqual({ processed: 6 });
    expect(seen).toEqual([
      `probe.ok:${tenantA}:{"hello":"world"}`,
      `roles=Alpha.Role,Zebra.Role worker=${JOB_WORKER_ROLE} scope=tenant relation_groups=${relationGroup}`,
    ]);
    const finished = (await appSession(sessionA, (trx) => getJob(trx, ok.id)))!;
    expect(finished.result).toEqual({ echoed: { hello: "world" } });
    expect(finished.actorSession).toEqual({ roles: ["Alpha.Role", "Zebra.Role"], groups: [], relationGroupIds: [relationGroup], scope: "tenant" });
    const retried = await rawStatus(throws.id);
    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(1);
    expect((await rawStatus(unknown.id)).status).toBe("outcome_unknown");
    const dead = await appSession(sessionA, (trx) => getJob(trx, orphan.id));
    expect(dead!.status).toBe("dead");
    expect(dead!.lastError?.code).toBe("NO_HANDLER");
    const invalid = await appSession(sessionA, (trx) => getJob(trx, malformed.id));
    expect(invalid!.status).toBe("failed");
    expect(invalid!.lastError?.code).toBe("INVALID_OUTCOME");
    expect((await rawStatus(after.id)).status).toBe("done");
    // The enqueuing session is stored as it was, and the least session is the default.
    expect((await appSession(sessionA, (trx) => getJob(trx, after.id)))!.actorSession).toEqual({ roles: [], groups: [], relationGroupIds: [], scope: "self" });
    await expect(enqueue(sessionA, "probe.ok", { actorSession: { scope: "everything" as "self" } })).rejects.toThrow(/scope/);
  });

  test("a running handler holds its job row, and a claim that was reclaimed stops before any effect", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let runs = 0;
    const handlers = composeJobHandlers([{
      name: "lease",
      jobHandlers: {
        "lease.slow": (async () => { runs += 1; started(); await held; return { outcome: "done" }; }) as ModuleJobHandler,
      },
    }]);
    const { id } = await enqueue(sessionA, "lease.slow", { maxAttempts: 5 });
    // A lease of ten milliseconds: expired long before the handler lets go.
    const [job] = await claim(1, ["lease.slow"], 0.01);
    const run = runClaimedJob(suite.worker.db, job!, handlers, silent);
    await running;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The lease has expired on paper, but the row is locked by the run: skip locked leaves it alone.
    expect(await claim(1, ["lease.slow"])).toEqual([]);
    release();
    expect(await run).toMatchObject({ ran: true, result: { settled: true, status: "done" } });
    expect(runs).toBe(1);
    expect((await rawStatus(id)).status).toBe("done");

    // Reclaimed before the run began: the stale claim matches nothing and the handler never runs.
    const second = await enqueue(sessionA, "lease.slow");
    const [stale] = await claim(1, ["lease.slow"]);
    await expireLease(second.id);
    const [fresh] = await claim(1, ["lease.slow"]);
    expect(fresh?.id).toBe(second.id);
    const locked = await withJobWorkerSession(suite.worker.db, (trx) => lockClaimedJob(trx, stale!));
    expect(locked).toBe(false);
    expect(await runClaimedJob(suite.worker.db, stale!, handlers, silent)).toEqual({ ran: false });
    expect(runs).toBe(1);
    expect((await rawStatus(second.id)).status).toBe("running");
    expect(await withJobWorkerSession(suite.worker.db, (trx) => lockClaimedJob(trx, fresh!))).toBe(true);
  });

  test("a stopping worker finishes the job in hand and claims no other", async () => {
    let stop = false;
    const handlers = composeJobHandlers([{
      name: "stop",
      jobHandlers: { "stop.job": (async () => { stop = true; return { outcome: "done" }; }) as ModuleJobHandler },
    }]);
    const first = await enqueue(sessionA, "stop.job");
    const second = await enqueue(sessionA, "stop.job");
    expect(await processJobBatch(suite.worker.db, handlers, silent, { kinds: ["stop.job"], batchSize: 10 }, () => stop)).toEqual({ processed: 1 });
    expect((await rawStatus(first.id)).status).toBe("done");
    expect((await rawStatus(second.id)).status).toBe("queued");
  });

  test("two modules registering one kind fail composition", () => {
    const handler: ModuleJobHandler = async () => undefined;
    expect(() => composeJobHandlers([
      { name: "one", jobHandlers: { "shared.kind": handler } },
      { name: "two", jobHandlers: { "shared.kind": handler } },
    ])).toThrow(/"shared.kind" is registered by both "one" and "two"/);
    expect(() => composeJobHandlers([{ name: "one", jobHandlers: { flat: handler } }])).toThrow(/namespaced/);
  });

  test("the sweep removes done jobs past retention and nothing else", async () => {
    const old = await enqueue(sessionA, "test.sweep");
    const recent = await enqueue(sessionA, "test.sweep");
    const failed = await enqueue(sessionA, "test.sweep");
    for (const job of await claim(3, ["test.sweep"])) {
      await withJobWorkerSession(suite.worker.db, (trx) =>
        settleJob(trx, job.id === failed.id
          ? { id: job.id, claimToken: job.claimToken, outcome: "failed", error: { message: "no" } }
          : { id: job.id, claimToken: job.claimToken, outcome: "done" }));
    }
    await sql`update platform.jobs set completed_at = now() - interval '40 days' where id in (${old.id}::uuid, ${failed.id}::uuid)`.execute(suite.root.db);
    expect(await withJobWorkerSession(suite.worker.db, (trx) => sweepDoneJobs(trx, 30))).toBe(1);
    expect(await appSession(sessionA, (trx) => getJob(trx, old.id))).toBeUndefined();
    expect((await appSession(sessionA, (trx) => getJob(trx, recent.id)))?.status).toBe("done");
    expect((await appSession(sessionA, (trx) => getJob(trx, failed.id)))?.status).toBe("failed");
  });

  test("the jobs.* Operations read and retry inside the caller's tenant", async () => {
    const context = (session: typeof sessionA) => ({ db: suite.app.db, session, transport: "operation" } as unknown as ModuleOperationContext);
    const list = jobsOperationHandler({ key: "jobs.list", handler: "list" });
    const get = jobsOperationHandler({ key: "jobs.get", handler: "get" });
    const retry = jobsOperationHandler({ key: "jobs.retry", handler: "retry" });
    const subject = { entity: "Relation", id: randomUUID() };
    const { id } = await enqueue(sessionA, "test.ops", { subject });
    const [claimed] = await claim(1, ["test.ops"]);
    await withJobWorkerSession(suite.worker.db, (trx) =>
      settleJob(trx, { id, claimToken: (claimed as ClaimedJob).claimToken, outcome: "failed", error: { message: "nope", code: "X" } }));

    const listed = await list({ subject, limit: 5 }, context(sessionA)) as { value: { items: { id: string; status: string }[] } };
    expect(listed.value.items.map((job) => [job.id, job.status])).toEqual([[id, "failed"]]);
    expect(await list({ status: "bogus" }, context(sessionA))).toMatchObject({ ok: false, status: 400 });
    expect(await get({ id }, context(sessionB))).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND" });
    const got = await get({ id }, context(sessionA)) as { value: Record<string, unknown> };
    expect(got.value).toMatchObject({ id, status: "failed", subject, lastError: { message: "nope", code: "X" } });
    expect(Object.keys(got.value)).not.toContain("payload");

    expect(await retry({ id }, context(sessionB))).toMatchObject({ ok: false, status: 404 });
    const retried = await retry({ id }, context(sessionA)) as { value: { status: string; attempts: number } };
    expect(retried.value).toMatchObject({ status: "queued", attempts: 0 });
    expect(await retry({ id }, context(sessionA))).toMatchObject({ ok: false, status: 409, code: "CONFLICT" });
  });
});
