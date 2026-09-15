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
 *      the app role; the table-grant SWEEP runs last (step 5) once tables
 *      exist.
 *   0.  role contract         — verify every declared database role exists
 *      (db/database-roles.ts) with LOGIN/NOSUPERUSER/NOBYPASSRLS as declared
 *      and that the migrate role is a member of the definer roles. Roles are
 *      cluster-wide; the host provisions them, the chain never creates one.
 *   0b. worker role           — the SECOND restricted role, the one the
 *      `workerAccess` policies compare `current_user` against. Same position
 *      and same reason as the app role; its grants are enumerated rather than
 *      swept, and also land in step 5.
 *   1. app helpers            — RLS helper functions every policy references.
 *   3. versioned bespoke      — hand-written transformations; run BEFORE the
 *      generated step so a bespoke migration can eliminate non-additive drift
 *      before the roll-forward evaluates it.
 *   3b. plugin cutovers       — immutable compiler-plugin migrations that
 *      must transform legacy ownership before generated drift is evaluated.
 *   4. generated roll-forward — manifest-driven schema apply/diff. Every
 *      table, the runtime-owned platform bookkeeping included, is created
 *      here from the ONE declaration in platform-schema.yaml.
 *   4b. identity link         — what the manifest cannot express for
 *      platform.identities / platform.identity_relations: checks, an
 *      expression index, app.identity_subject() and the bespoke policies
 *      (idempotent DDL on every run). Before the plugin invariants because
 *      plugin DDL may reference the function.
 *   4c. plugin invariants     — immutable compiler-plugin constraints,
 *      functions, triggers, and other DDL, after contributed tables exist.
 *   4d–4g. the other runtime invariants the manifest cannot express, one
 *      file per table family and each idempotent on every run: employee
 *      invitations (checks, the one-pending-per-address partial expression
 *      index, policy), the tenant's organization-Relation write policy,
 *      update notices (policies), execution receipts (checks, policy),
 *      blueprints (checks, compound provenance reference, policies, the
 *      SECURITY DEFINER read function and its ownership transfer).
 *   5. app role grants        — sweep DML grants over ALL now-existing tables
 *      and sequences so newly-generated entities are covered automatically,
 *      re-apply the `app` schema USAGE/EXECUTE grants that step 0 had to skip
 *      because step 1 had not created the schema yet, then grant the worker
 *      role the enumerated subset it is allowed.
 *   6. catalog seeds          — load the compiler's global configuration
 *      catalogs into their platform tables: the entity page configs, then
 *      whatever the loaded runtime modules contribute, in registration order.
 *      Data, not DDL, so they run after the tables exist and after the grant
 *      sweep. Each is a no-op when its seed was not emitted.
 *
 * `db` must be a connection-bound Kysely instance (obtained via
 * runtime.db.connection().execute) — steps 3, 4, and 4b use explicit
 * BEGIN/COMMIT transactions on that single connection.
 *
 * NOTE: the whole chain runs as the PRIVILEGED migrate role
 * (OPENSHAPEFORGE_MIGRATE_DATABASE_URL) — CREATE ROLE / GRANT / DDL require it.
 */
import type { Kysely } from "kysely";
import { fileURLToPath } from "node:url";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "../modules/field-schemas.js";
import type { DB } from "../generated/db/types.js";
import { verifyDatabaseRoles } from "./database-roles.js";
import { applyAppRoleMigration, applyAppRoleGrants } from "./migrations/app-role.js";
import { applyWorkerRoleMigration, applyWorkerRoleGrants } from "./migrations/worker-role.js";
import { applyAppHelpersMigration } from "./migrations/app-helpers.js";
import { applyIdentityLinkMigration } from "./migrations/identity-link.js";
import { applyEmployeeInvitationsMigration } from "./migrations/employee-invitations.js";
import { applyOrganizationRelationLinkMigration } from "./migrations/organization-relation-link.js";
import { applyUpdateNoticesMigration } from "./migrations/update-notices.js";
import { applyBlueprintsMigration, applyBlueprintsGrants } from "./migrations/blueprints.js";
import { applyOperationExecutionReceiptsMigration } from "./migrations/operation-execution-receipts.js";
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
  applyGeneratedPluginMigrations,
  loadGeneratedPluginMigrations,
  type GeneratedPluginMigration,
} from "./migrations/generated-plugin-migrations.js";
import {
  applyEntityPageConfigsSeed,
  type EntityPageConfigsSeedResult,
} from "./migrations/entity-page-configs-seed.js";
import type { ModuleSeed } from "../modules/contract.js";
import type { CatalogSeedResult } from "./migrations/catalog-seed.js";

