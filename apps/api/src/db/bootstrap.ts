// SPDX-License-Identifier: BUSL-1.1
/**
 * Building a database from the manifest, and the lock that serializes it.
 *
 * In the reset model a database is CREATED from the compiled manifest rather
 * than migrated through history: the schema is versioned by git, `db:reset`
 * drops and recreates the database, and an empty database is built on first
 * contact. All three paths — `db:migrate`, `db:reset`, and the API's own
 * startup — run the same chain (migration-chain.ts) under the same advisory
 * lock, so "migrate on an empty database" and "bootstrap on first start" are
 * one thing, not two that have to be kept in step.
 *
 * The lock is what keeps two replicas — or a bootstrapping API pod and a
 * reset job — from building the same database at once. It is taken with no
 * lock_timeout on purpose: the second caller must wait for the first to
 * finish the whole chain. The bounded lock_timeout applies to the DDL inside,
 * so a statement that waits on a lock held by application traffic fails fast
 * and the caller retries instead of hanging forever.
 *
 * Every function here takes a PRIVILEGED Kysely instance (the migrate role):
 * the chain creates schema, grants and functions the runtime role cannot.
 */
import { sql, type Kysely } from "kysely";
import type { DB } from "../generated/db/types.js";
import {
  runMigrationChain,
  type MigrationChainOptions,
  type MigrationChainResult,
} from "./migration-chain.js";
import {
  checkGeneratedSchemaDrift,
  findUndeclaredDatabaseSchema,
  type GeneratedSchemaDriftResult,
  type UndeclaredDatabaseSchema,
} from "./schema-drift.js";

/** The one advisory-lock key every writer of this database's schema takes. */
export const MIGRATION_LOCK_KEY = "openshapeforge-service-db-migrate";

/**
 * Run `fn` on one connection while holding the migration lock. `db` may be a
 * pooled instance; the lock is session-scoped, so the callback receives the
 * connection that holds it and must do all its work there.
 */
export async function withMigrationLock<T>(
  db: Kysely<DB>,
  fn: (connection: Kysely<DB>) => Promise<T>,
): Promise<T> {
  return db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`.execute(
      connection,
    );
    await sql`set lock_timeout = '5s'`.execute(connection);
    try {
      return await fn(connection);
    } finally {
      // The connection may go back to a pool that outlives this call (the
      // API's bootstrap path); leave it as it was found.
      await sql`reset lock_timeout`.execute(connection);
      await sql`select pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`.execute(
        connection,
      );
    }
  });
}

/** The whole chain, serialized: what `db:migrate` and `db:reset` run. */
export async function runMigrationChainLocked(
  db: Kysely<DB>,
  options: MigrationChainOptions = {},
): Promise<MigrationChainResult> {
  return withMigrationLock(db, (connection) => runMigrationChain(connection, options));
}

export type BootstrapOutcome =
  | { bootstrapped: true; result: MigrationChainResult }
  | {
      bootstrapped: false;
      /**
       * - "migrated": the database already matches the bundled manifest.
       * - "behind": it was built from another manifest; that is drift for
       *   `db:migrate` (or `db:reset`) to settle, not something to build over.
       * - "foreign-schema": it carries schema this build does not declare —
       *   another branch's, or a legacy layout — and building the manifest
       *   over the top would produce a database no manifest describes.
       */
      reason: "migrated" | "behind" | "foreign-schema";
      drift: GeneratedSchemaDriftResult;
      undeclared?: UndeclaredDatabaseSchema;
    };

/**
 * Build the database from the manifest if, and only if, it is empty: no
 * generated-schema record AND nothing in a manifest-covered schema that the
 * manifest does not declare. Anything else is left exactly as it is and
 * reported, so a mistargeted connection string can never be "bootstrapped"
 * into a half-known state.
 *
 * The probes run twice: once cheaply before taking the lock, and again under
 * it, because the replica that held the lock first may have built the
 * database in the meantime — the second caller must then find it "migrated",
 * not rebuild it.
 */
export async function bootstrapIfEmpty(
  db: Kysely<DB>,
  options: MigrationChainOptions = {},
): Promise<BootstrapOutcome> {
  const eligibility = await bootstrapEligibility(db);
  if (eligibility !== undefined) return eligibility;

  return withMigrationLock(db, async (connection) => {
    const underLock = await bootstrapEligibility(connection);
    if (underLock !== undefined) return underLock;
    const result = await runMigrationChain(connection, options);
    return { bootstrapped: true, result };
  });
}

async function bootstrapEligibility(
  db: Kysely<DB>,
): Promise<Extract<BootstrapOutcome, { bootstrapped: false }> | undefined> {
  const drift = await checkGeneratedSchemaDrift(db);
  if (drift.status === "ok") return { bootstrapped: false, reason: "migrated", drift };
  if (drift.status === "behind") return { bootstrapped: false, reason: "behind", drift };
  const undeclared = await findUndeclaredDatabaseSchema(db);
  if (undeclared.tables.length > 0 || undeclared.columns.length > 0) {
    return { bootstrapped: false, reason: "foreign-schema", drift, undeclared };
  }
  return undefined;
}
