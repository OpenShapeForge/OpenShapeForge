// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { readStatementTimeoutMs } from "../config/limits.js";
import type { OpenShapeForgeDatabase } from "./connection.js";

type Reservation = {
  connection: OpenShapeForgeDatabase;
  pid: number;
  references: Map<string, number>;
  locks: Set<string>;
  failure?: unknown;
  finish: () => void;
  finished: Promise<unknown>;
};

const managers = new WeakMap<OpenShapeForgeDatabase, SharedReadBarriers>();
export function sharedReadBarriers(db: OpenShapeForgeDatabase): SharedReadBarriers {
  let manager = managers.get(db);
  if (!manager) { manager = new SharedReadBarriers(db); managers.set(db, manager); }
  return manager;
}

/** Reader metadata must remain able to finish even when every ordinary pool
 * slot is occupied by writers waiting on the read fence. Serialize its short
 * tenant transactions on the already reserved connection instead. */
export function withReadBarrierDatabase<Database, Result>(db: Kysely<Database>, tenantId: string, work: (database: Kysely<Database>) => Promise<Result>): Promise<Result> {
  const manager = managers.get(db as unknown as OpenShapeForgeDatabase);
  return manager?.hasScope()
    ? manager.databaseWork(tenantId, connection => work(connection as unknown as Kysely<Database>))
    : work(db);
}

/** Session advisory locks share ONE pooled connection across concurrent reads.
 * Short tenant transactions are serialized here, with local GUCs cleared on
 * commit. During provider I/O only the session locks remain. Writers
 * use the matching transaction advisory lock before changing protected data.
 * Hash collisions conservatively serialize unrelated work, never grant access.
 */
export class SharedReadBarriers {
  readonly #db: OpenShapeForgeDatabase;
  #reservation: Reservation | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #scope = new AsyncLocalStorage<{ key: string; tenantId: string; namespace: string; active: boolean; reservation: Reservation }>();
  readonly #databaseScope = new AsyncLocalStorage<boolean>();

  constructor(db: OpenShapeForgeDatabase) { this.#db = db; }
  hasScope(): boolean { return this.#scope.getStore() !== undefined; }

  async #assertHeld(reservation: Reservation, namespace: string, tenantId: string): Promise<void> {
    try {
      const row = (await sql<{ pid: number; held: boolean }>`select pg_backend_pid() as pid,
        exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory'
          and classid=(hashtext(${'osf.read-barrier:' + namespace})::bigint & 4294967295)::oid
          and objid=(hashtext(${tenantId})::bigint & 4294967295)::oid
          and objsubid=2 and mode='ShareLock' and granted) as held`.execute(reservation.connection)).rows[0]!;
      if (row.pid !== reservation.pid || !row.held) throw new Error("Read barrier was lost during database work.");
    } catch (error) { reservation.failure = error; throw error; }
  }

  async databaseWork<T>(tenantId: string, work: (connection: OpenShapeForgeDatabase) => Promise<T>): Promise<T> {
    const current = this.#scope.getStore();
    if (!current?.active) throw new Error("Read barrier scope is no longer active.");
    if (current.tenantId !== tenantId.toLowerCase()) throw new Error("Read barrier database work belongs to another tenant.");
    if (this.#databaseScope.getStore()) throw new Error("An independent transaction cannot nest inside read barrier database work.");
    return this.#serialize(async () => {
      if (!current.active) throw new Error("Read barrier scope is no longer active.");
      if (current.reservation.failure) throw current.reservation.failure;
      await this.#assertHeld(current.reservation, current.namespace, current.tenantId);
      let result: T;
      try { result = await this.#databaseScope.run(true, () => work(current.reservation.connection)); }
      catch (error) {
        try { await this.#assertHeld(current.reservation, current.namespace, current.tenantId); }
        catch (lockError) { throw new AggregateError([error, lockError], "Database work and read barrier both failed."); }
        throw error;
      }
      await this.#assertHeld(current.reservation, current.namespace, current.tenantId);
      if (!current.active) throw new Error("Read barrier scope is no longer active.");
      if (current.reservation.failure) throw current.reservation.failure;
      return result;
    });
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #reserve(): Promise<Reservation> {
    if (this.#reservation) return this.#reservation;
    let ready!: (reservation: Reservation) => void;
    let fail!: (error: unknown) => void;
    const available = new Promise<Reservation>((resolve, reject) => { ready = resolve; fail = reject; });
    let finish!: () => void;
    const idle = new Promise<void>(resolve => { finish = resolve; });
    const finished = this.#db.connection().execute(async connection => {
      const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(connection)).rows[0]!.pid;
      const reservation: Reservation = { connection, pid, references: new Map(), locks: new Set(), finish, finished };
      this.#reservation = reservation;
      ready(reservation);
      await idle;
    });
    void finished.catch(fail);
    return available;
  }

