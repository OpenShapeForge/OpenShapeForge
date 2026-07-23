// SPDX-License-Identifier: BUSL-1.1
/**
 * Generated-schema drift detection.
 *
 * The migrator records the applied generated-manifest checksum in
 * platform.schema_migrations under version "0001_generated_platform_schema".
 * After any successful `bun run db:migrate` that row's checksum equals the
 * bundled manifest's checksum. Comparing the recorded checksum against the
 * bundled one tells us whether the connected database matches the code the
 * process is running.
 *
 * platform.schema_migrations is not tenant-scoped and has no RLS, so a plain
 * query works without session GUCs.
 */
import manifest from "../generated/db/manifest.json" with { type: "json" };
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "./connection.js";

/** Version key of the generated-schema row in platform.schema_migrations. */
export const GENERATED_SCHEMA_MIGRATION_VERSION = "0001_generated_platform_schema";

export type GeneratedSchemaDriftStatus = "ok" | "behind" | "unmigrated";

export type GeneratedSchemaDriftResult = {
  /**
   * - "ok": recorded checksum equals the bundled manifest checksum.
   * - "behind": a generated-schema row exists but its checksum differs from
   *   the bundled manifest (the DB was migrated against older/other code).
   * - "unmigrated": platform.schema_migrations does not exist, or it has no
   *   generated-schema row (fresh database).
   */
  status: GeneratedSchemaDriftStatus;
  recordedChecksum: string | null;
  bundledChecksum: string;
};

/**
 * True for Postgres undefined_table (42P01) and, defensively, missing-schema
 * (3F000) errors. Bun's SQL driver reports the SQLSTATE in `errno` (with
 * `code` set to "ERR_POSTGRES_SERVER_ERROR"); other drivers put it in `code`.
 */
function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; errno?: unknown };
  const sqlstates = new Set(["42P01", "3F000"]);
  return (
    (typeof candidate.errno === "string" && sqlstates.has(candidate.errno)) ||
    (typeof candidate.code === "string" && sqlstates.has(candidate.code))
  );
}

/**
 * Compare the applied generated-schema checksum in the connected database
 * against the manifest bundled with this build. Single fast query; throws on
 * connection/unknown errors (a missing table is handled, not thrown).
 */
export async function checkGeneratedSchemaDrift(
  db: OpenShapeForgeDatabase,
): Promise<GeneratedSchemaDriftResult> {
  const bundledChecksum = manifest.checksum;

  let rows: { checksum: string | null }[];
  try {
    const result = await sql<{ checksum: string | null }>`
      select checksum
      from platform.schema_migrations
      where version = ${GENERATED_SCHEMA_MIGRATION_VERSION}
    `.execute(db);
    rows = result.rows;
  } catch (error) {
    if (isMissingRelationError(error)) {
      return { status: "unmigrated", recordedChecksum: null, bundledChecksum };
    }
    throw error;
  }

  const row = rows[0];
  if (row === undefined) {
    return { status: "unmigrated", recordedChecksum: null, bundledChecksum };
  }

  const recordedChecksum = row.checksum ?? null;
  if (recordedChecksum !== bundledChecksum) {
    return { status: "behind", recordedChecksum, bundledChecksum };
  }
  return { status: "ok", recordedChecksum, bundledChecksum };
}
