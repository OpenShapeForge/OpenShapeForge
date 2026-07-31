// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { createDatabaseRuntime, readMigrateDatabaseUrl } from "./connection.js";
import { loadRuntimeModules } from "../modules/registry.js";
import type { CatalogSeedResult } from "./migrations/catalog-seed.js";
import { runMigrationChain } from "./migration-chain.js";

/**
 * One reporting line per catalog seed, omitted entirely when the compiler did
 * not emit that seed — a repo without `apps/web`, or without the workflow
 * plugin, should not read as though a catalog failed to load.
 */
function seedReport(name: string, result: CatalogSeedResult): Record<string, string> {
  if (!result.present) return {};
  return {
    [name]: result.skipped ? `unchanged (${result.rows} rows)` : `seeded ${result.rows} rows`,
  };
}

// Migrations run as the PRIVILEGED role (CREATE ROLE, DDL, GRANT) via
// OPENSHAPEFORGE_MIGRATE_DATABASE_URL, NOT the restricted runtime DATABASE_URL role.
// Modules are resolved before the connection opens: a plugin whose runtime half
// will not load must not leave a migration half-run. Load failures are reported
// with the result rather than thrown — a broken plugin costs its own seed, not
// the schema migration every other surface depends on.
const modules = await loadRuntimeModules();
const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);

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
      const result = await runMigrationChain(db, { moduleSeeds });
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
            // Loud on purpose: reconciling a checksum is a rare, reviewed event
            // and an operator should see it in the migrate output, not infer it.
            ...(result.versionedReconciled.length === 0
              ? {}
              : { versionedReconciled: result.versionedReconciled }),
            ...(modules.failures.length === 0
              ? {}
              : {
                  moduleLoadFailures: modules.failures.map(
                    (failure) => `${failure.name}: ${failure.reason} — ${failure.message}`,
                  ),
                }),
            ...seedReport("pageConfigs", result.pageConfigs),
            ...Object.entries(result.moduleSeeds).flatMap(([name, seed]) =>
              Object.entries(seedReport(name, seed)),
            ).reduce((all, [key, value]) => ({ ...all, [key]: value }), {}),
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
