// SPDX-License-Identifier: BUSL-1.1
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
 * The one sanctioned exception is `supersededChecksums`: a hash the file used
 * to have, for an edit that provably could not change what the migration did.
 * A file hash cannot tell a licence header from a DDL change, so that
 * judgement is recorded in code and reviewed in a PR rather than inferred. A
 * recorded checksum listed there is reconciled to the current one — once, in
 * the ledger — and every other mismatch still fails. See `VersionedMigration`.
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
  /**
   * Checksums this file was previously recorded under, listed only for edits
   * that CANNOT have changed what the migration did — a licence header, a
   * comment, a formatting sweep. An environment holding one of these is
   * reconciled to the current checksum instead of being wedged.
   *
   * This is not an escape hatch for changing an applied migration. If the SQL,
   * the order of statements, or anything else the database observes changed,
   * the correct answer is still a new migration: the ledger cannot re-run this
   * one, so a reconciled checksum would assert an effect that never happened.
   * Deciding a diff is inert is a review judgement — make it in a PR, and say
   * in a comment which commit caused it.
   */
  supersededChecksums?: readonly string[];
};

export type VersionedMigrationsResult = {
  applied: string[];
  skipped: string[];
  /** Applied versions whose ledger checksum was updated to the current file. */
  reconciled: string[];
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

export type VersionedMigrationLedgerStatus = {
  ready: boolean;
  missing: string[];
  mismatched: string[];
  unexpected: string[];
};

/** Read-only readiness check for the complete immutable migration registry. */
export async function verifyVersionedMigrationLedger(
  db: Kysely<any>,
  migrations: readonly VersionedMigration[],
): Promise<VersionedMigrationLedgerStatus> {
  if (migrations.length > 0) validateVersionedRegistry(migrations);
  const ledger = await sql<{ version: string; checksum: string | null }>`
    select version, checksum
    from platform.schema_migrations
  `.execute(db);
  const recorded = new Map(ledger.rows.map((row) => [row.version, row.checksum]));
  const expected = new Set(migrations.map((migration) => migration.version));
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const migration of migrations) {
    const checksum = recorded.get(migration.version);
    if (checksum === undefined) {
      missing.push(migration.version);
    } else if (checksum !== await migrationFileChecksum(migration)) {
      mismatched.push(migration.version);
    }
  }
  const unexpected = ledger.rows
    .map((row) => row.version)
    .filter((version) => /^\d{4}_/.test(version))
    .filter((version) => version !== "0001_generated_platform_schema")
    .filter((version) => !expected.has(version))
    .sort();
  return {
    ready: missing.length === 0 && mismatched.length === 0 && unexpected.length === 0,
    missing,
    mismatched,
    unexpected,
  };
}

export async function applyVersionedMigrations(
  db: Kysely<any>,
  migrations: readonly VersionedMigration[],
): Promise<VersionedMigrationsResult> {
  if (migrations.length === 0) {
    // Empty registry: stay a strict no-op (no DDL, no ledger reads).
    return { applied: [], skipped: [], reconciled: [] };
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
  const reconciled: string[] = [];

  for (const migration of migrations) {
    const fileChecksum = await migrationFileChecksum(migration);
    const recorded = recordedChecksums.get(migration.version);

    if (recorded !== undefined) {
      if (recorded !== fileChecksum) {
        if (!migration.supersededChecksums?.includes(recorded)) {
          throw new Error(
            `Versioned migration ${migration.version} was applied with checksum ${recorded}, but its file now hashes to ${fileChecksum}. Applied migrations are immutable — revert the edit and create a new migration instead (bun run db:migration:new <name>). If the edit provably cannot have changed what this migration did, record ${recorded} in its supersededChecksums instead.`,
          );
        }
        // Reconcile once, so the next run takes the plain skip path and the
        // superseded entry becomes inert rather than permanently load-bearing.
        await sql`
          update platform.schema_migrations
          set checksum = ${fileChecksum}
          where version = ${migration.version} and checksum = ${recorded}
        `.execute(db);
        reconciled.push(migration.version);
        continue;
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

  return { applied, skipped, reconciled };
}
