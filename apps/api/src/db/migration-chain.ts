// SPDX-License-Identifier: BUSL-1.1
/**
 * The ordered migration chain, shared by the db:migrate CLI (migrate.ts,
 * which adds the advisory lock + lock_timeout around it) and the migration
 * tests (which run it against throwaway scratch databases).
 *
 * Order matters:
 *   0. app role               — provision the restricted, non-superuser
 *      runtime role + schema/function grants + default privileges. Must run
 *      first (privileged migrate chain) so RLS is actually enforced against
 *      the app role; the table-grant SWEEP runs last (step 6) once tables
 *      exist.
 *   1. app helpers            — RLS helper functions every policy references.
 *   2. system bypass audit    — break-glass audit table (not manifest-managed).
 *   3. retention controls     — durable review, archive, and key-destruction queues.
 *   4. versioned bespoke      — hand-written transformations; run BEFORE the
 *      generated step so a bespoke migration can eliminate non-additive drift
 *      before the roll-forward evaluates it.
 *   5. generated roll-forward — manifest-driven schema apply/diff.
 *   6. app role grants        — sweep DML grants over ALL now-existing tables
 *      and sequences so newly-generated entities are covered automatically.
 *   6. catalog seeds          — load the compiler's global configuration
 *      catalogs into their platform tables: the entity page configs, then
 *      whatever the loaded runtime modules contribute, in registration order.
 *      Data, not DDL, so they run after the tables exist and after the grant
 *      sweep. Each is a no-op when its seed was not emitted.
 *
 * `db` must be a connection-bound Kysely instance (obtained via
 * runtime.db.connection().execute) — steps 4 and 5 use explicit
 * BEGIN/COMMIT transactions on that single connection.
 *
 * NOTE: the whole chain runs as the PRIVILEGED migrate role
 * (OPENSHAPEFORGE_MIGRATE_DATABASE_URL) — CREATE ROLE / GRANT / DDL require it.
 */
import type { Kysely } from "kysely";
import type { DB } from "../generated/db/types.js";
import { applyAppRoleMigration, applyAppRoleGrants } from "./migrations/app-role.js";
import { applyAppHelpersMigration } from "./migrations/app-helpers.js";
import { applyRetentionControlMigration } from "./migrations/retention-control.js";
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
import {
  applyEntityPageConfigsSeed,
  type EntityPageConfigsSeedResult,
} from "./migrations/entity-page-configs-seed.js";
import type { ModuleSeed } from "../modules/contract.js";
import type { CatalogSeedResult } from "./migrations/catalog-seed.js";

export type MigrationChainOptions = {
  /** Override the versioned-migration registry (used by tests). */
  versioned?: readonly VersionedMigration[];
  appliedBy?: string;
  /**
   * Seed steps contributed by runtime modules, applied in registration order
   * after the core seeds. Empty for a repo with no runtime plugin, and for
   * every caller that only migrates schema.
   */
  moduleSeeds?: readonly ModuleSeed[];
};

export type MigrationChainResult = GeneratedSchemaMigrationResult & {
  /** Versions of bespoke migrations applied during this run. */
  versionedApplied: string[];
  /** Applied versions whose ledger checksum was reconciled to the current file. */
  versionedReconciled: string[];
  /** Outcome of the entity page-config catalog seed. */
  pageConfigs: EntityPageConfigsSeedResult;
  /** Outcome of each module-contributed seed, keyed by its reporting name. */
  moduleSeeds: Record<string, CatalogSeedResult>;
};

export async function runMigrationChain(
  db: Kysely<DB>,
  options: MigrationChainOptions = {},
): Promise<MigrationChainResult> {
  await applyAppRoleMigration(db);
  await applyAppHelpersMigration(db);
  await applySystemBypassAuditMigration(db);
  await applyRetentionControlMigration(db);
  const versioned = await applyVersionedMigrations(
    db,
    options.versioned ?? versionedMigrations,
  );
  const generated = await applyGeneratedSchemaMigration(db, options.appliedBy);
  // Sweep table/sequence grants now that every table exists (idempotent).
  await applyAppRoleGrants(db);
  const pageConfigs = await applyEntityPageConfigsSeed(db);
  const moduleSeeds: Record<string, CatalogSeedResult> = {};
  for (const seed of options.moduleSeeds ?? []) {
    moduleSeeds[seed.name] = await seed.apply(db);
  }
  return {
    ...generated,
    versionedApplied: versioned.applied,
    versionedReconciled: versioned.reconciled,
    pageConfigs,
    moduleSeeds,
  };
}
