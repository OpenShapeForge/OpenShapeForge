// SPDX-License-Identifier: BUSL-1.1
import type { ReadinessCheck } from "@openshapeforge/observability";
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
  type OpenShapeForgeDatabase,
} from "../db/connection.js";
import { bootstrapIfEmpty } from "../db/bootstrap.js";
import {
  checkGeneratedSchemaDrift,
  databaseNameFromUrl,
  findUndeclaredDatabaseSchema,
  type GeneratedSchemaDriftResult,
  type UndeclaredDatabaseSchema,
} from "../db/schema-drift.js";
import type { ModuleSeed } from "../modules/contract.js";
import type { ModuleRegistry } from "../modules/registry.js";

const DRIFT_CHECK_TIMEOUT_MS = 5_000;
const READINESS_CHECK_NAME = /^[a-z][a-z0-9_]*$/;
const CORE_READINESS_CHECK_NAMES = [
  "database",
  "schema",
  "runtime_modules",
] as const;

/**
 * The schema dependency has one question in the reset model — was this
 * database built from the bundled manifest, and only from it? — so these
 * are the only codes the schema check can raise: no record, another
 * manifest's record, or objects beside the manifest.
 */
export const API_READINESS_ERROR_CODES = new Set([
  "GENERATED_SCHEMA_BEHIND",
  "GENERATED_SCHEMA_UNMIGRATED",
  "GENERATED_SCHEMA_FOREIGN",
]);

