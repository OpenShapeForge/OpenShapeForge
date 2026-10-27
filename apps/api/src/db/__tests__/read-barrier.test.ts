// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { CompiledQuery, sql, type DatabaseConnection, type Transaction } from "kysely";
import { createDatabaseRuntime, databasePoolLimit } from "../connection.js";
import { sharedReadBarriers, withReadBarrierMaintenanceDatabase, ReadBarrierMaintenanceAdmissionError } from "../read-barrier.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";
import { withDbSession } from "../session.js";
import { operationErrorOf } from "@openshapeforge/operations";
import { executeKeyedOperation } from "../../operations/execution-receipts.js";
import { refreshConnectionRowLocked } from "../../mcp/connection-token-refresh.js";
import { toHttpError } from "../../rest/http-error.js";
import { withAuditContext } from "../../platform/audit-context.js";

const owner = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const waitFor = async (condition: () => Promise<boolean>) => {
  const until = Date.now() + 3000;
  while (!await condition()) { if (Date.now() > until) throw new Error("Database condition did not settle"); await Bun.sleep(10); }
};

test("one-connection hosts retain a transaction fence; only the live exact session can acquire it", async () => {
  const runtime = createDatabaseRuntime({ databaseUrl: owner, maxConnections: 1 });
  const platform = new ModulePlatformRuntime(runtime.db);
  const session = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), roles: [], groups: [], credential: "bearer", scope: "self" };
  let expired: unknown;
  try {
    await platform.withActiveOperationSession(session as never, async live => {
      expired = live;
      await expect(platform.services.db.withSharedReadBarrier!({ ...live }, "test.one", async () => {})).rejects.toThrow("live verified");
      await expect(platform.services.db.withSharedReadBarrier!(live, "invalid namespace", async () => {})).rejects.toThrow("Invalid");
      await platform.services.db.withSharedReadBarrier!(live, "test.one", async () => {
        const pids = await Promise.all([1, 2].map(() => platform.services.db.withSession(live, async trx =>
          (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid)));
        expect(pids[0]).toBe(pids[1]);
      });
      const abort = new AbortController();
      await expect(platform.services.db.withSharedReadBarrier!(live, "test.one", async () => {
        abort.abort(); return "must not return";
      }, { signal: abort.signal })).rejects.toThrow();
    });
    await expect(platform.services.db.withSharedReadBarrier!(expired as never, "test.one", async () => {})).rejects.toThrow("live verified");
  } finally { await runtime.close(); }
}, 10_000);

