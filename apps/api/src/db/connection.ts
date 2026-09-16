// SPDX-License-Identifier: BUSL-1.1
import { SQL } from "bun";
import { Kysely, type KyselyConfig } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import type { DB } from "../generated/db/types.js";

export type OpenShapeForgeDatabase = Kysely<DB>;

export type DatabaseRuntime = {
  db: OpenShapeForgeDatabase;
  close: () => Promise<void>;
};

export type DatabaseRuntimeOptions = {
  databaseUrl?: string;
  maxConnections?: number;
  /**
   * Kysely's query log. Unset in every production path — SQL text can carry
   * tenant data, so nothing routes this to the application logger by default.
   * Diagnostics use it, and so do the tests that assert which statements a read
   * actually issues (the opt-in count, #17).
   */
  log?: KyselyConfig["log"];
};

/**
 * The APP RUNTIME connection string. DATABASE_URL must point at the restricted,
 * non-superuser `openshapeforge_app` role so FORCE ROW LEVEL SECURITY is actually
 * enforced at the database layer (a superuser silently bypasses every RLS
 * policy). Tenant isolation must NOT rest on the app-layer WHERE clause alone.
 */
export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for apps/api database access.");
  }
  return databaseUrl;
}

/**
 * The PRIVILEGED MIGRATE connection string. Migrations need to CREATE ROLE,
 * run DDL, and issue GRANTs — none of which the restricted runtime role can
 * do — so migrate connects as the privileged `openshapeforge` superuser via
 * OPENSHAPEFORGE_MIGRATE_DATABASE_URL.
 *
 * Falls back to DATABASE_URL only when the privileged URL is unset (e.g. a
 * legacy single-role setup). In that case, if the runtime role is restricted,
 * the migration chain's role-provisioning / DDL steps will fail loudly with a
 * Postgres permission error rather than silently skipping — which is the
 * intended fail-closed behavior.
 */
export function readMigrateDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const migrateUrl = env.OPENSHAPEFORGE_MIGRATE_DATABASE_URL;
  if (migrateUrl) {
    return migrateUrl;
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "OPENSHAPEFORGE_MIGRATE_DATABASE_URL (or DATABASE_URL as a fallback) is required to run migrations.",
    );
  }
  return databaseUrl;
}

export function createDatabaseRuntime(
  options: DatabaseRuntimeOptions = {},
): DatabaseRuntime {
  const postgres = new SQL(options.databaseUrl ?? readDatabaseUrl(), {
    max: options.maxConnections ?? 10,
  });

  const db = new Kysely<DB>({
    dialect: new PostgresJSDialect({
      postgres,
    }),
    ...(options.log ? { log: options.log } : {}),
  });

  return {
    db,
    close: async () => {
      await db.destroy();
    },
  };
}
