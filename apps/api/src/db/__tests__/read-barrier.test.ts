// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime } from "../connection.js";
import { sharedReadBarriers } from "../read-barrier.js";
import { ModulePlatformRuntime } from "../../modules/platform.js";

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
    });
    await expect(platform.services.db.withSharedReadBarrier!(expired as never, "test.one", async () => {})).rejects.toThrow("live verified");
  } finally { await runtime.close(); }
}, 10_000);

test("parallel external reads share one lock connection, no open transactions; queued writers stop new readers", async () => {
  const admin = new SQL(owner, { max: 2 });
  const name = `barrier_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(owner); url.pathname = `/${name}`;
  const runtime = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 3 });
  const writer = new SQL(url.toString(), { max: 1 });
  const tenant = crypto.randomUUID(), namespace = "test.definitions";
  const pending = deferred(), allStarted = deferred();
  const barrier = sharedReadBarriers(runtime.db);
  let started = 0;
  let reads: Promise<unknown>[] = [];
  try {
    expect(sharedReadBarriers(runtime.db)).toBe(barrier);
    reads = Array.from({ length: 12 }, () => barrier.run(namespace, tenant, async () => {
      if (++started === 12) allStarted.resolve();
      await pending.promise;
      return "live";
    }));
    await allStarted.promise;
    const activity = await admin.unsafe(`select count(*) filter(where state='idle in transaction')::int as transactions,
      count(*) filter(where backend_type='client backend')::int as connections from pg_stat_activity where datname=$1`, [name]);
    expect(activity[0].transactions).toBe(0);
    expect(activity[0].connections).toBeLessThanOrEqual(3);
    expect((await admin.unsafe("select count(distinct pid)::int as n from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=$1)", [name]))[0].n).toBe(1);
    // Both remaining pooled connections can work while all twelve HTTP stand-ins wait.
    const probes = await Promise.all([1, 2].map(() => sql<{ pid: number }>`select pg_backend_pid() as pid, pg_sleep(0.05)`.execute(runtime.db)));
    expect(new Set(probes.map(result => result.rows[0]!.pid)).size).toBe(2);
    let written = false, lateRead = false;
    const write = writer.begin(async trx => {
      await trx.unsafe("select pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["osf.read-barrier:" + namespace, tenant]);
      written = true;
    });
    await waitFor(async () => (await admin.unsafe("select exists(select 1 from pg_locks where locktype='advisory' and not granted) as waiting"))[0].waiting);
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
  } finally {
    await runtime.close(); await admin.unsafe(`drop database "${name}" with (force)`); await admin.close();
  }
}, 15_000);