test.each([2, 3])("reader DB work completes when writers occupy every ordinary slot in a pool of %p", async maxConnections => {
  const admin = new SQL(owner, { max: 2 });
  const name = `barrier_pressure_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(owner); url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections });
  const platform = new ModulePlatformRuntime(runtime.db);
  const tenantId = crypto.randomUUID(), namespace = "test.pressure";
  const session = { tenantId, userId: crypto.randomUUID(), roles: [], groups: [], credential: "bearer", scope: "self" };
  const entered = deferred(), httpDone = deferred();
  const writers: Promise<unknown>[] = []; let read: Promise<unknown> | undefined;
  let finished = false;
  try {
    read = platform.withActiveOperationSession(session as never, live => platform.services.db.withSharedReadBarrier!(live, namespace, async () => {
      const first = await platform.services.db.withSession(live, async trx =>
        (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid);
      await expect(platform.services.db.withSharedReadBarrier!(live, "test.other", async () => {})).rejects.toThrow("another namespace");
      await expect(sharedReadBarriers(runtime.db).run(namespace, crypto.randomUUID(), async () => {})).rejects.toThrow("another tenant");
      await expect(withDbSession(runtime.db, { ...live, tenantId: crypto.randomUUID() }, async () => {})).rejects.toThrow("another tenant");
      entered.resolve(); await httpDone.promise;
      // Engine-internal sessions must use the same reserved connection too,
      // not attempt to borrow a pool slot held by our waiting writers.
      await withDbSession(runtime.db, live, async trx => {
        const row = (await sql<{ pid: number; tenant: string }>`select pg_backend_pid() as pid, current_setting('app.tenant_id') as tenant`.execute(trx)).rows[0]!;
        expect(row.pid).toBe(first); expect(row.tenant).toBe(tenantId);
        await platform.services.db.withSharedReadBarrier!(live, namespace, async () => {
          const nested = await platform.services.db.withSession(live, async inner => (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(inner)).rows[0]!.pid);
          expect(nested).toBe(first);
        });
        await expect(withDbSession(runtime.db, live, async () => {}, { independent: true })).rejects.toThrow("independent transaction");
      });
      finished = true;
    }));
    await entered.promise;
    for (let index = 0; index < maxConnections - 1; index++) writers.push(runtime.db.transaction().execute(trx =>
      sql`select pg_advisory_xact_lock(hashtext(${'osf.read-barrier:' + namespace}), hashtext(${tenantId}))`.execute(trx)).catch(() => null));
    await waitFor(async () => (await admin.unsafe("select count(*)::int as n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=$1)", [name]))[0].n === maxConnections - 1);
    httpDone.resolve();
    const until = Date.now() + 1500;
    while (!finished && Date.now() < until) await Bun.sleep(10);
    expect(finished).toBe(true);
    await read; await Promise.all(writers);
    const clean = await Promise.all(Array.from({ length: maxConnections }, () => sql<{ tenant: string }>`select coalesce(current_setting('app.tenant_id',true),'') as tenant, pg_sleep(0.02)`.execute(runtime.db)));
    expect(clean.every(result => result.rows[0]!.tenant === "")).toBe(true);
  } finally {
    httpDone.resolve();
    await admin.unsafe("select pg_cancel_backend(pid) from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=$1)", [name]);
    await Promise.allSettled([read, ...writers].filter(Boolean));
    await runtime.close(); await admin.unsafe(`drop database "${name}" with (force)`); await admin.close();
  }
}, 10_000);

test("serialized metadata keeps each tenant, actor, roles, relation and audit authority distinct", async () => {
  const runtime = createDatabaseRuntime({ databaseUrl: owner, maxConnections: 3 });
  const platform = new ModulePlatformRuntime(runtime.db);
  const sessions = ["A", "B"].map(key => ({ tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), roles: [`Example.${key}.Read`], groups: [],
    relation: { status: "linked", relationId: crypto.randomUUID() }, relationGroupIds: [crypto.randomUUID()], credential: "bearer", scope: "self", operation: `test.isolation.${key}` }));
  try {
    const rows = await Promise.all(sessions.map(session => withAuditContext(session.operation, "bearer", () =>
      platform.withActiveOperationSession(session as never, live => platform.services.db.withSharedReadBarrier!(live, "test.isolation", async () =>
        platform.services.db.withSession(live, async trx => (await sql<{ pid: number; tenant: string; actor: string; roles: string; relation: string; groups: string; operation: string; bypass: string }>`select pg_backend_pid() as pid,
          current_setting('app.tenant_id') as tenant, current_setting('app.user_id') as actor, current_setting('app.roles') as roles,
          current_setting('app.relation_id') as relation, current_setting('app.relation_group_ids') as groups,
          current_setting('app.audit_operation') as operation, current_setting('app.bypass_rls') as bypass`.execute(trx)).rows[0]!)
      )))));
    expect(rows[0]!.pid).toBe(rows[1]!.pid);
    for (let index = 0; index < sessions.length; index++) {
      const session = sessions[index]!, { pid: _pid, ...row } = rows[index]!;
      expect(row).toEqual({ tenant: session.tenantId, actor: session.userId, roles: session.roles[0]!, relation: session.relation.relationId,
        groups: session.relationGroupIds[0]!, operation: session.operation, bypass: "false" });
    }
  } finally { await runtime.close(); }
}, 10_000);

test("expired metadata frees other tenants while retaining its own fence until callback I/O drains", async () => {
  const previous = process.env.DB_SHARED_READ_TRANSACTION_TIMEOUT_MS;
  process.env.DB_SHARED_READ_TRANSACTION_TIMEOUT_MS = "250";
  const admin = new SQL(owner, { max: 2 });
  const name = `barrier_budget_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(owner); url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 3 });
  const platform = new ModulePlatformRuntime(runtime.db), namespace = "test.budget";
  const actor = () => ({ tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), roles: [], groups: [], credential: "bearer", scope: "self" });
  const first = actor(), slow = actor(), firstEntered = deferred(), slowEntered = deferred(), finishFirst = deferred(), finishSlow = deferred();
  let captured!: Transaction<unknown>, borrowed!: DatabaseConnection, rawRejected = false, cloneRejected = false, connectionRejected = false, slowSettled = false;
  let firstRead: Promise<unknown> | undefined, slowRead: Promise<unknown> | undefined, writer: Promise<unknown> | undefined;
  try {
    firstRead = platform.withActiveOperationSession(first as never, live => platform.services.db.withSharedReadBarrier!(live, namespace, async () => {
      firstEntered.resolve(); await finishFirst.promise; return "first";
    }));
    await firstEntered.promise;
    slowRead = platform.withActiveOperationSession(slow as never, live => platform.services.db.withSharedReadBarrier!(live, namespace, async () =>
      platform.services.db.withSession(live, async trx => {
        captured = trx as Transaction<unknown>;
        borrowed = await trx.getExecutor().provideConnection(async connection => connection);
        slowEntered.resolve(); await finishSlow.promise;
        try { await captured.executeQuery(CompiledQuery.raw("select 1")); } catch { rawRejected = true; }
        try { await captured.withoutPlugins().selectNoFrom(sql`1`.as("value")).execute(); } catch { cloneRejected = true; }
        try { await borrowed.executeQuery(CompiledQuery.raw("select 1")); } catch { connectionRejected = true; }
        return "must not escape";
      })
    ));
    const slowResult = slowRead.then(value => { slowSettled = true; return { value }; }, error => { slowSettled = true; return { error: error as Error }; });
    await Promise.race([slowEntered.promise, slowResult.then(() => { throw new Error("Slow callback did not start"); })]);
    let written = false;
    writer = runtime.db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(hashtext(${'osf.read-barrier:' + namespace}), hashtext(${first.tenantId}))`.execute(trx);
      written = true;
    });
    finishFirst.resolve();
    await waitFor(async () => written);
    expect(await firstRead).toBe("first");
    expect(slowSettled).toBe(false);
    // The expired metadata transaction is gone, but its session read fence
    // remains until the original callback has really finished its I/O.
    expect((await admin.unsafe("select count(*)::int as n from pg_stat_activity where datname=$1 and state='idle in transaction'", [name]))[0].n).toBe(0);
    expect((await admin.unsafe("select exists(select 1 from pg_locks where locktype='advisory' and objid=(hashtext($1)::bigint & 4294967295)::oid and objsubid=2 and mode='ShareLock' and granted) as held", [slow.tenantId]))[0].held).toBe(true);
    const next = actor();
    const marker = await platform.withActiveOperationSession(next as never, live => platform.services.db.withSharedReadBarrier!(live, "test.other-namespace", () =>
      platform.services.db.withSession(live, async trx => (await sql<{ marker: string; tenant: string }>`select current_setting('app.shared_read_barrier') as marker,current_setting('app.tenant_id') as tenant`.execute(trx)).rows[0]!)
    ));
    expect(JSON.parse(marker.marker)).toEqual({ namespace: "test.other-namespace", tenantId: next.tenantId });
    expect(marker.tenant).toBe(next.tenantId);
    finishSlow.resolve();
    const result = await slowResult;
    expect("error" in result && result.error.message.includes("metadata transaction timed out")).toBe(true);
    expect(rawRejected).toBe(true); expect(cloneRejected).toBe(true);
    expect(connectionRejected).toBe(true);
    await writer;
  } finally {
    finishFirst.resolve(); finishSlow.resolve();
    await Promise.allSettled([firstRead, slowRead, writer].filter(Boolean));
    await runtime.close(); await admin.unsafe(`drop database "${name}" with (force)`); await admin.close();
    if (previous === undefined) delete process.env.DB_SHARED_READ_TRANSACTION_TIMEOUT_MS;
    else process.env.DB_SHARED_READ_TRANSACTION_TIMEOUT_MS = previous;
  }
}, 10_000);

test("atomic maintenance survives the metadata budget and never starts when the ordinary pool is full", async () => {
  const previous = process.env.DB_SHARED_READ_TRANSACTION_TIMEOUT_MS;
  const previousAdmission = process.env.DB_MAINTENANCE_ADMISSION_TIMEOUT_MS;
  process.env.DB_SHARED_READ_TRANSACTION_TIMEOUT_MS = "25";
  const admin = new SQL(owner, { max: 2 });
  const name = `barrier_rotation_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(owner); url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 3 });
  const platform = new ModulePlatformRuntime(runtime.db), namespace = "test.rotation";
  const session = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), roles: [], groups: [], credential: "bearer", scope: "self" };
  const entered = deferred(), finishHttp = deferred(), occupy = deferred(), admitted = deferred();
  let rotating: Promise<unknown> | undefined, busy: Promise<unknown> | undefined;
  const writers: Promise<unknown>[] = [];
  try {
    await sql`create table fixture_rotation (value text not null)`.execute(runtime.db);
    rotating = platform.withActiveOperationSession(session as never, live => platform.services.db.withSharedReadBarrier!(live, namespace, () =>
      withReadBarrierMaintenanceDatabase(runtime.db, live.tenantId, database => withDbSession(database, live, async trx => {
        expect((await sql<{ marker: string }>`select current_setting('app.shared_read_barrier') as marker`.execute(trx)).rows[0]!.marker).toBe("");
        entered.resolve(); await finishHttp.promise;
        await sql`insert into fixture_rotation(value) values('rotated')`.execute(trx);
      }))
    ));
    await entered.promise;
    await Bun.sleep(75); // longer than both metadata and admission budgets
    const other = { ...session, tenantId: crypto.randomUUID() };
    await platform.withActiveOperationSession(other as never, live => platform.services.db.withSharedReadBarrier!(live, "test.unrelated", () =>
      platform.services.db.withSession(live, async () => {
        let called = false;
        await expect(Promise.resolve().then(() => withReadBarrierMaintenanceDatabase(runtime.db, live.tenantId, async () => { called = true; }))).rejects.toThrow("outside shared metadata");
        expect(called).toBe(false);
      })
    ));
    finishHttp.resolve(); await rotating;
    expect((await sql<{ value: string }>`select value from fixture_rotation`.execute(runtime.db)).rows[0]!.value).toBe("rotated");
    // Ordinary contention exceeding 50 ms must still admit maintenance.
    await platform.withActiveOperationSession(session as never, live => platform.services.db.withSharedReadBarrier!(live, namespace, async () => {
      await expect(Promise.resolve().then(() => withReadBarrierMaintenanceDatabase(runtime.db, crypto.randomUUID(), async () => {}))).rejects.toThrow("another tenant");
      let effects = 0;
      const failure = await executeKeyedOperation(runtime.db, live as never, {
        operation: { id: "test.external", intent: "invoke" }, idempotencyKey: "never-claim",
        contractFingerprint: "test", input: {}, externalWrite: true,
        execute: async () => { effects++; return "must not dispatch"; }, encode: value => value, decode: value => value,
      }).catch(error => error);
      expect(operationErrorOf(failure)?.code).toBe("FORBIDDEN");
      expect(effects).toBe(0);
      const release = deferred(), both = deferred(); let slots = 0;
      const held = [1, 2].map(() => runtime.db.connection().execute(async () => { if (++slots === 2) both.resolve(); await release.promise; }));
      await both.promise;
      const timer = setTimeout(release.resolve, 100);
      try { await withReadBarrierMaintenanceDatabase(runtime.db, live.tenantId, async () => {}); }
      finally { clearTimeout(timer); release.resolve(); await Promise.all(held); }
    }));
    process.env.DB_MAINTENANCE_ADMISSION_TIMEOUT_MS = "75";
    let exchangeStarted = false, refused = false;
    busy = platform.withActiveOperationSession(session as never, live => platform.services.db.withSharedReadBarrier!(live, namespace, async () => {
      admitted.resolve(); await occupy.promise;
      try { await withReadBarrierMaintenanceDatabase(runtime.db, live.tenantId, async () => { exchangeStarted = true; }); }
      catch (error) { refused = error instanceof ReadBarrierMaintenanceAdmissionError; }
      const failure = await refreshConnectionRowLocked({
        db: runtime.db, session: live, rowId: crypto.randomUUID(), valuesField: "values", providerField: "providerId",
        table: { schema: "public", table: "never_query", primaryKey: "id", columns: [{ name: "values" }, { name: "provider_id", sourceField: "providerId" }, { name: "owner_user_id", sourceField: "ownerUserId" }] } as never,
        expectedProviderId: crypto.randomUUID(), expectedOwnerUserId: null,
        audit: { sourceTable: "fixture", connectionId: crypto.randomUUID(), scope: "tenant", correlationId: "fixture" },
        tokenUrl: "https://provider.example/token", clientId: "fixture", clientSecret: "fixture", egress: ["https://provider.example"], keyring: {} as never, secretScope: "fixture",
        fetchImpl: async () => { exchangeStarted = true; throw new Error("must not exchange"); },
      }).catch(error => error);
      expect(toHttpError(failure)).toMatchObject({ status: 503, body: { error: { code: "DATABASE_BUSY", retryable: true } } });

    }));
    await admitted.promise;
    for (let index = 0; index < 2; index++) writers.push(runtime.db.transaction().execute(trx =>
      sql`select pg_advisory_xact_lock(hashtext(${'osf.read-barrier:' + namespace}),hashtext(${session.tenantId}))`.execute(trx)).catch(() => null));
    await waitFor(async () => (await admin.unsafe("select count(*)::int as n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=$1)",[name]))[0].n === 2);
    occupy.resolve(); await busy; await Promise.all(writers);
    expect(refused).toBe(true); expect(exchangeStarted).toBe(false);
    const available = await Promise.all([1, 2, 3].map(() => sql<{ pid: number }>`select pg_backend_pid() as pid,pg_sleep(0.02)`.execute(runtime.db)));
    expect(new Set(available.map(result => result.rows[0]!.pid)).size).toBe(3);
  } finally {
    finishHttp.resolve(); occupy.resolve();
    await admin.unsafe("select pg_cancel_backend(pid) from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=$1)",[name]);
    await Promise.allSettled([rotating, busy, ...writers].filter(Boolean));
    await runtime.close(); await admin.unsafe(`drop database "${name}" with (force)`); await admin.close();
    if (previous === undefined) delete process.env.DB_SHARED_READ_TRANSACTION_TIMEOUT_MS; else process.env.DB_SHARED_READ_TRANSACTION_TIMEOUT_MS = previous;
    if (previousAdmission === undefined) delete process.env.DB_MAINTENANCE_ADMISSION_TIMEOUT_MS; else process.env.DB_MAINTENANCE_ADMISSION_TIMEOUT_MS = previousAdmission;
  }
}, 10_000);

