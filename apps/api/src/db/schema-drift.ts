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
 *
 * A differing checksum on its own does not say WHICH WAY the two have parted,
 * and the two directions have opposite remedies. `findUndeclaredDatabaseSchema`
 * and `describeGeneratedSchemaDrift` answer that second question so callers can
 * print a remediation that works: see the comment on
 * `describeGeneratedSchemaDrift`.
 */
import manifest from "../generated/db/manifest.json" with { type: "json" };
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "./connection.js";
import { nonManifestManagedTables } from "./migrations/generated-schema.js";

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

// ---------------------------------------------------------------------------
// Which way did it drift: is the database behind, or is it another branch's?
// ---------------------------------------------------------------------------

/**
 * Schema objects that exist in the connected database but that this branch's
 * manifest does not declare. Both lists are qualified and sorted.
 */
export type UndeclaredDatabaseSchema = {
  /** e.g. "platform.api_keys". */
  tables: string[];
  /** e.g. "erp.relations.notes" — on a table the manifest DOES declare. */
  columns: string[];
};

/**
 * Find schema the database has and this branch does not declare.
 *
 * This is the direction the checksum comparison cannot tell you and the one
 * that decides whether `bun run db:migrate` is worth running at all. The
 * migrator rolls a database FORWARD: it adds what the manifest declares and
 * the database lacks. It has no way to remove a table or a column, so when the
 * database is *ahead* — a shared database that another worktree migrated
 * against a branch declaring more entities than this one — migrate refuses,
 * correctly, and rerunning it will keep refusing.
 *
 * Only schemas the manifest covers are examined, so unrelated schemas on the
 * same database are never mistaken for drift. `nonManifestManagedTables` is
 * exempt for the same reason the migrator exempts it: those tables come from
 * dedicated migrations, not from the manifest.
 *
 * Two catalog queries, no row probes; safe to run as the restricted runtime
 * role. A missing schema is not an error here — information_schema simply
 * returns nothing.
 */
export async function findUndeclaredDatabaseSchema(
  db: OpenShapeForgeDatabase,
): Promise<UndeclaredDatabaseSchema> {
  const manifestTables = manifest.tables as {
    name: string;
    schema: string;
    columns: { name: string }[];
  }[];
  const schemas = [...new Set(manifestTables.map((table) => table.schema))];
  if (schemas.length === 0) {
    return { tables: [], columns: [] };
  }

  const declaredColumnsByTable = new Map(
    manifestTables.map((table) => [
      table.name,
      new Set(table.columns.map((column) => column.name)),
    ]),
  );

  const liveTables = (
    await sql<{ table_schema: string; table_name: string }>`
      select table_schema, table_name
      from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema in (${sql.join(schemas)})
      order by table_schema, table_name
    `.execute(db)
  ).rows;

  const liveColumns = (
    await sql<{ table_schema: string; table_name: string; column_name: string }>`
      select table_schema, table_name, column_name
      from information_schema.columns
      where table_schema in (${sql.join(schemas)})
      order by table_schema, table_name, column_name
    `.execute(db)
  ).rows;

  const tables: string[] = [];
  for (const row of liveTables) {
    const name = `${row.table_schema}.${row.table_name}`;
    if (!declaredColumnsByTable.has(name) && !nonManifestManagedTables.has(name)) {
      tables.push(name);
    }
  }

  const columns: string[] = [];
  for (const row of liveColumns) {
    const name = `${row.table_schema}.${row.table_name}`;
    // Columns of an undeclared table are already covered by the table entry.
    const declared = declaredColumnsByTable.get(name);
    if (declared === undefined || nonManifestManagedTables.has(name)) {
      continue;
    }
    if (!declared.has(row.column_name)) {
      columns.push(`${name}.${row.column_name}`);
    }
  }

  return { tables, columns };
}

/**
 * - "migrate": the database is behind the manifest and nothing in it is
 *   foreign to this branch. Rolling forward is the fix.
 * - "foreign-schema": the database carries schema this branch does not
 *   declare. Rolling forward cannot remove it, so migrate is a no-op at best.
 */
export type SchemaDriftRemediationKind = "migrate" | "foreign-schema";

export type SchemaDriftRemediation = {
  kind: SchemaDriftRemediationKind;
  /** Ready to throw: diagnosis, evidence, and the next command to run. */
  message: string;
};

/** Longest list of undeclared objects spelled out before eliding the rest. */
const MAX_LISTED_UNDECLARED = 10;

function listUndeclared(noun: "table" | "column", names: string[]): string[] {
  // Pad "table" so the qualified names line up under either heading.
  const label = noun === "table" ? "table " : "column";
  const shown = names.slice(0, MAX_LISTED_UNDECLARED);
  const lines = shown.map((name) => `  - ${label} ${name}`);
  if (names.length > shown.length) {
    lines.push(`  - … and ${names.length - shown.length} more ${noun}s`);
  }
  return lines;
}

