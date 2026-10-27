// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from "kysely";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { readStatementTimeoutMs, readSharedReadTransactionTimeoutMs, readMaintenanceAdmissionTimeoutMs } from "../config/limits.js";
import type { OpenShapeForgeDatabase } from "./connection.js";

type Reservation = {
  connection: OpenShapeForgeDatabase;
  pid: number;
  references: Map<string, number>;
  locks: Set<string>;
  marked: boolean;
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
export function hasSharedReadBarrier(db: OpenShapeForgeDatabase): boolean {
  return managers.get(db)?.hasScope() ?? false;
}

/** Reader metadata must remain able to finish even when every ordinary pool
 * slot is occupied by writers waiting on the read fence. Prefer free pool
 * slots for parallel metadata; use the reserved backend when admission fails. */
export type ReadBarrierDatabaseContext = { marker: string; budgetMs: number; isActive: () => boolean; retain: (pending: Promise<unknown>) => void };
export function withReadBarrierDatabase<Database, Result>(db: Kysely<Database>, tenantId: string, work: (database: Kysely<Database>, context?: ReadBarrierDatabaseContext) => Promise<Result>): Promise<Result> {
  const manager = managers.get(db as unknown as OpenShapeForgeDatabase);
  return manager?.hasScope()
    ? manager.databaseWork(tenantId, (connection, context) => work(connection as unknown as Kysely<Database>, context))
    : work(db);
}

/** Rotating credentials must be saved atomically after their HTTP exchange.
 * They cannot be interrupted by the short metadata budget. Borrow a normal
 * pool slot before starting; fail admission if writers occupy every slot,
 * rather than deadlocking a reader behind writers waiting on its own fence.
 * The admission signal does not cancel work after a connection is acquired.
 */
export class ReadBarrierMaintenanceAdmissionError extends Error {
  constructor(cause: unknown) { super("Database maintenance admission timed out; retry the request.", { cause }); }
}
export function withReadBarrierMaintenanceDatabase<Database, Result>(db: Kysely<Database>, tenantId: string | null | undefined, work: (database: Kysely<Database>) => Promise<Result>, signal?: AbortSignal): Promise<Result> {
  const manager = managers.get(db as unknown as OpenShapeForgeDatabase);
  if (!manager?.hasScope()) return work(db);
  manager.assertMaintenanceAdmission(tenantId);
  const job = (async () => {
    await manager.verifyMaintenanceFence(tenantId);
    const deadline = AbortSignal.timeout(readMaintenanceAdmissionTimeoutMs());
    let admitted = false;
    try {
      return await db.connection().execute(async connection => {
        admitted = true;
        manager.assertMaintenanceAdmission(tenantId);
        const value = await work(connection);
        await manager.verifyMaintenanceFence(tenantId);
        return value;
      }, { signal: AbortSignal.any([...(signal ? [signal] : []), deadline]) });
    } catch (error) {
      if (!admitted && deadline.aborted && !signal?.aborted) throw new ReadBarrierMaintenanceAdmissionError(error);
      throw error;
    }
  })();
  manager.retainScopeWork(job);
  return job;
}

/** Session advisory locks share ONE pooled connection across concurrent reads.
 * Short tenant transactions prefer free pool slots; the reserved backend
 * serializes their fallback. Local GUCs clear on commit. Provider I/O belongs
 * outside DB callbacks; a whole-transaction
 * budget rolls back accidentally slow callbacks without releasing their
 * Service fence before their remaining work has drained. Writers
 * use the matching transaction advisory lock before changing protected data.
 * Hash collisions conservatively serialize unrelated work, never grant access.
 */
export class SharedReadBarriers {
  readonly #db: OpenShapeForgeDatabase;
  #reservation: Reservation | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #scope = new AsyncLocalStorage<{ tenantId: string; namespace: string; active: boolean; reservation: Reservation; pending: Set<Promise<unknown>>; signal: AbortSignal | undefined }>();
  readonly #databaseScope = new AsyncLocalStorage<boolean>();

  constructor(db: OpenShapeForgeDatabase) { this.#db = db; }
  hasScope(): boolean { return this.#scope.getStore() !== undefined; }
  retainScopeWork(pending: Promise<unknown>): void {
    const scope = this.#scope.getStore();
    if (!scope) throw new Error("Read barrier scope is unavailable.");
    const drain = pending.then(() => {}, () => {});
    scope.pending.add(drain);
    void drain.then(() => scope.pending.delete(drain));
  }
  assertMaintenanceAdmission(tenantId: string | null | undefined): void {
    const scope = this.#scope.getStore();
    if (!scope?.active) throw new Error("Read barrier scope is no longer active.");
    if (scope.tenantId !== tenantId?.toLowerCase()) throw new Error("Read barrier maintenance belongs to another tenant.");
    if (scope.reservation.failure) throw scope.reservation.failure;
    scope.signal?.throwIfAborted();
    if (this.#databaseScope.getStore()) throw new Error("Atomic maintenance must run outside shared metadata transactions.");
  }
  verifyMaintenanceFence(tenantId: string | null | undefined): Promise<void> {
    return this.#serialize(async () => {
      this.assertMaintenanceAdmission(tenantId);
      const scope = this.#scope.getStore()!;
      await this.#assertHeld(scope.reservation, scope.namespace, scope.tenantId);
    });
  }

  async #assertHeld(reservation: Reservation, namespace: string, tenantId: string): Promise<void> {
    try {
      const row = (await sql<{ pid: number; held: boolean }>`select pg_backend_pid() as pid,
        exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory'
          and classid=(hashtext(${'osf.read-barrier:' + namespace})::bigint & 4294967295)::oid
          and objid=(hashtext(${tenantId})::bigint & 4294967295)::oid
          and objsubid=2 and mode='ShareLock' and granted)
        and exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory'
          and classid=(hashtext('osf.read-barrier:shared-backend')::bigint & 4294967295)::oid
          and objid=0 and objsubid=2 and mode='ShareLock' and granted) as held`.execute(reservation.connection)).rows[0]!;
      if (row.pid !== reservation.pid || !row.held) throw new Error("Read barrier was lost during database work.");
    } catch (error) { reservation.failure = error; throw error; }
  }

  async databaseWork<T>(tenantId: string, work: (connection: OpenShapeForgeDatabase, context: ReadBarrierDatabaseContext) => Promise<T>): Promise<T> {
    const current = this.#scope.getStore();
    if (!current?.active) throw new Error("Read barrier scope is no longer active.");
    if (current.tenantId !== tenantId.toLowerCase()) throw new Error("Read barrier database work belongs to another tenant.");
    if (this.#databaseScope.getStore()) throw new Error("An independent transaction cannot nest inside read barrier database work.");
    const retain = (pending: Promise<unknown>) => this.retainScopeWork(pending);
    const execute = async (connection: OpenShapeForgeDatabase, serializeChecks: boolean) => {
      const assertActive = () => {
        if (!current.active) throw new Error("Read barrier scope is no longer active.");
        current.signal?.throwIfAborted();
        if (current.reservation.failure) throw current.reservation.failure;
      };
      const held = () => serializeChecks
        ? this.#serialize(() => this.#assertHeld(current.reservation, current.namespace, current.tenantId))
        : this.#assertHeld(current.reservation, current.namespace, current.tenantId);
      assertActive();
      await held();
      assertActive();
      let result: T;
      try { result = await this.#databaseScope.run(true, () => work(connection, {
        marker: JSON.stringify({ namespace: current.namespace, tenantId: current.tenantId }),
        budgetMs: readSharedReadTransactionTimeoutMs(), isActive: () => current.active, retain,
      })); }
      catch (error) {
        try { await held(); }
        catch (lockError) { throw new AggregateError([error, lockError], "Database work and read barrier both failed."); }
        throw error;
      }
      await held();
      assertActive();
      return result;
    };
    const job = (async () => {
      // Prefer parallel, short transactions on free ordinary pool slots. This
      // probe only selects a strategy: cold or busy slots fall back to the
      // already reserved backend, so waiting writers cannot deadlock a reader.
      const probe = AbortSignal.timeout(5);
      let admitted = false;
      try {
        return await this.#db.connection().execute(connection => {
          admitted = true;
          return execute(connection, true);
        }, { signal: AbortSignal.any([probe, ...(current.signal ? [current.signal] : [])]) });
      } catch (error) {
        // Never replay callback work, including a callback's own TimeoutError.
        if (admitted || !probe.aborted || current.signal?.aborted) throw error;
        return this.#serialize(() => execute(current.reservation.connection, false));
      }
    })();
    retain(job);
    return job;
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
      const reservation: Reservation = { connection, pid, references: new Map(), locks: new Set(), marked: false, finish, finished };
      this.#reservation = reservation;
      ready(reservation);
      await idle;
    });
    void finished.catch(fail);
    return available;
  }

  async #acquire(namespace: string, tenantId: string, deadline: number, signal?: AbortSignal): Promise<Reservation | undefined> {
    return this.#serialize(async () => {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("Read barrier acquisition timed out.");
      const reservation = await this.#reserve();
      if (signal?.aborted || Date.now() >= deadline) {
        if (!reservation.references.size) await this.#finish(reservation);
        signal?.throwIfAborted();
        throw new Error("Read barrier acquisition timed out.");
      }
      if (reservation.failure) throw reservation.failure;
      const key = JSON.stringify([namespace, tenantId]);
      const held = reservation.references.has(key);
      // An existing session lock is reentrant. Explicitly honour queued writers
      // so a stream of new readers cannot indefinitely postpone retirement.
      // Track even an uncertain acquire: an interrupted SQL response must not
      // leave a session lock behind when this connection returns to its pool.
      try {
      if (!reservation.marked) {
        reservation.marked = true;
        const marker = (await sql<{ acquired: boolean }>`select pg_try_advisory_lock_shared(hashtext('osf.read-barrier:shared-backend'),0) as acquired`.execute(reservation.connection)).rows[0]!;
        if (!marker.acquired) {
          reservation.marked = false;
          await this.#finish(reservation);
          return undefined;
        }
      }
      if (!held) reservation.locks.add(key);
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
      if (reservation.marked) await sql`select pg_advisory_unlock_shared(hashtext('osf.read-barrier:shared-backend'),0)`.execute(reservation.connection);
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
      reservation = await this.#acquire(namespace, tenantId, deadline, signal);
      if (!reservation) {
        await delay(Math.min(retryMs + Math.floor(Math.random() * 15), Math.max(1, deadline - Date.now())), undefined, { signal });
        retryMs = Math.min(250, retryMs * 2);
      }
    }
    const scope = { tenantId, namespace, active: true, reservation, pending: new Set<Promise<unknown>>(), signal };
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
      while (scope.pending.size) await Promise.allSettled([...scope.pending]);
      // Validate ownership before returning a result, including read failures.
      try { await this.#release(reservation, namespace, tenantId); }
      catch (error) {
        if (failed) throw new AggregateError([failure, error], "Provider read and read barrier both failed.");
        throw error;
      }
    }
  }
}
