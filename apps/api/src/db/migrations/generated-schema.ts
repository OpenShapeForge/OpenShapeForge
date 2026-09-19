// SPDX-License-Identifier: BUSL-1.1
/**
 * The generated-schema step of the migrate chain, in the reset model.
 *
 * The applied generated-manifest checksum is recorded in
 * platform.schema_migrations under version "0001_generated_platform_schema".
 * On every run:
 *
 * - no row, and no table in any manifest-covered schema -> build: apply
 *   schema.sql, record the checksum.
 * - no row, but tables in a covered schema -> refuse. schema.sql is
 *   CREATE IF NOT EXISTS throughout, so applying it over leftovers would
 *   stamp the checksum onto a database nobody verified.
 * - checksum equal, nothing undeclared -> no-op; the idempotent invariants
 *   that follow still run.
 * - checksum equal, but an undeclared table or column -> refuse: one
 *   declared source of truth per table, whatever the checksum says.
 * - checksum differs -> refuse. A database is built from the manifest and
 *   never transformed in place: the remediation is `bun run db:reset`.
 *
 * `db` must be a connection-bound Kysely instance (migrate.ts runs the chain
 * inside runtime.db.connection().execute): the install uses explicit
 * BEGIN/COMMIT so the DDL and the checksum row land atomically.
 */
import { readFile } from "node:fs/promises";
import { sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";
import {
  findLiveManifestSchemaTables,
  findUndeclaredDatabaseSchema,
} from "../schema-drift.js";

export const generatedSchemaMigrationVersion = "0001_generated_platform_schema";

export type GeneratedSchemaMigrationResult = {
  version: string;
  checksum: string;
  applied: boolean;
};

async function readGeneratedSchemaSql() {
  return readFile(
    new URL("../../generated/db/schema.sql", import.meta.url),
    "utf8",
  );
}

/**
 * The refusal for a built database whose recorded checksum is not the
 * bundled manifest's. Exported so the tests can assert the exact remediation
 * a developer is shown.
 */
export function checksumMismatchError(recordedChecksum: string): Error {
  return new Error(
    [
      `Generated schema checksum mismatch: the database was built from manifest ${recordedChecksum}, this build carries ${manifest.checksum}.`,
      "",
      `The schema is versioned by git and a database is built from the manifest, never migrated in place. ${RESET_REMEDIATION}`,
    ].join("\n"),
  );
}

const RESET_REMEDIATION =
  "Rebuild it: `bun run db:reset` drops and recreates the database (destroying every row) and runs this chain on the empty result. To leave this database alone, build a scratch one instead (docs/testing.md, \"One Postgres, many worktrees\").";

/**
 * The refusal for a database with no generated-schema row that is not empty
 * (`leftovers`), or for a built one carrying objects the manifest does not
 * declare (`undeclared`). Neither is something to build over.
 */
export function foreignSchemaError(
  status: "unmigrated" | "built",
  objects: { tables: string[]; columns: string[] },
): Error {
  const list = [
    ...objects.tables.map((name) => `  - table  ${name}`),
    ...objects.columns.map((name) => `  - column ${name}`),
  ];
  return new Error(
    [
      status === "unmigrated"
        ? "Generated schema cannot be built: the database has no generated-schema record but is not empty."
        : "Generated schema refused: the database carries schema the manifest does not declare.",
      "",
      status === "unmigrated"
        ? "Tables already present in a manifest-covered schema:"
        : "Present in the database, absent from the manifest:",
      ...list,
      "",
      `A database is built from the manifest on an empty database only; nothing is dropped or altered in place. ${RESET_REMEDIATION}`,
    ].join("\n"),
  );
}

/**
 * The generated-schema ledger row, or undefined on a database that has never
 * been migrated. platform.schema_migrations is itself a manifest table, so on
 * an empty database it does not exist until schema.sql runs below — probed
 * rather than pre-created, so the manifest stays its only declaration.
 */
async function readRecordedChecksum(
  db: OpenShapeForgeDatabase,
): Promise<{ checksum: string } | undefined> {
  const ledger = await sql<{ present: boolean }>`
    select to_regclass('platform.schema_migrations') is not null as present
  `.execute(db);
  if (!ledger.rows[0]?.present) return undefined;
  return db
    .selectFrom("platform.schema_migrations")
    .select(["checksum"])
    .where("version", "=", generatedSchemaMigrationVersion)
    .executeTakeFirst();
}

export async function applyGeneratedSchemaMigration(
  db: OpenShapeForgeDatabase,
  appliedBy = "apps/api",
): Promise<GeneratedSchemaMigrationResult> {
  const existing = await readRecordedChecksum(db);

  if (existing === undefined) {
    const leftovers = await findLiveManifestSchemaTables(db);
    if (leftovers.length > 0) {
      throw foreignSchemaError("unmigrated", { tables: leftovers, columns: [] });
    }
    const schemaSql = await readGeneratedSchemaSql();
    await sql`begin`.execute(db);
    try {
      await sql.raw(schemaSql).execute(db);
      await db
        .insertInto("platform.schema_migrations")
        .values({
          version: generatedSchemaMigrationVersion,
          checksum: manifest.checksum,
          applied_by: appliedBy,
        })
        .execute();
      await sql`commit`.execute(db);
    } catch (error) {
      await sql`rollback`.execute(db);
      throw error;
    }

    return {
      version: generatedSchemaMigrationVersion,
      checksum: manifest.checksum,
      applied: true,
    };
  }

  if (existing.checksum !== manifest.checksum) {
    throw checksumMismatchError(existing.checksum);
  }

  const undeclared = await findUndeclaredDatabaseSchema(db);
  if (undeclared.tables.length > 0 || undeclared.columns.length > 0) {
    throw foreignSchemaError("built", undeclared);
  }

  return {
    version: generatedSchemaMigrationVersion,
    checksum: manifest.checksum,
    applied: false,
  };
}
