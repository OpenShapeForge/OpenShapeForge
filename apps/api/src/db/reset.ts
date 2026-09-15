// SPDX-License-Identifier: BUSL-1.1
/**
 * `bun run db:reset` — drop the target database, recreate it, and build it
 * from the compiled manifest. Every row is destroyed; that is the point.
 *
 *   OPENSHAPEFORGE_MIGRATE_DATABASE_URL=postgres://migrator:...@host/openshapeforge_dev \
 *   OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION=openshapeforge_dev \
 *     bun run db:reset
 *
 * Three refusals, each before anything is touched:
 *   - NODE_ENV=production. A production database is never reset by a script
 *     that happens to hold its credentials; that decision is the operator's,
 *     made with the provider's own tooling.
 *   - No confirmation, or a confirmation that does not name the target
 *     database exactly. A value copied from another environment's job spec
 *     must not authorise a reset here.
 *   - A maintenance or template database as the target.
 *
 * DROP DATABASE cannot run from inside the database being dropped, so the
 * drop and create go through a MAINTENANCE connection: the administrator
 * URL (OPENSHAPEFORGE_ADMIN_DATABASE_URL, or the migrate URL where the
 * migrate role owns the instance, as provision-roles.ts does) re-pointed at
 * the `postgres` database — OPENSHAPEFORGE_RESET_MAINTENANCE_DATABASE names
 * another. A managed instance whose administrator cannot reach one at all
 * drops and creates the database with the provider's API instead and then
 * runs `db:migrate`, which on the empty database is this same build.
 *
 * Roles are cluster-wide and untouched: the chain verifies the host provisioned
 * them and re-grants CONNECT on the new database, which a managed provider
 * clears when a database is recreated.
 */
import { SQL } from "bun";
import { createDatabaseRuntime, readMigrateDatabaseUrl } from "./connection.js";
import { loadRuntimeModules } from "../modules/registry.js";
import { runMigrationChainLocked } from "./bootstrap.js";
import { renderMigrationReport } from "./migration-report.js";

const CONFIRMATION_VARIABLE = "OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION";
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const PROTECTED_DATABASES = new Set(["postgres", "template0", "template1"]);

function refuse(message: string): never {
  console.error(`db:reset refused: ${message}`);
  process.exit(1);
}

/** The database a connection URL names, or a refusal when it cannot be quoted safely. */
function databaseName(url: URL, label: string): string {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!DATABASE_NAME.test(name)) refuse(`${label} must name a lower_snake_case database; got "${name}".`);
  return name;
}

if (process.env.NODE_ENV === "production") {
  refuse("NODE_ENV is production. A production database is reset with the provider's tooling, never by this script.");
}

const migrateUrl = new URL(readMigrateDatabaseUrl());
const target = databaseName(migrateUrl, "OPENSHAPEFORGE_MIGRATE_DATABASE_URL");
if (PROTECTED_DATABASES.has(target)) {
  refuse(`"${target}" is a maintenance database, not an application database.`);
}

const confirmation = process.env[CONFIRMATION_VARIABLE];
if (confirmation !== target) {
  refuse(
    confirmation === undefined
      ? `${CONFIRMATION_VARIABLE} is not set. Set it to "${target}" to confirm destroying every row in that database.`
      : `${CONFIRMATION_VARIABLE} names "${confirmation}", but the migrate URL names "${target}". They must match exactly.`,
  );
}

// Modules are resolved before any connection opens, for the reason migrate.ts
// does: a plugin whose runtime half will not load must not leave a build
// half-run — and here there is no old database to fall back on.
const modules = await loadRuntimeModules();
const moduleSeeds = modules.loaded.flatMap((module) => module.seeds ?? []);

const adminUrl = new URL(process.env.OPENSHAPEFORGE_ADMIN_DATABASE_URL ?? migrateUrl);
if (!process.env.OPENSHAPEFORGE_ADMIN_DATABASE_URL) {
  console.log("OPENSHAPEFORGE_ADMIN_DATABASE_URL not set; using the migrate connection as administrator.");
}
const maintenanceUrl = new URL(adminUrl);
maintenanceUrl.pathname = `/${databaseName(
  new URL(`postgres://host/${process.env.OPENSHAPEFORGE_RESET_MAINTENANCE_DATABASE ?? "postgres"}`),
  "OPENSHAPEFORGE_RESET_MAINTENANCE_DATABASE",
)}`;
if (databaseName(maintenanceUrl, "the maintenance database") === target) {
  refuse(`the maintenance database and the target are both "${target}".`);
}

// A database the administrator creates on the migrate role's behalf is owned
// by the migrate role, so the chain's DDL and grants behave as they do where
// the migrate role created it itself.
const migrator = decodeURIComponent(migrateUrl.username);
const owner =
  migrator && migrator !== decodeURIComponent(adminUrl.username) && DATABASE_NAME.test(migrator)
    ? ` owner "${migrator}"`
    : "";

const maintenance = new SQL(maintenanceUrl.toString(), { max: 1 });
try {
  // FORCE (Postgres 13+) terminates every other session on the target: a
  // reset is announced by the operator scaling the application to zero, and
  // a straggler is not a reason to leave the database half-alive.
  await maintenance.unsafe(`drop database if exists "${target}" with (force)`);
  await maintenance.unsafe(`create database "${target}"${owner}`);
  console.log(`recreated database "${target}"`);
} finally {
  await maintenance.close();
}

const runtime = createDatabaseRuntime({ databaseUrl: migrateUrl.toString() });
try {
  const result = await runMigrationChainLocked(runtime.db, { moduleSeeds });
  console.log(
    JSON.stringify({ reset: target, ...renderMigrationReport(result, modules.failures) }, null, 2),
  );
} finally {
  await runtime.close();
}