  async #acquire(namespace: string, tenantId: string): Promise<Reservation | undefined> {
    return this.#serialize(async () => {
      const reservation = await this.#reserve();
      if (reservation.failure) throw reservation.failure;
      const key = JSON.stringify([namespace, tenantId]);
      const held = reservation.references.has(key);
      // An existing session lock is reentrant. Explicitly honour queued writers
      // so a stream of new readers cannot indefinitely postpone retirement.
      // Track even an uncertain acquire: an interrupted SQL response must not
      // leave a session lock behind when this connection returns to its pool.
      if (!held) reservation.locks.add(key);
      try {
      const row = (await sql<{ pid: number; acquired: boolean }>`
        select pg_backend_pid() as pid, case when exists (
          select 1 from pg_locks where locktype = 'advisory'
            and database = (select oid from pg_database where datname = current_database())
            and classid = (hashtext(${'osf.read-barrier:' + namespace})::bigint & 4294967295)::oid
            and objid = (hashtext(${tenantId})::bigint & 4294967295)::oid
            and objsubid = 2 and mode = 'ExclusiveLock' and not granted
        ) then false when ${held} then true
          else pg_try_advisory_lock_shared(hashtext(${'osf.read-barrier:' + namespace}), hashtext(${tenantId})) end as acquired
      `.execute(reservation.connection)).rows[0]!;
      if (row.pid !== reservation.pid) throw new Error("Read barrier database connection changed.");
      if (row.acquired) reservation.references.set(key, (reservation.references.get(key) ?? 0) + 1);
      else {
        if (!held) reservation.locks.delete(key);
        if (!reservation.references.size) await this.#finish(reservation);
      }
      return row.acquired ? reservation : undefined;
      } catch (error) {
        reservation.failure = error;
        if (!reservation.references.size) await this.#finish(reservation);
        throw error;
      }
    });
  }

  async #finish(reservation: Reservation): Promise<void> {
    this.#reservation = undefined;
    try {
      for (const key of reservation.locks) {
        const [namespace, tenantId] = JSON.parse(key) as [string, string];
        await sql`select pg_advisory_unlock_shared(hashtext(${'osf.read-barrier:' + namespace}), hashtext(${tenantId}))`.execute(reservation.connection);
      }
    } catch (error) {
      // Never return a connection with uncertain session-lock ownership.
      await sql`select pg_terminate_backend(pg_backend_pid())`.execute(reservation.connection).catch(() => {});
      throw error;
    } finally {
      reservation.finish();
      await reservation.finished;
    }
  }

  async #release(reservation: Reservation, namespace: string, tenantId: string): Promise<void> {
    return this.#serialize(async () => {
      const key = JSON.stringify([namespace, tenantId]);
      const count = reservation.references.get(key);
      if (!count) throw new Error("Read barrier is no longer active.");
      try {
        if (reservation.failure) throw reservation.failure;
        const row = (await sql<{ pid: number; released: boolean }>`select pg_backend_pid() as pid,
          case when ${count === 1} then pg_advisory_unlock_shared(hashtext(${'osf.read-barrier:' + namespace}), hashtext(${tenantId}))
          else exists(select 1 from pg_locks where pid = pg_backend_pid() and locktype = 'advisory'
            and classid = (hashtext(${'osf.read-barrier:' + namespace})::bigint & 4294967295)::oid
            and objid = (hashtext(${tenantId})::bigint & 4294967295)::oid and objsubid = 2 and mode = 'ShareLock' and granted) end as released
        `.execute(reservation.connection)).rows[0]!;
        if (row.pid !== reservation.pid || !row.released) throw new Error("Read barrier was lost during execution.");
        if (count === 1) reservation.locks.delete(key);
      } catch (error) {
        reservation.failure = error;
        throw error;
      } finally {
        if (count === 1) reservation.references.delete(key);
        else reservation.references.set(key, count - 1);
        if (!reservation.references.size) await this.#finish(reservation);
      }
    });
  }

  async run<T>(namespace: string, tenantId: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    tenantId = tenantId.toLowerCase();
    const key = JSON.stringify([namespace, tenantId]);
    const current = this.#scope.getStore();
    if (current) {
      // Detached work must enter through a fresh verified invocation, rather
      // than silently turning an expired ownership scope into a new one.
      if (!current.active) throw new Error("Read barrier scope is no longer active.");
      if (current.tenantId !== tenantId) throw new Error("A read barrier cannot acquire another tenant during execution.");
      if (current.namespace !== namespace) throw new Error("A read barrier cannot acquire another namespace during execution.");
      if (current.reservation.failure) throw current.reservation.failure;
      signal?.throwIfAborted();
      const result = await work();
      signal?.throwIfAborted();
      if (!current.active) throw new Error("Read barrier scope is no longer active.");
      if (current.reservation.failure) throw current.reservation.failure;
      return result;
    }
    let reservation: Reservation | undefined;
    const deadline = Date.now() + (readStatementTimeoutMs() || 30_000);
    let retryMs = 15;
    while (!reservation) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("Read barrier acquisition timed out.");
      reservation = await this.#acquire(namespace, tenantId);
      if (!reservation) {
        await delay(Math.min(retryMs + Math.floor(Math.random() * 15), Math.max(1, deadline - Date.now())), undefined, { signal });
        retryMs = Math.min(250, retryMs * 2);
      }
    }
    const scope = { key, tenantId, namespace, active: true, reservation };
    let failed = false, failure: unknown;
    try {
      signal?.throwIfAborted();
      const result = await this.#scope.run(scope, work);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      failed = true; failure = error;
      throw error;
    } finally {
      scope.active = false;
      // Validate ownership before returning a result, including read failures.
      try { await this.#release(reservation, namespace, tenantId); }
      catch (error) {
        if (failed) throw new AggregateError([failure, error], "Provider read and read barrier both failed.");
        throw error;
      }
    }
  }
}
