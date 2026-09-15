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
 *   0b. worker role           — the SECOND restricted role, the one the
 *      `workerAccess` policies compare `current_user` against. Same position
 *      and same reason as the app role; its grants are enumerated rather than
 *      swept, and also land in step 5.
 *   1. app helpers            — RLS helper functions every policy references.
 *   2. system bypass audit    — break-glass audit table (not manifest-managed).
 *   3. versioned bespoke      — hand-written transformations; run BEFORE the
 *      generated step so a bespoke migration can eliminate non-additive drift
 *      before the roll-forward evaluates it.
 *   3b. plugin cutovers       — immutable compiler-plugin migrations that
 *      must transform legacy ownership before generated drift is evaluated.
 *   4. generated roll-forward — manifest-driven schema apply/diff.
 *   4b. identity link         — runtime-owned platform.identities /
 *      platform.identity_relations (idempotent DDL, like step 2); after the
 *      generated step because they reference platform.tenants and
 *      erp.relations, and before plugin invariants that may reference them.
 *   4c. plugin invariants     — immutable compiler-plugin constraints,
 *      functions, and triggers, after contributed and runtime-owned tables
 *      exist.
 *   4d. employee invitations  — runtime-owned platform.employee_invitations
 *      (idempotent DDL, same reasoning); references platform.tenants only, so
 *      it could run before 4c, but sits next to it because both are the
 *      "login ↔ party" story (db/migrations/employee-invitations.ts).
 *   4e. organization relation link — platform.tenants.relation_id (idempotent
 *      DDL, same reasoning); references erp.relations, so it must run after
 *      the generated step like 4c/4d
 *      (db/migrations/organization-relation-link.ts).
 *   4f. Operation execution receipts — runtime-owned, actor-scoped durable
 *      idempotency ledger. It references platform.tenants, so it also runs
 *      after generated schema and before the app grant sweep.
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
import { applyAppRoleMigration, applyAppRoleGrants } from "./migrations/app-role.js";
import { applyWorkerRoleMigration, applyWorkerRoleGrants } from "./migrations/worker-role.js";
import { applyAppHelpersMigration } from "./migrations/app-helpers.js";
import { applySystemBypassAuditMigration } from "./migrations/system-bypass-audit.js";
import { applyIdentityLinkMigration } from "./migrations/identity-link.js";
import { applyEmployeeInvitationsMigration } from "./migrations/employee-invitations.js";
import { applyOrganizationRelationLinkMigration } from "./migrations/organization-relation-link.js";
import { applyOnboardingMigration } from "./migrations/onboarding.js";
import { applyUpdateNoticesMigration } from "./migrations/update-notices.js";
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
  await applyAppRoleMigration(db);
  await applyWorkerRoleMigration(db);
  await applyAppHelpersMigration(db);
  await applySystemBypassAuditMigration(db);
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
  await applyIdentityLinkMigration(db);
  const afterGenerated = await applyGeneratedPluginMigrations(
    db,
    afterGeneratedPluginMigrations,
    options.appliedBy,
  );
  await applyEmployeeInvitationsMigration(db);
  await applyOrganizationRelationLinkMigration(db);
  await applyOnboardingMigration(db);
  await applyUpdateNoticesMigration(db);
  await applyOperationExecutionReceiptsMigration(db);
  // Sweep table/sequence grants now that every table exists (idempotent).
  await applyAppRoleGrants(db);
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
