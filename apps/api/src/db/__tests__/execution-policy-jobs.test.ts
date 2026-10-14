// SPDX-License-Identifier: BUSL-1.1
/**
 * The background half of the host execution admission guard, against a real
 * database and a real queue.
 *
 * A queued job is the one execution path whose authorization is older than
 * its effects: it was admitted when someone enqueued it and it runs whenever
 * a worker gets to it. So this file proves, with the deployed worker role
 * rather than an API executor standing in for it:
 *
 *  - `startWorkerRole` registers the contributed policies on the connection
 *    IT creates, so a governed run is decided at all;
 *  - a job enqueued while the tenant could write is refused when the worker
 *    reaches it after the tenant's deadline — before the handler writes a row
 *    and before it reaches an external provider (a spy here, and the core
 *    `mail.deliver` transport);
 *  - the refusal is a KNOWN settlement: requeued for the moment the refusal
 *    names, with the attempt it never made given back, or terminally failed
 *    when the refusal names no end. Never `outcome_unknown`;
 *  - a policy that writes and then fails rolls back to its own savepoint and
 *    leaves the queue's own bookkeeping — the settlement of that very job —
 *    committed;
 *  - a module configured to contribute a policy that fails to initialise
 *    stops the worker from starting at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import type { ModuleExecutionPolicy, ModuleWorkerLogger, RuntimeModule } from "../../modules/contract.js";
import { composeJobHandlers } from "../../jobs/handlers.js";
import { createJobsRuntimeModule } from "../../jobs/module.js";
import { enqueueJob } from "../../jobs/store.js";
import { processJobBatch, refusedJobSettlement } from "../../jobs/worker.js";
import type { MailMessage, MailProvider } from "../../jobs/mail/provider.js";
import { registerOperationExecutionPolicies } from "../../operations/execution-policy.js";
import { startWorkerRole } from "../../roles/worker.js";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";
import { withDbSession } from "../session.js";
import { APP_ROLE } from "../migrations/app-role.js";
import { WORKER_ROLE } from "../migrations/worker-role.js";
import { ensureScratchDatabaseRoles } from "./__fixtures__/scratch-roles.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const SCRATCH = `execution_policy_jobs_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const TEST_TIMEOUT = 180_000;
const TENANT = randomUUID();
const ACTOR = randomUUID();
const WRITE_ROLES = ["Relations.All.ReadWrite", "Relations.All.Read"];
const WRITING_KIND = "example.write-relation";

let passwords = { app: "", worker: "" };

function databaseUrl(role?: "app" | "worker"): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH}`;
  if (role === "app") {
    url.username = APP_ROLE;
    url.password = passwords.app;
  }
  if (role === "worker") {
    url.username = WORKER_ROLE;
    url.password = passwords.worker;
  }
  return url.toString();
}

const silent: ModuleWorkerLogger = { info() {}, warn() {}, error() {} };

/** What the handler did, and what reached the outside world. */
const written: string[] = [];
const dispatched: string[] = [];
const sentMail: MailMessage[] = [];

const spyMailProvider: MailProvider = {
  name: "spy",
  send: async (message) => {
    sentMail.push(message);
    return { providerMessageId: `spy-${sentMail.length}` };
  },
};

/**
 * The host need as a policy, reading the server's own persisted deadline
 * through the transaction core hands it. `retryAt` is what makes the queue
 * come back for the job instead of closing it.
 */
function deadlinePolicy(options: { retryAt?: string } = {}): ModuleExecutionPolicy {
  return {
    name: "tenant-write-deadline",
    evaluate: async (_request, context) => {
      const rows = await sql<{ writes_until: Date }>`
        select writes_until from public.execution_policy_deadline
      `.execute(context.db);
      const deadline = rows.rows[0];
      if (!deadline || new Date() < new Date(deadline.writes_until)) return { admitted: true };
      return {
        admitted: false,
        refusal: {
          message: "This workspace is read-only.",
          detail: "Its write period ended; everything stays readable.",
          ...(options.retryAt ? { retryAt: options.retryAt } : {}),
        },
      };
    },
  };
}

/** A module whose job handler both writes tenant data and dispatches outward. */
function exampleModule(policies: readonly ModuleExecutionPolicy[]): RuntimeModule {
  return {
    name: "execution-policy-jobs-example",
    executionPolicies: [...policies],
    jobHandlers: {
      [WRITING_KIND]: async (payload, context) => {
        await sql`insert into public.execution_policy_job_writes (tenant_id, note)
          values (${context.job.tenantId}::uuid, ${String(payload.displayName)})`
          .execute(context.db);
        written.push(String(payload.displayName));
        // Stands in for a provider call: what must never happen after a
        // refusal, and what cannot be undone by a rollback.
        dispatched.push(String(payload.displayName));
        return undefined;
      },
    },
  } as RuntimeModule;
}

