/**
 * The ordered migration chain, shared by the db:migrate CLI (migrate.ts,
 * which adds the advisory lock + lock_timeout around it) and the migration
 * tests (which run it against throwaway scratch databases).
 *
 * Order matters:
 *   0. app role               — provision the restricted, non-superuser
 *      runtime role + schema/function grants + default privileges. Must run
 *      first (privileged migrate chain) so RLS is actually enforced against
 *      the app role; the table-grant SWEEP runs last (step 5) once tables
 *      exist.
 *   1. app helpers            — RLS helper functions every policy references.
 *   2. system bypass audit    — break-glass audit table (not manifest-managed).
 *   3. versioned bespoke      — hand-written transformations; run BEFORE the
 *      generated step so a bespoke migration can eliminate non-additive drift
 *      before the roll-forward evaluates it.
 *   4. generated roll-forward — manifest-driven schema apply/diff.
 *   5. app role grants        — sweep DML grants over ALL now-existing tables
 *      and sequences so newly-generated entities are covered automatically.
 *
 * `db` must be a connection-bound Kysely instance (obtained via
 * runtime.db.connection().execute) — steps 3 and 4 use explicit
 * BEGIN/COMMIT transactions on that single connection.
 *
 * NOTE: the whole chain runs as the PRIVILEGED migrate role
 * (OPENSHAPEFORGE_MIGRATE_DATABASE_URL) — CREATE ROLE / GRANT / DDL require it.
 */
import type { Kysely } from "kysely";
import type { DB } from "../generated/db/types.js";
import { applyAppRoleMigration, applyAppRoleGrants } from "./migrations/app-role.js";
import { applyAppHelpersMigration } from "./migrations/app-helpers.js";
import { applySystemBypassAuditMigration } from "./migrations/system-bypass-audit.js";
import {
  applyVersionedMigrations,
  type VersionedMigration,
} from "./migrations/versioned-runner.js";
import { versionedMigrations } from "./migrations/versioned/index.js";
import {
  applyGeneratedSchemaMigration,
  type GeneratedSchemaMigrationResult,
} from "./migrations/generated-schema.js";

export type MigrationChainOptions = {
  /** Override the versioned-migration registry (used by tests). */
  versioned?: readonly VersionedMigration[];
  appliedBy?: string;
};

export type MigrationChainResult = GeneratedSchemaMigrationResult & {
  /** Versions of bespoke migrations applied during this run. */
  versionedApplied: string[];
};

export async function runMigrationChain(
  db: Kysely<DB>,
  options: MigrationChainOptions = {},
): Promise<MigrationChainResult> {
  await applyAppRoleMigration(db);
  await applyAppHelpersMigration(db);
  await applySystemBypassAuditMigration(db);
  const versioned = await applyVersionedMigrations(
    db,
    options.versioned ?? versionedMigrations,
  );
  const generated = await applyGeneratedSchemaMigration(db, options.appliedBy);
  // Sweep table/sequence grants now that every table exists (idempotent).
  await applyAppRoleGrants(db);
  return { ...generated, versionedApplied: versioned.applied };
}
