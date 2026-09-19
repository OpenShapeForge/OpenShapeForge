// SPDX-License-Identifier: BUSL-1.1
/**
 * `bun run db:migrate` — build the connected database from the compiled
 * manifest. On an empty database this is the bootstrap the API performs on
 * first start (db/bootstrap.ts); on a built one whose checksum matches it
 * re-applies the invariants and re-runs the seeds. A built database whose
 * checksum differs is refused: the reset model settles that with
 * `bun run db:reset`, never with an in-place change.
 */
import { createDatabaseRuntime, readMigrateDatabaseUrl } from "./connection.js";
import { loadRuntimeModules } from "../modules/registry.js";
import { runMigrationChainLocked } from "./bootstrap.js";
import { renderMigrationReport } from "./migration-report.js";

// Migrations run as the PRIVILEGED role (DDL, GRANT) via
// OPENSHAPEFORGE_MIGRATE_DATABASE_URL, NOT the restricted runtime DATABASE_URL
// role. The host must provision the declared roles first (the Helm hook runs
// provision-roles.ts immediately before this entry point); this chain verifies
// their presence and then refreshes their grants and policies.
// Modules are resolved before the connection opens: a plugin whose runtime half
// will not load must not leave a migration half-run. Load failures are reported
// with the result rather than thrown — a broken plugin costs its own seed, not
// the schema migration every other surface depends on.
const modules = await loadRuntimeModules();
const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);

const runtime = createDatabaseRuntime({ databaseUrl: readMigrateDatabaseUrl() });
try {
  const result = await runMigrationChainLocked(runtime.db, { moduleSeeds });
  console.log(JSON.stringify(renderMigrationReport(result, modules.failures), null, 2));
} finally {
  await runtime.close();
}
