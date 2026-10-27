// SPDX-License-Identifier: BUSL-1.1
import { Kysely, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type Driver, type Transaction } from "kysely";

/** Borrow a transaction through a revocable driver, using only public Kysely
 * interfaces. Every query, including raw compiled queries and plugin/schema
 * clones, checks the lifetime before reaching the original connection. The
 * real transaction remains owned by withDbSession; this nested driver never
 * begins, commits or rolls it back itself.
 */
export async function boundedReadTransaction<Database, Result>(
  original: Transaction<Database>,
  budgetMs: number,
  isActive: () => boolean,
  retain: (pending: Promise<unknown>) => void,
  work: (transaction: Transaction<Database>) => Promise<Result>,
): Promise<Result> {
  let active = true;
  const assertActive = () => {
    if (!active || !isActive()) throw new Error("Shared read metadata transaction has expired.");
  };
  const executor = original.getExecutor();
  const connection: DatabaseConnection = {
    async executeQuery<Row>(query: CompiledQuery, options?: Parameters<DatabaseConnection["executeQuery"]>[1]) {
      assertActive();
      return executor.provideConnection(async target => {
        // A query queued before timeout must not run after rollback.
        assertActive();
        return target.executeQuery<Row>(query, options);
      }, options);
    },
    async *streamQuery() {
      assertActive();
      throw new Error("SQL streams are not supported in shared read metadata transactions.");
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() { assertActive(); return connection; },
    async releaseConnection() {},
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async destroy() {},
  };
  const borrowed = new Kysely<Database>({ plugins: [...executor.plugins], dialect: {
    createDriver: () => driver,
    createAdapter: () => executor.adapter,
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createIntrospector: db => new PostgresIntrospector(db),
  } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await borrowed.transaction().execute(async transaction => {
      const body = work(transaction);
      const timeoutError = new Error("Shared read metadata transaction timed out.");
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          active = false;
          // Roll back promptly, but keep the service fence until callback I/O
          // has actually ended. No TTL can reopen a retired definition early.
          retain(body);
          reject(timeoutError);
        }, budgetMs);
      });
      try { return await Promise.race([body, timeout]); }
      finally { active = false; if (timer) clearTimeout(timer); }
    });
  } finally { active = false; await borrowed.destroy(); }
}