test("an ambient tenant transaction keeps its own connection and fence until commit", async () => {
  const runtime = createDatabaseRuntime({ databaseUrl: owner, maxConnections: 3 });
  const platform = new ModulePlatformRuntime(runtime.db);
  const session = { tenantId: crypto.randomUUID(), userId: crypto.randomUUID(), roles: [], groups: [], credential: "bearer", scope: "self" };
  try {
    await platform.withActiveOperationSession(session as never, live => platform.services.db.withSession(live, async trx => {
      const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
      await platform.services.db.withSharedReadBarrier!(live, "test.ambient", async () => {
        const nested = await platform.services.db.withSession(live, async inner =>
          (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(inner)).rows[0]!.pid);
        expect(nested).toBe(pid);
      });
      expect((await sql<{ n: number }>`select count(*)::int as n from pg_locks where pid=pg_backend_pid() and locktype='advisory'`.execute(trx)).rows[0]!.n).toBe(1);
    }));
    expect((await sql<{ n: number }>`select count(*)::int as n from pg_locks where pid=pg_backend_pid() and locktype='advisory'`.execute(runtime.db)).rows[0]!.n).toBe(0);
  } finally { await runtime.close(); }
}, 10_000);

test.each([2, 3])("parallel external reads share one lock connection in a pool of %p; queued writers stop new readers", async maxConnections => {
  const admin = new SQL(owner, { max: 2 });
  const name = `barrier_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(owner); url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections });
  const writer = new SQL(url.toString(), { max: 1 });
  const tenant = crypto.randomUUID(), namespace = "test.definitions";
  const pending = deferred(), allStarted = deferred();
  const barrier = sharedReadBarriers(runtime.db);
  let started = 0;
  let reads: Promise<unknown>[] = [];
  try {
    expect(sharedReadBarriers(runtime.db)).toBe(barrier);
    expect(databasePoolLimit(runtime.db)).toBe(maxConnections);
    expect(databasePoolLimit(runtime.db.withoutPlugins())).toBe(1);
    reads = Array.from({ length: 12 }, () => barrier.run(namespace, tenant, async () => {
      if (++started === 12) allStarted.resolve();
      await pending.promise;
      await barrier.run(namespace, tenant, async () => {});
      return "live";
    }));
    await allStarted.promise;
    const activity = await admin.unsafe(`select count(*) filter(where state='idle in transaction')::int as transactions,
      count(*) filter(where backend_type='client backend')::int as connections from pg_stat_activity where datname=$1`, [name]);
    expect(activity[0].transactions).toBe(0);
    expect(activity[0].connections).toBeLessThanOrEqual(maxConnections);
    expect((await admin.unsafe("select count(distinct pid)::int as n from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=$1)", [name]))[0].n).toBe(1);
    // Every remaining pooled connection can work while all HTTP stand-ins wait.
    const probes = await Promise.all(Array.from({ length: maxConnections - 1 }, () => sql<{ pid: number }>`select pg_backend_pid() as pid, pg_sleep(0.05)`.execute(runtime.db)));
    expect(new Set(probes.map(result => result.rows[0]!.pid)).size).toBe(maxConnections - 1);
    let written = false, lateRead = false;
    const write = writer.begin(async trx => {
      await trx.unsafe("select pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["osf.read-barrier:" + namespace, tenant]);
      written = true;
    });
    await waitFor(async () => (await admin.unsafe("select exists(select 1 from pg_locks where locktype='advisory' and not granted) as waiting"))[0].waiting);
    const previousTimeout = process.env.DB_STATEMENT_TIMEOUT_MS;
    try {
      process.env.DB_STATEMENT_TIMEOUT_MS = "25";
      await expect(barrier.run(namespace, tenant, async () => { throw new Error("must not enter"); })).rejects.toThrow("acquisition timed out");
    } finally {
      if (previousTimeout === undefined) delete process.env.DB_STATEMENT_TIMEOUT_MS;
      else process.env.DB_STATEMENT_TIMEOUT_MS = previousTimeout;
    }
    const cancelled = new AbortController();
    const waiting = barrier.run(namespace, tenant, async () => { throw new Error("must not enter"); }, cancelled.signal);
    cancelled.abort(); await expect(waiting).rejects.toThrow();
    const late = barrier.run(namespace, tenant, async () => { expect(written).toBe(true); lateRead = true; });
    await Bun.sleep(30);
    expect(written).toBe(false); expect(lateRead).toBe(false);
    // A different tenant and a second definition namespace remain independent.
    await barrier.run(namespace, crypto.randomUUID(), async () => {});
    await barrier.run("test.other", tenant, async () => {});
    pending.resolve();
    expect(await Promise.all(reads)).toEqual(Array(12).fill("live"));
    await write; await late;
    expect(lateRead).toBe(true);
    expect((await admin.unsafe("select count(*)::int as n from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=$1)", [name]))[0].n).toBe(0);
    await expect(barrier.run(namespace, tenant, async () => { throw new Error("provider failed"); })).rejects.toThrow("provider failed");
    const abort = new AbortController(); abort.abort();
    await expect(barrier.run(namespace, tenant, async () => { throw new Error("must not enter"); }, abort.signal)).rejects.toThrow();
    await writer.begin(async trx => {
      await trx.unsafe("select pg_advisory_xact_lock(hashtext('osf.read-barrier:shared-backend'),0)");
      const previous = process.env.DB_STATEMENT_TIMEOUT_MS; process.env.DB_STATEMENT_TIMEOUT_MS = "25";
      try { await expect(barrier.run(namespace, tenant, async () => { throw new Error("must not enter"); })).rejects.toThrow("acquisition timed out"); }
      finally { if (previous === undefined) delete process.env.DB_STATEMENT_TIMEOUT_MS; else process.env.DB_STATEMENT_TIMEOUT_MS = previous; }
    });
    expect(await barrier.run(namespace, tenant, async () => "again")).toBe("again");
  } finally {
    pending.resolve(); await Promise.allSettled(reads);
    await writer.close(); await runtime.close();
    await admin.unsafe(`drop database "${name}" with (force)`); await admin.close();
  }
}, 15_000);

test("a lost lock connection fails closed and subsequent calls can recover", async () => {
  const admin = new SQL(owner, { max: 2 });
  const name = `barrier_loss_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(owner); url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 3 });
  const barrier = sharedReadBarriers(runtime.db), tenant = crypto.randomUUID();
  try {
    await expect(barrier.run("test.loss", tenant, async () => {
      const rows = await admin.unsafe("select pid from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=$1)", [name]);
      expect(rows).toHaveLength(1);
      await admin.unsafe("select pg_terminate_backend($1)", [rows[0].pid]);
      return "must not be returned";
    })).rejects.toThrow();
    expect(await barrier.run("test.loss", tenant, async () => "recovered")).toBe("recovered");
    const providerFailure = new Error("provider failed too");
    let combined: unknown;
    try {
      await barrier.run("test.loss", tenant, async () => {
        const rows = await admin.unsafe("select pid from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=$1)", [name]);
        await admin.unsafe("select pg_terminate_backend($1)", [rows[0].pid]);
        throw providerFailure;
      });
    } catch (error) { combined = error; }
    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).errors[0]).toBe(providerFailure);
    const resume = deferred(); let escaped!: Promise<unknown>;
    await barrier.run("test.loss", tenant, async () => {
      escaped = resume.promise.then(() => barrier.run("test.loss", tenant, async () => {}));
    });
    const settled = escaped.then(() => null, error => error as Error);
    resume.resolve();
    expect((await settled)?.message).toContain("no longer active");
    const late = deferred(); let detached!: Promise<unknown>;
    await barrier.run("test.loss", tenant, async () => {
      detached = barrier.run("test.loss", tenant, async () => { await late.promise; return "must not escape"; });
    });
    const detachedResult = detached.then(() => null, error => error as Error);
    late.resolve(); expect((await detachedResult)?.message).toContain("no longer active");
    let providerStarted = false;
    await expect(barrier.run("test.loss", tenant, async () => {
      await withDbSession(runtime.db, { tenantId: tenant, userId: crypto.randomUUID(), roles: [], groups: [] }, async trx => {
        const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
        await admin.unsafe("select pg_terminate_backend($1)", [pid]);
      });
      providerStarted = true;
    })).rejects.toThrow();
    expect(providerStarted).toBe(false);
    expect(await barrier.run("test.loss", tenant, async () => "after metadata failure")).toBe("after metadata failure");
  } finally {
    await runtime.close(); await admin.unsafe(`drop database "${name}" with (force)`); await admin.close();
  }
}, 15_000);