let admin: SQL | undefined;
let created = false;
let privileged: DatabaseRuntime | undefined;
let app: DatabaseRuntime | undefined;
let worker: DatabaseRuntime | undefined;

type JobRow = {
  status: string;
  attempts: number;
  available_at: Date;
  /** The queue stores it as JSONB; the driver hands it back as text. */
  last_error: { code?: string; message?: string; detail?: unknown } | null;
  claim_token_hash: string | null;
};

async function jobRow(id: string): Promise<JobRow> {
  const rows = await sql<JobRow & { last_error: string | null }>`
    select status, attempts, available_at, last_error, claim_token_hash
    from platform.jobs where id = ${id}::uuid
  `.execute(privileged!.db);
  const row = rows.rows[0]!;
  return {
    ...row,
    last_error: typeof row.last_error === "string" ? JSON.parse(row.last_error) : row.last_error,
  };
}

async function enqueue(kind: string, payload: Record<string, unknown>): Promise<string> {
  const session = { tenantId: TENANT, userId: ACTOR, roles: WRITE_ROLES, scope: "tenant" as const };
  const { id } = await withDbSession(app!.db, session, (trx) =>
    enqueueJob(trx, {
      tenantId: TENANT,
      actorId: ACTOR,
      actorSession: { roles: WRITE_ROLES, groups: [], relationGroupIds: [], scope: "tenant" },
      kind,
      payload,
    }));
  return id;
}

