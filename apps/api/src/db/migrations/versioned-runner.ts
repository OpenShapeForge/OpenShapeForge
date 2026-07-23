/**
 * Versioned bespoke migrations: an explicit, ordered registry of hand-written
 * schema transformations, applied between the platform baseline migrations
 * and the generated-schema roll-forward (see ../migration-chain.ts). A
 * bespoke migration can therefore transform the live schema so the generated
 * step's manifest diff becomes additive (or a no-op).
 *
 * Ledger: platform.schema_migrations. Each applied migration records its
 * version and the sha256 of the migration FILE (resolved from the entry's
 * fileUrl, normally `import.meta.url` of the migration module). On later runs
 * an applied version is skipped only if the file still hashes to the recorded
 * checksum — editing an applied migration fails loudly. Scaffold new
 * migrations with `bun run db:migration:new <kebab-name>`.
 *
 * `db` must be a connection-bound Kysely instance (the chain runs inside
 * runtime.db.connection().execute): each up() runs inside an explicit
 * BEGIN/COMMIT together with its ledger insert, and is rolled back as a unit
 * on failure.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import { ensureSchemaMigrationsTable } from "./schema-migrations-table.js";

export type VersionedMigration = {
  /**
   * "NNNN_kebab-name", numbered after the generated baseline
   * (0001_generated_platform_schema), so the first bespoke migration is
   * 0002_*. Numbers must be strictly ascending within the registry.
   */
  version: string;
  /** file: URL of the migration source file, normally `import.meta.url`. */
  fileUrl: string;
  up: (db: Kysely<any>) => Promise<void>;
};

export type VersionedMigrationsResult = {
  applied: string[];
  skipped: string[];
};

const versionPattern = /^(\d{4})_[a-z0-9][a-z0-9-]*$/;

/**
 * Validates registry shape before anything touches the database: version
 * format, numbering after the 0001 generated baseline, and strictly
 * ascending order (which also rejects duplicates).
 */
export function validateVersionedRegistry(
  migrations: readonly VersionedMigration[],
): void {
  let previousNumber = 1; // 0001 is the generated platform-schema baseline.
  let previousVersion = "0001_generated_platform_schema";
  for (const migration of migrations) {
    const match = versionPattern.exec(migration.version);
    const numberText = match?.[1];
    if (numberText === undefined) {
      throw new Error(
        `Versioned migration "${migration.version}" has an invalid version — expected "NNNN_kebab-name" (e.g. "0002_split-address"). Scaffold with: bun run db:migration:new <name>`,
      );
    }
    const number = Number(numberText);
    if (number < 2) {
      throw new Error(
        `Versioned migration "${migration.version}" uses number ${numberText} — 0001 is reserved for the generated baseline; bespoke migrations start at 0002.`,
      );
    }
    if (number <= previousNumber) {
      throw new Error(
        `Versioned migration registry is out of order: "${migration.version}" must be numbered strictly after "${previousVersion}".`,
      );
    }
    previousNumber = number;
    previousVersion = migration.version;
  }
}

async function migrationFileChecksum(
  migration: VersionedMigration,
): Promise<string> {
  let contents: Buffer;
  try {
    contents = await readFile(fileURLToPath(new URL(migration.fileUrl)));
  } catch (error) {
    throw new Error(
      `Versioned migration ${migration.version}: cannot read its source file (${migration.fileUrl}) to checksum it: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return createHash("sha256").update(contents).digest("hex");
}

export async function applyVersionedMigrations(
  db: Kysely<any>,
  migrations: readonly VersionedMigration[],
): Promise<VersionedMigrationsResult> {
  if (migrations.length === 0) {
    // Empty registry: stay a strict no-op (no DDL, no ledger reads).
    return { applied: [], skipped: [] };
  }

  validateVersionedRegistry(migrations);
  await ensureSchemaMigrationsTable(db);

  const versions = migrations.map((migration) => migration.version);
  const ledger = await sql<{ version: string; checksum: string }>`
    select version, checksum
    from platform.schema_migrations
    where version in (${sql.join(versions)})
  `.execute(db);
  const recordedChecksums = new Map(
    ledger.rows.map((row) => [row.version, row.checksum]),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    const fileChecksum = await migrationFileChecksum(migration);
    const recorded = recordedChecksums.get(migration.version);

    if (recorded !== undefined) {
      if (recorded !== fileChecksum) {
        throw new Error(
          `Versioned migration ${migration.version} was applied with checksum ${recorded}, but its file now hashes to ${fileChecksum}. Applied migrations are immutable — revert the edit and create a new migration instead (bun run db:migration:new <name>).`,
        );
      }
      skipped.push(migration.version);
      continue;
    }

    await sql`begin`.execute(db);
    try {
      await migration.up(db);
      await sql`
        insert into platform.schema_migrations (version, checksum, applied_by)
        values (${migration.version}, ${fileChecksum}, ${"apps/api versioned"})
      `.execute(db);
      await sql`commit`.execute(db);
    } catch (error) {
      await sql`rollback`.execute(db);
      throw new Error(
        `Versioned migration ${migration.version} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    applied.push(migration.version);
  }

  return { applied, skipped };
}
