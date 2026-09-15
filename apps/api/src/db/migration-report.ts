// SPDX-License-Identifier: BUSL-1.1
/**
 * The one report `db:migrate` and `db:reset` print after the chain: what was
 * applied, what each seed did, and which runtime modules failed to load. A
 * plugin whose runtime half will not load costs its own seed, not the schema
 * every other surface depends on, so its failure is reported here rather than
 * thrown by the chain.
 */
import type { MigrationChainResult } from "./migration-chain.js";
import type { CatalogSeedResult } from "./migrations/catalog-seed.js";
import type { ModuleRegistry } from "../modules/registry.js";

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

export function renderMigrationReport(
  result: MigrationChainResult,
  moduleLoadFailures: ModuleRegistry["failures"],
): Record<string, unknown> {
  return {
    migration: result.version,
    checksum: result.checksum,
    applied: result.applied,
    ...(result.rollForward === undefined ? {} : { rollForward: result.rollForward }),
    ...(result.pluginMigrationsApplied.length === 0
      ? {}
      : { pluginMigrationsApplied: result.pluginMigrationsApplied }),
    ...(moduleLoadFailures.length === 0
      ? {}
      : {
          moduleLoadFailures: moduleLoadFailures.map(
            (failure) => `${failure.name}: ${failure.reason} — ${failure.message}`,
          ),
        }),
    ...seedReport("pageConfigs", result.pageConfigs),
    ...Object.entries(result.moduleSeeds)
      .flatMap(([name, seed]) => Object.entries(seedReport(name, seed)))
      .reduce((all, [key, value]) => ({ ...all, [key]: value }), {}),
  };
}
