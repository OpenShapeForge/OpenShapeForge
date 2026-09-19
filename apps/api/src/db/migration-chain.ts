// SPDX-License-Identifier: BUSL-1.1
/**
 * The ordered chain that builds a database from the compiled manifest,
 * shared by db:migrate, db:reset and the empty-database bootstrap
 * (db/bootstrap.ts adds the advisory lock + lock_timeout around it) and by
 * the migration tests (which run it against throwaway scratch databases).
 *
 * Three phases, no ledger of hand-written history: the schema is versioned
 * by git, and a database is created from what the manifest says today.
 *
 *   VERIFY
 *   0.  role contract         — every declared database role exists
 *      (db/database-roles.ts) with LOGIN/NOSUPERUSER/NOBYPASSRLS as declared,
 *      and the migrate role is a member of the definer roles. Roles are
 *      cluster-wide; the host provisions them, the chain never creates one.
 *   0a. app role              — CONNECT, schema USAGE and default privileges
 *      for the restricted runtime role; the table-grant SWEEP runs in step 4
 *      once tables exist.
 *   0b. worker role           — the SECOND restricted role, the one the
 *      `workerAccess` policies compare `current_user` against. Its grants
 *      are enumerated rather than swept, and also land in step 4.
 *
 *   CREATE
 *   1.  app helpers           — the `app` schema and the RLS helper functions
 *      every policy references.
 *   2.  generated schema      — schema.sql from the ONE declaration of every
 *      table (platform-schema.yaml + the authoring layers), the runtime-owned
 *      platform bookkeeping included; on a built database, a checksum no-op —
 *      or a refusal when the checksum differs, because a database is rebuilt
 *      with db:reset rather than migrated (migrations/generated-schema.ts).
 *   3.  core invariants       — what the manifest cannot express on manifest
 *      tables and the core owns: the org-unit closure trigger, the document
 *      authority guards and compound keys, the logical document commands,
 *      the artifact binding (migrations/core-invariants.ts). Plain idempotent
 *      DDL on every run.
 *   3a. identity link         — the same for platform.identities /
 *      platform.identity_relations: checks, an expression index,
 *      app.identity_subject() and the bespoke policies. Before the plugin
 *      invariants because plugin DDL may reference the function.
 *   3b. plugin invariants     — compiler-plugin constraints, functions,
 *      triggers and other DDL, idempotent and applied on every run with no
 *      ledger (migrations/generated-plugin-migrations.ts), after contributed
 *      tables exist.
 *   3c–3f. the other runtime invariants the manifest cannot express, one file
 *      per table family, each idempotent on every run: employee invitations
 *      (checks, the one-pending-per-address partial expression index,
 *      policy), the tenant's organization-Relation write policy, update
 *      notices (policies), execution receipts (checks, policy), jobs (the
 *      status vocabulary and per-status shape of the core outbox), blueprints
 *      (checks, compound provenance reference, policies, the SECURITY
 *      DEFINER read function and its ownership transfer).
 *   4.  grants                — sweep DML grants over ALL now-existing tables
 *      and sequences so newly-generated entities are covered automatically,
 *      re-apply the `app` schema USAGE/EXECUTE grants that step 0a had to
 *      skip because step 1 had not created the schema yet, re-narrow the
 *      blueprint tables, then grant the worker role the enumerated subset
 *      it is allowed.
 *
 *   SEED
 *   5.  catalog seeds         — load the compiler's global configuration
 *      catalogs into their platform tables: the entity page configs, then
 *      whatever the loaded runtime modules contribute, in registration order.
 *      Data, not DDL, so they run after the tables exist and after the grant
 *      sweep. Each is a no-op when its seed was not emitted.
 *
 * `db` must be a connection-bound Kysely instance (obtained via
 * runtime.db.connection().execute) — steps 2 and 3b use explicit
 * BEGIN/COMMIT transactions on that single connection.
 *
 * NOTE: the whole chain runs as the PRIVILEGED migrate role
 * (OPENSHAPEFORGE_MIGRATE_DATABASE_URL) — DDL and GRANT require it.
 */
import type { Kysely } from "kysely";
import { fileURLToPath } from "node:url";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "../modules/field-schemas.js";
import type { DB } from "../generated/db/types.js";
import { verifyDatabaseRoles } from "./database-roles.js";
import { applyAppRoleMigration, applyAppRoleGrants } from "./migrations/app-role.js";
import { applyWorkerRoleMigration, applyWorkerRoleGrants } from "./migrations/worker-role.js";
import { applyAppHelpersMigration } from "./migrations/app-helpers.js";
import { applyCoreInvariants } from "./migrations/core-invariants.js";
import { applyDocumentContentGuards } from "./migrations/document-content.js";
import { applyIdentityLinkMigration } from "./migrations/identity-link.js";
import { applyEmployeeInvitationsMigration } from "./migrations/employee-invitations.js";
import { applyCapabilityGrantsMigration } from "./migrations/capability-grants.js";
import { applyOrganizationRelationLinkMigration } from "./migrations/organization-relation-link.js";
import { applyUpdateNoticesMigration } from "./migrations/update-notices.js";
import { applyBlueprintsMigration, applyBlueprintsGrants } from "./migrations/blueprints.js";
import { applyOperationExecutionReceiptsMigration } from "./migrations/operation-execution-receipts.js";
import { applyJobsMigration } from "./migrations/jobs.js";
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
  const generated = await applyGeneratedSchemaMigration(db, options.appliedBy);
  await applyCoreInvariants(db);
  await applyDocumentContentGuards(db);
  // The identity-link invariants (app.identity_subject() above all) may be
  // referenced by a plugin's invariant DDL, so they land before the plugin
  // migrations run.
  await applyIdentityLinkMigration(db);
  const pluginMigrations = await applyGeneratedPluginMigrations(
    db,
    options.pluginMigrations ?? (await loadGeneratedPluginMigrations()),
  );
  await applyEmployeeInvitationsMigration(db);
  await applyCapabilityGrantsMigration(db);
  await applyOrganizationRelationLinkMigration(db);
  await applyUpdateNoticesMigration(db);
  await applyOperationExecutionReceiptsMigration(db);
  await applyJobsMigration(db);
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
    pluginMigrationsApplied: pluginMigrations.applied,
    pageConfigs,
    moduleSeeds,
  };
}