export type MigrationChainOptions = {
  /** Override the versioned-migration registry (used by tests). */
  versioned?: readonly VersionedMigration[];
  /** Override compiler-plugin invariant DDL (used by tests). */
  pluginMigrations?: readonly GeneratedPluginMigration[];
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
  /** Compiler-plugin invariant migrations applied during this run. */
  pluginMigrationsApplied: string[];
  /** Outcome of the entity page-config catalog seed. */
  pageConfigs: EntityPageConfigsSeedResult;
  /** Outcome of each module-contributed seed, keyed by its reporting name. */
  moduleSeeds: Record<string, CatalogSeedResult>;
};

export async function runMigrationChain(
  db: Kysely<DB>,
  options: MigrationChainOptions = {},
): Promise<MigrationChainResult> {
  // Step 0: the declared roles must already exist — the host provisions them,
  // this chain only verifies. A fresh environment fails here with the exact
  // administrator statements instead of half-way through the schema.
  await verifyDatabaseRoles(db);
  await applyAppRoleMigration(db);
  await applyWorkerRoleMigration(db);
  await applyAppHelpersMigration(db);
  const versioned = await applyVersionedMigrations(
    db,
    options.versioned ?? versionedMigrations,
  );
  const configuredPluginMigrations =
    options.pluginMigrations ?? (await loadGeneratedPluginMigrations());
  const beforeGeneratedPluginMigrations = configuredPluginMigrations.filter(
    ({ phase }) => phase === "beforeGenerated",
  );
  const afterGeneratedPluginMigrations = configuredPluginMigrations.filter(
    ({ phase }) => phase !== "beforeGenerated",
  );
  const beforeGenerated = await applyGeneratedPluginMigrations(
    db,
    beforeGeneratedPluginMigrations,
    options.appliedBy,
  );
  const generated = await applyGeneratedSchemaMigration(db, options.appliedBy);
  // The identity-link invariants (app.identity_subject() above all) may be
  // referenced by a plugin's invariant DDL, so they land before the
  // after-generated plugin migrations run.
  await applyIdentityLinkMigration(db);
  const afterGenerated = await applyGeneratedPluginMigrations(
    db,
    afterGeneratedPluginMigrations,
    options.appliedBy,
  );
  await applyEmployeeInvitationsMigration(db);
  await applyOrganizationRelationLinkMigration(db);
  await applyUpdateNoticesMigration(db);
  await applyOperationExecutionReceiptsMigration(db);
  await applyBlueprintsMigration(db);
  // Sweep table/sequence grants now that every table exists (idempotent).
  await applyAppRoleGrants(db);
  await applyBlueprintsGrants(db);
  // The worker role's grants are enumerated from the manifest rather than
  // swept, and re-evaluated here on every migrate so a table that newly
  // declares (or stops declaring) workerDml is picked up without a bespoke
  // migration.
  await applyWorkerRoleGrants(db);
  const pageConfigs = await applyEntityPageConfigsSeed(db);
  const moduleSeeds: Record<string, CatalogSeedResult> = {};
  for (const seed of options.moduleSeeds ?? []) {
    moduleSeeds[seed.name] = await seed.apply(db, {
      schemas: { fields: generatedRuntimeFieldSchemas, json: runtimeJsonSchemas },
      seedDirectory: fileURLToPath(new URL("../../../../authoring/seeds/", import.meta.url)),
    });
  }
  return {
    ...generated,
    versionedApplied: versioned.applied,
    versionedReconciled: versioned.reconciled,
    pluginMigrationsApplied: [
      ...beforeGenerated.applied,
      ...afterGenerated.applied,
    ],
    pageConfigs,
    moduleSeeds,
  };
}