function readinessError(code: string): Error {
  return Object.assign(
    new Error("A database schema dependency is incompatible."),
    { code },
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isForeign(undeclared: UndeclaredDatabaseSchema): boolean {
  return undeclared.tables.length > 0 || undeclared.columns.length > 0;
}

function driftBanner(
  drift: GeneratedSchemaDriftResult,
  undeclared: UndeclaredDatabaseSchema = { tables: [], columns: [] },
): string {
  const foreign = isForeign(undeclared);
  return [
    "============================================================================",
    `GENERATED SCHEMA DRIFT DETECTED (status: ${drift.status}${foreign ? ", foreign schema" : ""})`,
    foreign
      ? "The database carries schema the bundled manifest does not declare."
      : drift.status === "unmigrated"
        ? "The database has no applied generated-schema migration record (fresh DB?)."
        : "The database was built from another manifest than the one bundled in this build.",
    `  recorded checksum: ${drift.recordedChecksum ?? "<none>"}`,
    `  bundled checksum:  ${drift.bundledChecksum}`,
    ...undeclared.tables.map((name) => `  - table  ${name}`),
    ...undeclared.columns.map((name) => `  - column ${name}`),
    drift.status === "unmigrated" && !foreign
      ? "Run `bun run db:migrate` to build the database."
      : "Rebuild the database with `bun run db:reset`; a built database is never changed in place.",
    "============================================================================",
  ].join("\n");
}

export type SchemaFreshnessOptions = {
  /**
   * The runtime connection string. An empty database is only bootstrapped
   * when the migrate URL names the SAME database, so a migrate URL left over
   * from another setup can never build into somewhere else.
   */
  databaseUrl?: string;
  /** Seeds the loaded runtime modules contribute, applied by the bootstrap. */
  moduleSeeds?: readonly ModuleSeed[];
  /** The environment the migrate URL is read from; process.env by default. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Build an empty development database on first start, the way `db:migrate`
 * would (db/bootstrap.ts): the privileged migrate connection runs the chain
 * under the migration lock, so a second replica starting at the same moment
 * waits and then finds the database built. Never in production, where the
 * schema is the deploy's responsibility and an unmigrated database refuses to
 * serve. Returns whether the database is now built.
 */
async function bootstrapEmptyDatabase(
  log: FastifyBaseLogger,
  options: SchemaFreshnessOptions,
): Promise<boolean> {
  const env = options.env ?? process.env;
  const migrateUrl = env.OPENSHAPEFORGE_MIGRATE_DATABASE_URL;
  if (!migrateUrl) {
    log.warn(
      "The database is empty and OPENSHAPEFORGE_MIGRATE_DATABASE_URL is not set; not bootstrapping it. Run `bun run db:migrate`.",
    );
    return false;
  }
  const target = databaseNameFromUrl(migrateUrl);
  const own = databaseNameFromUrl(options.databaseUrl);
  if (own !== null && target !== own) {
    log.warn(
      { migrateDatabase: target, database: own },
      "The database is empty but OPENSHAPEFORGE_MIGRATE_DATABASE_URL names a different database; not bootstrapping it.",
    );
    return false;
  }

  const migrator = createDatabaseRuntime({ databaseUrl: migrateUrl, maxConnections: 2 });
  try {
    const outcome = await bootstrapIfEmpty(migrator.db, {
      ...(options.moduleSeeds ? { moduleSeeds: options.moduleSeeds } : {}),
    });
    if (outcome.bootstrapped) {
      log.info(
        { database: target, checksum: outcome.result.checksum },
        "Empty database bootstrapped from the bundled manifest.",
      );
      return true;
    }
    // "migrated" here means another replica built it while this one probed.
    if (outcome.reason === "migrated") return true;
    log.warn(
      { database: target, reason: outcome.reason, ...(outcome.undeclared ? { undeclared: outcome.undeclared } : {}) },
      "The database is not empty; not bootstrapping it.",
    );
    return false;
  } catch (error) {
    log.error({ err: error }, "Bootstrapping the empty database failed; continuing without a schema.");
    return false;
  } finally {
    await migrator.close();
  }
}

/** Verify generated schema freshness once before Fastify serves traffic. */
export async function enforceGeneratedSchemaFreshness(
  log: FastifyBaseLogger,
  db: OpenShapeForgeDatabase,
  options: SchemaFreshnessOptions = {},
): Promise<void> {
  const production = process.env.NODE_ENV === "production";
  let drift: GeneratedSchemaDriftResult;
  try {
    drift = await withTimeout(
      checkGeneratedSchemaDrift(db),
      DRIFT_CHECK_TIMEOUT_MS,
      "generated schema drift check",
    );
  } catch (error) {
    if (production) {
      throw new Error(
        "Unable to verify generated schema freshness at startup; refusing to serve.",
        { cause: error },
      );
    }
    log.error(
      { err: error },
      "Generated schema drift check failed at startup (database unreachable?); continuing without verification.",
    );
    return;
  }
  if (drift.status === "ok") {
    // A matching checksum says the build happened; the undeclared probe says
    // nothing was added beside it since.
    const undeclared = await withTimeout(
      findUndeclaredDatabaseSchema(db),
      DRIFT_CHECK_TIMEOUT_MS,
      "undeclared schema probe",
    );
    if (isForeign(undeclared)) {
      if (production) throw new Error(driftBanner(drift, undeclared));
      log.warn(driftBanner(drift, undeclared));
      return;
    }
    log.debug(
      { checksum: drift.bundledChecksum },
      "Generated schema drift check: database matches the bundled manifest.",
    );
    return;
  }
  if (production) throw new Error(driftBanner(drift));
  if (drift.status === "unmigrated" && (await bootstrapEmptyDatabase(log, options))) {
    return;
  }
  log.warn(driftBanner(drift));
}

/** Re-run dependency checks on every probe so recovery needs no restart. */
export function createApiReadinessChecks(
  databaseRuntime: DatabaseRuntime | undefined,
  modules: ModuleRegistry,
  baseChecks?: readonly ReadinessCheck[],
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = baseChecks ? [...baseChecks] : [
    {
      name: "database",
      check: async () => {
        if (!databaseRuntime)
          throw new Error("Database runtime is not configured.");
        await sql`select 1`.execute(databaseRuntime.db);
      },
    },
    {
      name: "schema",
      check: async () => {
        if (!databaseRuntime)
          throw new Error("Database runtime is not configured.");
        const drift = await checkGeneratedSchemaDrift(databaseRuntime.db);
        if (drift.status !== "ok") {
          throw readinessError(
            drift.status === "behind"
              ? "GENERATED_SCHEMA_BEHIND"
              : "GENERATED_SCHEMA_UNMIGRATED",
          );
        }
        if (isForeign(await findUndeclaredDatabaseSchema(databaseRuntime.db))) {
          throw readinessError("GENERATED_SCHEMA_FOREIGN");
        }
      },
    },
    {
      name: "runtime_modules",
      check: () => {
        if (modules.failures.length > 0) {
          throw new Error(
            `${modules.failures.length} declared runtime module(s) failed initialization.`,
          );
        }
      },
    },
  ];

  const owners = new Map<string, string>();
  for (const check of checks) {
    if (owners.has(check.name)) {
      throw new Error(
        `Readiness check ${JSON.stringify(check.name)} is declared more than once.`,
      );
    }
    owners.set(check.name, "core");
  }
  for (const name of CORE_READINESS_CHECK_NAMES) {
    if (!owners.has(name)) owners.set(name, "core reserved name");
  }
  const moduleChecks = modules.loaded
    .flatMap((module) =>
      (module.readinessChecks ?? []).map((check) => ({ module, check })),
    )
    .sort(
      (left, right) =>
        left.check.name.localeCompare(right.check.name) ||
        left.module.name.localeCompare(right.module.name),
    );

  for (const { module, check } of moduleChecks) {
    if (!READINESS_CHECK_NAME.test(check.name)) {
      throw new Error(
        `Runtime module ${JSON.stringify(module.name)} declares invalid readiness check ` +
          `${JSON.stringify(check.name)}; names must match ${READINESS_CHECK_NAME}.`,
      );
    }
    const owner = owners.get(check.name);
    if (owner) {
      throw new Error(
        `Runtime module ${JSON.stringify(module.name)} readiness check ` +
          `${JSON.stringify(check.name)} collides with ${owner}.`,
      );
    }
    owners.set(check.name, `runtime module ${JSON.stringify(module.name)}`);
    checks.push(check);
  }

  return checks;
}
