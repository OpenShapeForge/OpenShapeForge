// SPDX-License-Identifier: BUSL-1.1
/**
 * DDL emitted by compiler plugins: constraints, functions, triggers and
 * grants on contributed tables — the invariants the manifest cannot express
 * yet. Applied after the generated step on EVERY run, with no ledger: each
 * entry is idempotent DDL (the compiler renders constraints as name-guarded
 * DO blocks; free-form plugin SQL must be repeatable by contract). The
 * optional generated registry is read at runtime because repositories
 * without plugin schema contributions intentionally have no file to import.
 * The apply function requires a connection-bound Kysely instance because it
 * wraps each entry in its own transaction.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql, type Kysely } from "kysely";

export type GeneratedPluginMigration = {
  plugin: string;
  version: string;
  sql: string;
};

type GeneratedPluginMigrationRegistry = {
  version: 1;
  migrations: GeneratedPluginMigration[];
};

export type PluginMigrationsResult = {
  /** Every entry the run applied, as `plugin:<name>:<version>`, in order. */
  applied: string[];
};

const registryPath = resolve(
  import.meta.dir,
  "../../generated/plugin-migrations/registry.json",
);
const pluginNamePattern = /^[a-z][a-z0-9-]*$/;
const migrationVersionPattern = /^\d{4}_[a-z0-9][a-z0-9-]*$/;

export function pluginMigrationIdentity(
  migration: Pick<GeneratedPluginMigration, "plugin" | "version">,
): string {
  return `plugin:${migration.plugin}:${migration.version}`;
}

function validateRegistry(value: unknown): GeneratedPluginMigration[] {
  const registry = value as Partial<GeneratedPluginMigrationRegistry> | null;
  if (registry?.version !== 1 || !Array.isArray(registry.migrations)) {
    throw new Error("Generated plugin migration registry has an unsupported shape.");
  }
  const seen = new Set<string>();
  let previous: Pick<GeneratedPluginMigration, "plugin" | "version"> | undefined;
  for (const migration of registry.migrations) {
    if (
      !migration ||
      !pluginNamePattern.test(migration.plugin) ||
      !migrationVersionPattern.test(migration.version) ||
      typeof migration.sql !== "string" ||
      migration.sql.trim().length === 0
    ) {
      throw new Error("Generated plugin migration registry contains an invalid entry.");
    }
    const identity = pluginMigrationIdentity(migration);
    if (
      (previous !== undefined &&
        (migration.plugin.localeCompare(previous.plugin) < 0 ||
          (migration.plugin === previous.plugin &&
            migration.version.localeCompare(previous.version) <= 0))) ||
      seen.has(identity)
    ) {
      throw new Error(
        `Generated plugin migration registry is not strictly ordered at ${identity}.`,
      );
    }
    seen.add(identity);
    previous = migration;
  }
  return registry.migrations;
}

export async function loadGeneratedPluginMigrations(
  path = registryPath,
): Promise<GeneratedPluginMigration[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Generated plugin migration registry ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return validateRegistry(parsed);
}

export async function applyGeneratedPluginMigrations(
  db: Kysely<any>,
  migrations: readonly GeneratedPluginMigration[],
): Promise<PluginMigrationsResult> {
  const applied: string[] = [];
  for (const migration of migrations) {
    const identity = pluginMigrationIdentity(migration);
    await sql`begin`.execute(db);
    try {
      await sql.raw(migration.sql).execute(db);
      await sql`commit`.execute(db);
    } catch (error) {
      await sql`rollback`.execute(db);
      throw new Error(
        `Plugin schema migration ${identity} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    applied.push(identity);
  }
  return { applied };
}
