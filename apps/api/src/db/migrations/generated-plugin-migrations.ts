// SPDX-License-Identifier: BUSL-1.1
/**
 * Immutable DDL emitted by compiler plugins. The optional generated registry
 * is read at runtime because repositories without plugin schema contributions
 * intentionally have no file to import.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import { ensureSchemaMigrationsTable } from "./schema-migrations-table.js";

export type GeneratedPluginMigration = {
  plugin: string;
  version: string;
  checksum: string;
  sql: string;
};

type GeneratedPluginMigrationRegistry = {
  version: 1;
  migrations: GeneratedPluginMigration[];
};

export type PluginMigrationLedgerStatus = {
  ready: boolean;
  missing: string[];
  mismatched: string[];
  unexpected: string[];
};

export type PluginMigrationsResult = {
  applied: string[];
  skipped: string[];
};

const registryPath = resolve(
  import.meta.dir,
  "../../generated/plugin-migrations/registry.json",
);
const pluginNamePattern = /^[a-z][a-z0-9-]*$/;
const migrationVersionPattern = /^\d{4}_[a-z0-9][a-z0-9-]*$/;

export function pluginMigrationLedgerVersion(
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
  let previous = "";
  for (const migration of registry.migrations) {
    if (
      !migration ||
      !pluginNamePattern.test(migration.plugin) ||
      !migrationVersionPattern.test(migration.version) ||
      typeof migration.sql !== "string" ||
      migration.sql.trim().length === 0 ||
      typeof migration.checksum !== "string"
    ) {
      throw new Error("Generated plugin migration registry contains an invalid entry.");
    }
    const identity = pluginMigrationLedgerVersion(migration);
    if (identity.localeCompare(previous) <= 0 || seen.has(identity)) {
      throw new Error(
        `Generated plugin migration registry is not strictly ordered at ${identity}.`,
      );
    }
    const actual = createHash("sha256").update(migration.sql).digest("hex");
    if (migration.checksum !== actual) {
      throw new Error(
        `Generated plugin migration ${identity} has checksum ${migration.checksum}, but its SQL hashes to ${actual}. Regenerate artifacts.`,
      );
    }
    seen.add(identity);
    previous = identity;
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
  return validateRegistry(JSON.parse(contents));
}

async function readPluginLedger(db: Kysely<any>) {
  const ledger = await sql<{ version: string; checksum: string }>`
    select version, checksum
    from platform.schema_migrations
    where version like 'plugin:%'
  `.execute(db);
  return new Map(ledger.rows.map((row) => [row.version, row.checksum]));
}

export async function verifyPluginMigrationLedger(
  db: Kysely<any>,
  migrations: readonly GeneratedPluginMigration[],
): Promise<PluginMigrationLedgerStatus> {
  const recorded = await readPluginLedger(db);
  const expected = new Map(
    migrations.map((migration) => [pluginMigrationLedgerVersion(migration), migration]),
  );
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [identity, migration] of expected) {
    const checksum = recorded.get(identity);
    if (checksum === undefined) missing.push(identity);
    else if (checksum !== migration.checksum) mismatched.push(identity);
  }
  const unexpected = [...recorded.keys()]
    .filter((identity) => !expected.has(identity))
    .sort();
  return {
    ready:
      missing.length === 0 &&
      mismatched.length === 0 &&
      unexpected.length === 0,
    missing,
    mismatched,
    unexpected,
  };
}

export function createPluginMigrationLedgerVerifier(
  migrations: Promise<readonly GeneratedPluginMigration[]> =
    loadGeneratedPluginMigrations(),
) {
  return async (db: Kysely<any>) =>
    verifyPluginMigrationLedger(db, await migrations);
}

export async function applyGeneratedPluginMigrations(
  db: Kysely<any>,
  migrations: readonly GeneratedPluginMigration[],
  appliedBy = "apps/api plugin migrations",
): Promise<PluginMigrationsResult> {
  await ensureSchemaMigrationsTable(db);
  const status = await verifyPluginMigrationLedger(db, migrations);
  if (status.unexpected.length > 0) {
    throw new Error(
      `Applied plugin schema migration(s) disappeared from the generated registry: ${status.unexpected.join(", ")}. Restore the contribution; applied migrations are immutable.`,
    );
  }
  if (status.mismatched.length > 0) {
    throw new Error(
      `Applied plugin schema migration checksum mismatch: ${status.mismatched.join(", ")}. Restore the applied SQL and add a new migration instead.`,
    );
  }

  const missing = new Set(status.missing);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of migrations) {
    const identity = pluginMigrationLedgerVersion(migration);
    if (!missing.has(identity)) {
      skipped.push(identity);
      continue;
    }
    await sql`begin`.execute(db);
    try {
      await sql.raw(migration.sql).execute(db);
      await sql`
        insert into platform.schema_migrations (version, checksum, applied_by)
        values (${identity}, ${migration.checksum}, ${appliedBy})
      `.execute(db);
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
  return { applied, skipped };
}