async function writtenRowCount(): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count from public.execution_policy_job_writes
    where tenant_id = ${TENANT}::uuid
  `.execute(privileged!.db);
  return Number(rows.rows[0]!.count);
}

/** Open or close the tenant's write window at the persisted row. */
async function writesUntil(instant: string): Promise<void> {
  await sql`
    insert into public.execution_policy_deadline (tenant_id, writes_until)
    values (${TENANT}::uuid, ${instant}::timestamptz)
    on conflict (tenant_id) do update set writes_until = excluded.writes_until
  `.execute(privileged!.db);
}

describe("the refusal settlement", () => {
  const claimed = { id: randomUUID(), claimToken: "token", attempts: 3 } as never;
  const refusal = { code: "EXECUTION_NOT_PERMITTED", message: "This workspace is read-only." };

  test("a refusal that names its end requeues the job for exactly then", () => {
    const retryAt = "2026-10-20T00:00:00.000Z";
    expect(refusedJobSettlement(claimed, { ...refusal, retryable: true, retryAt })).toMatchObject({
      outcome: "not_admitted",
      retryAt: new Date(retryAt),
    });
  });

  test("a retryable refusal with no named end comes back on the ordinary backoff", () => {
    const now = Date.parse("2026-10-14T09:00:00.000Z");
    const settlement = refusedJobSettlement(claimed, { ...refusal, retryable: true }, now);
    expect(settlement.outcome).toBe("not_admitted");
    expect((settlement as { retryAt: Date }).retryAt.getTime()).toBeGreaterThan(now);
  });

  test("an open-ended refusal is terminal rather than an endless requeue", () => {
    expect(refusedJobSettlement(claimed, { ...refusal, retryable: false })).toMatchObject({
      outcome: "failed",
      error: { code: "EXECUTION_NOT_PERMITTED" },
    });
  });
});

describe("host execution policies on the job worker", () => {
  beforeAll(async () => {
    admin = new SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`create database "${SCRATCH}"`);
    created = true;
    privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 4 });
    passwords = await ensureScratchDatabaseRoles(privileged.db);
    await privileged.db.connection().execute((trx) => runMigrationChain(trx));
    await sql`insert into platform.tenants (id, slug, name, status)
      values (${TENANT}::uuid, ${TENANT}, ${TENANT}, 'active')`.execute(privileged.db);
    await sql`
      create table public.execution_policy_deadline (
        tenant_id uuid primary key,
        writes_until timestamptz not null
      )
    `.execute(privileged.db);
    await sql`alter table public.execution_policy_deadline enable row level security`.execute(privileged.db);
    await sql`alter table public.execution_policy_deadline force row level security`.execute(privileged.db);
    await sql`create policy tenant on public.execution_policy_deadline
      using (tenant_id = app.current_tenant())`.execute(privileged.db);
    // What the module's job handler writes: tenant-scoped like any entity
    // table, and reachable by the worker's own role.
    await sql`
      create table public.execution_policy_job_writes (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null,
        note text not null
      )
    `.execute(privileged.db);
    await sql`alter table public.execution_policy_job_writes enable row level security`.execute(privileged.db);
    await sql`alter table public.execution_policy_job_writes force row level security`.execute(privileged.db);
    await sql`create policy tenant on public.execution_policy_job_writes
      using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant())`
      .execute(privileged.db);
    for (const role of [APP_ROLE, WORKER_ROLE]) {
      await sql`grant select on public.execution_policy_deadline to ${sql.id(role)}`.execute(privileged.db);
      await sql`grant select, insert on public.execution_policy_job_writes to ${sql.id(role)}`
        .execute(privileged.db);
    }
    app = createDatabaseRuntime({ databaseUrl: databaseUrl("app"), maxConnections: 4 });
    worker = createDatabaseRuntime({ databaseUrl: databaseUrl("worker"), maxConnections: 4 });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await app?.close();
    await worker?.close();
    await privileged?.close();
    if (created) await admin?.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin?.close();
  });

  beforeEach(async () => {
    written.length = 0;
    dispatched.length = 0;
    sentMail.length = 0;
    await sql`delete from platform.jobs`.execute(privileged!.db);
    await sql`delete from public.execution_policy_job_writes`.execute(privileged!.db);
    await writesUntil("2099-01-01T00:00:00Z");
  });

  /**
   * The deployed worker: its own process, its own connection, its own module
   * initialisation. Nothing here hands it a registry — `startWorkerRole` is
   * what must register the policies on the connection it creates.
   */
  async function withWorkerRole(
    module: RuntimeModule,
    run: () => Promise<void>,
  ): Promise<void> {
    const handle = await startWorkerRole("job-worker", {
      databaseUrl: databaseUrl("worker"),
      modules: { loaded: [module], failures: [] },
      env: {
        NODE_ENV: "development",
        OPENSHAPEFORGE_MAIL_PROVIDER: "null",
        OPENSHAPEFORGE_JOBS_POLL_INTERVAL_MS: "25",
      },
      log: silent,
    });
    try {
      await run();
    } finally {
      await handle.stop();
    }
  }

  /**
   * Wait for the worker to report back: the claim released and either a
   * terminal status or a recorded error. A refusal requeues the job, so
   * `queued` alone is not settled — `queued` with the refusal is.
   */
  async function settledStatus(id: string, timeoutMs = 15_000): Promise<JobRow> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await jobRow(id);
      const reported = row.status !== "queued" || row.last_error !== null;
      if (row.status !== "running" && row.claim_token_hash === null && reported) return row;
      if (Date.now() > deadline) throw new Error(`Job ${id} never settled; last status ${row.status}.`);
      await Bun.sleep(25);
    }
  }

  test("the running worker drains a governed job while the tenant may write", async () => {
    await withWorkerRole(exampleModule([deadlinePolicy()]), async () => {
      const id = await enqueue(WRITING_KIND, { displayName: "Within the window" });
      expect(await settledStatus(id)).toMatchObject({ status: "done", attempts: 1 });
    });
    expect(written).toEqual(["Within the window"]);
    expect(await writtenRowCount()).toBe(1);
  }, TEST_TIMEOUT);

  test("refuses the job the tenant was still allowed to enqueue, before any effect", async () => {
    const retryAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    await withWorkerRole(exampleModule([deadlinePolicy({ retryAt })]), async () => {
      // Enqueued while the tenant could write; the deadline passes before a
      // worker reaches the job, which is the whole case.
      await writesUntil("2026-01-01T00:00:00Z");
      const id = await enqueue(WRITING_KIND, { displayName: "After the deadline" });
      const row = await settledStatus(id);
      // Queued again for the moment the refusal names, with the attempt it
      // never made given back — not `outcome_unknown`, not `dead`.
      expect(row.status).toBe("queued");
      expect(row.attempts).toBe(0);
      expect(row.last_error).toMatchObject({ code: "EXECUTION_NOT_PERMITTED" });
      expect(row.available_at.toISOString()).toBe(retryAt);
    });
    expect(written).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(await writtenRowCount()).toBe(0);
  }, TEST_TIMEOUT);

  test("a refusal that names no end closes the job as failed rather than uncertain", async () => {
    await withWorkerRole(exampleModule([deadlinePolicy()]), async () => {
      await writesUntil("2026-01-01T00:00:00Z");
      const id = await enqueue(WRITING_KIND, { displayName: "Open-ended refusal" });
      const row = await settledStatus(id);
      expect(row.status).toBe("failed");
      expect(row.last_error).toMatchObject({
        code: "EXECUTION_NOT_PERMITTED",
        message: "This workspace is read-only.",
      });
    });
    expect(written).toEqual([]);
    expect(dispatched).toEqual([]);
  }, TEST_TIMEOUT);

  test("a worker with no contributed policy drains the same job unchanged", async () => {
    await withWorkerRole(exampleModule([]), async () => {
      await writesUntil("2026-01-01T00:00:00Z");
      const id = await enqueue(WRITING_KIND, { displayName: "Ungoverned host" });
      expect(await settledStatus(id)).toMatchObject({ status: "done" });
    });
    expect(written).toEqual(["Ungoverned host"]);
  }, TEST_TIMEOUT);

  test("refuses core mail delivery before the transport is asked to send", async () => {
    // The core job kind, its real handler, and a provider that records every
    // call: an external effect must not happen after a refusal.
    const module = exampleModule([deadlinePolicy()]);
    registerOperationExecutionPolicies(worker!.db, [module]);
    const handlers = composeJobHandlers([
      createJobsRuntimeModule({ modules: () => [], mailProvider: spyMailProvider }),
    ]);
    const payload = { to: "someone@example.test", subject: "Hello", text: "Body" };

    const admitted = await enqueue("mail.deliver", payload);
    expect(await processJobBatch(worker!.db, handlers, silent)).toEqual({ processed: 1 });
    expect(await jobRow(admitted)).toMatchObject({ status: "done" });
    expect(sentMail).toHaveLength(1);

    await writesUntil("2026-01-01T00:00:00Z");
    const refused = await enqueue("mail.deliver", payload);
    expect(await processJobBatch(worker!.db, handlers, silent)).toEqual({ processed: 1 });
    expect(await jobRow(refused)).toMatchObject({
      status: "failed",
      last_error: { code: "EXECUTION_NOT_PERMITTED" },
    });
    expect(sentMail).toHaveLength(1);
    registerOperationExecutionPolicies(worker!.db, []);
  }, TEST_TIMEOUT);

  test("a policy that writes and then fails leaves the queue's own settlement committed", async () => {
    const writeThenThrow: ModuleExecutionPolicy = {
      name: "writes-then-throws",
      evaluate: async (_request, context) => {
        await sql`insert into public.execution_policy_job_writes (tenant_id, note)
          values (${context.session.tenantId}::uuid, 'Policy row')`
          .execute(context.db).catch(() => undefined);
        await sql`select * from public.table_that_does_not_exist`.execute(context.db);
        return { admitted: true };
      },
    };
    const module = exampleModule([writeThenThrow]);
    registerOperationExecutionPolicies(worker!.db, [module]);
    const handlers = composeJobHandlers([module]);
    const id = await enqueue(WRITING_KIND, { displayName: "Never written" });
    expect(await processJobBatch(worker!.db, handlers, silent)).toEqual({ processed: 1 });
    const row = await jobRow(id);
    // The settlement is the queue's own bookkeeping, written in the very
    // transaction the policy's statement poisoned: it survives, which it
    // could not if the decision had not been rolled back to its savepoint.
    // A policy that cannot answer is not retryable, so the run is closed
    // `failed` rather than requeued — terminal, but never `outcome_unknown`,
    // because nothing ran.
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatchObject({ code: "EXECUTION_NOT_PERMITTED" });
    expect(row.claim_token_hash).toBeNull();
    expect(written).toEqual([]);
    expect(await writtenRowCount()).toBe(0);
    registerOperationExecutionPolicies(worker!.db, []);
  }, TEST_TIMEOUT);

  test("the worker refuses to start when a configured policy module fails to initialise", async () => {
    const broken: RuntimeModule = {
      ...exampleModule([deadlinePolicy()]),
      name: "execution-policy-jobs-broken",
      init: async () => {
        throw new Error("its catalog could not be hydrated");
      },
    } as RuntimeModule;
    await expect(startWorkerRole("job-worker", {
      databaseUrl: databaseUrl("worker"),
      modules: { loaded: [broken], failures: [] },
      env: { NODE_ENV: "development", OPENSHAPEFORGE_MAIL_PROVIDER: "null" },
      log: silent,
    })).rejects.toThrow(/contribute host execution policies and did not initialise/);
  }, TEST_TIMEOUT);
});