/**
 * The shell recipe for pointing this suite at a throwaway database. Written as
 * parameter expansions over the caller's own connection strings, so it is
 * copy-pasteable without this message ever echoing a password.
 *
 * Creating and migrating need the privileged role and the suite itself should
 * keep running as whatever DATABASE_URL names (the restricted role, if RLS is
 * being exercised for real), so the two URLs are carried separately rather
 * than one being reused for both.
 */
const SCRATCH_DATABASE_RECIPE = [
  '  ADMIN="${OPENSHAPEFORGE_MIGRATE_DATABASE_URL:-$DATABASE_URL}"',
  "  psql \"${ADMIN%/*}/postgres\" -c 'create database openshapeforge_e2e'",
  '  OPENSHAPEFORGE_MIGRATE_DATABASE_URL="${ADMIN%/*}/openshapeforge_e2e" bun run db:migrate',
  '  DATABASE_URL="${DATABASE_URL%/*}/openshapeforge_e2e" bun run test:e2e',
];

/**
 * Turn a drift result plus the undeclared-schema probe into the remediation to
 * print. Pure: the branching lives here, separate from the queries, so the
 * choice between "run db:migrate" and "this database belongs to another
 * branch" is testable without arranging a real drifted database.
 *
 * The rule is one question — does the database contain schema this branch does
 * not declare? If yes, migrate cannot help however many times it is run, and
 * saying "run db:migrate" sends the reader down a road with no end. If no, the
 * database is genuinely behind and migrate is the fix. (Migrate can still
 * refuse for a *declared* object whose type, nullability or default differs;
 * it prints that difference exactly, so pointing at it stays honest.)
 */
export function describeGeneratedSchemaDrift(
  drift: GeneratedSchemaDriftResult,
  undeclared: UndeclaredDatabaseSchema,
  options: { databaseName?: string | null } = {},
): SchemaDriftRemediation {
  const database =
    options.databaseName === undefined || options.databaseName === null
      ? "the database"
      : `database "${options.databaseName}"`;
  const checksums = [
    `  recorded checksum: ${drift.recordedChecksum ?? "<none>"}`,
    `  bundled checksum:  ${drift.bundledChecksum}`,
  ];

  const foreign = undeclared.tables.length > 0 || undeclared.columns.length > 0;
  if (foreign) {
    return {
      kind: "foreign-schema",
      message: [
        `Generated schema drift detected (status: "${drift.status}"): ${database} carries schema this branch does not declare.`,
        ...checksums,
        "",
        "Present in the database, absent from this branch's manifest:",
        ...listUndeclared("table", undeclared.tables),
        ...listUndeclared("column", undeclared.columns),
        "",
        "`bun run db:migrate` cannot fix this and will refuse: dropping a table or",
        "column is non-additive. This is what a database shared between git worktrees",
        "looks like once another branch — one that declares more than this one — has",
        "migrated it. It is not a regression in the branch under test.",
        "",
        "Run the suite against a scratch database (reuses the connection strings you",
        "already have, without echoing them here):",
        ...SCRATCH_DATABASE_RECIPE,
        "",
        "Or recreate the shared database, destroying its data — and only until the",
        "next worktree migrates it:",
        '  ADMIN="${OPENSHAPEFORGE_MIGRATE_DATABASE_URL:-$DATABASE_URL}"; DB="${DATABASE_URL##*/}"',
        '  psql "${ADMIN%/*}/postgres" -c "drop database \\"$DB\\" with (force)" -c "create database \\"$DB\\""',
        "  bun run db:migrate",
      ].join("\n"),
    };
  }

  const diagnosis =
    drift.status === "unmigrated"
      ? `${database} has no recorded generated-schema migration.`
      : `${database} is behind the bundled manifest.`;
  return {
    kind: "migrate",
    message: [
      `Generated schema drift detected (status: "${drift.status}"): ${diagnosis}`,
      ...checksums,
      "",
      "Nothing in the database is outside this branch's manifest, so rolling it",
      "forward is the fix:",
      "  bun run db:migrate",
      "",
      "If db:migrate then refuses, it names the exact non-additive difference. To",
      "leave the shared database alone entirely, run against a scratch one:",
      ...SCRATCH_DATABASE_RECIPE,
    ].join("\n"),
  };
}

/**
 * Database name out of a connection URL, for naming the offender in the drift
 * message. Never returns any other part of the URL, so a password in
 * DATABASE_URL cannot reach the message. Null when the URL is absent or
 * unparseable — the message then says "the database".
 */
export function databaseNameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const name = new URL(url).pathname.replace(/^\//, "");
    return name.length === 0 ? null : name;
  } catch {
    return null;
  }
}
