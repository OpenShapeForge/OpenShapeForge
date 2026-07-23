import { sql } from "kysely";
import { createDatabaseRuntime, readMigrateDatabaseUrl } from "./connection.js";
import { runMigrationChain } from "./migration-chain.js";

// Migrations run as the PRIVILEGED role (CREATE ROLE, DDL, GRANT) via
// OPENSHAPEFORGE_MIGRATE_DATABASE_URL, NOT the restricted runtime DATABASE_URL role.
const runtime = createDatabaseRuntime({ databaseUrl: readMigrateDatabaseUrl() });
const migrationLockKey = "openshapeforge-service-db-migrate";

try {
  await runtime.db.connection().execute(async (db) => {
    // Acquire the cross-replica serialization lock with no lock_timeout: the
    // second replica must wait for the first to finish the whole chain, so
    // this wait is intentional and must not fail fast.
    await sql`select pg_advisory_lock(hashtextextended(${migrationLockKey}, 0))`.execute(db);
    // Bounded lock_timeout for the migration DDL itself, so DDL that waits on
    // a lock held by app traffic fails fast and the caller retries instead of
    // hanging forever.
    await sql`set lock_timeout = '5s'`.execute(db);
    try {
      const result = await runMigrationChain(db);
      console.log(
        JSON.stringify(
          {
            migration: result.version,
            checksum: result.checksum,
            applied: result.applied,
            ...(result.rollForward === undefined
              ? {}
              : { rollForward: result.rollForward }),
            ...(result.versionedApplied.length === 0
              ? {}
              : { versionedApplied: result.versionedApplied }),
          },
          null,
          2,
        ),
      );
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${migrationLockKey}, 0))`.execute(db);
    }
  });
} finally {
  await runtime.close();
}
