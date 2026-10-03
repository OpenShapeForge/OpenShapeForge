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
 * A differing checksum on its own does not say whether the database is
 * empty, built from another manifest, or another branch's altogether, and
 * each has its own next command. `findUndeclaredDatabaseSchema` and
 * `describeGeneratedSchemaDrift` answer that so callers can print a
 * remediation that works: see the comment on `describeGeneratedSchemaDrift`.
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

/** The slice of a manifest table findUndeclaredDatabaseSchema reads. */
export type UndeclaredSchemaManifestTable = {
  name: string;
  schema: string;
  columns: { name: string }[];
};

/**
 * Find schema the database has and this branch does not declare.
 *
 * The checksum says the database and the code differ; this says which way.
 * Both directions end in `db:reset`, but a database carrying schema this
 * branch never declared is a *shared* database another worktree built, and
 * the honest remedy there is a scratch database rather than destroying what
 * the other branch is using.
 *
 * Only schemas the manifest covers are examined, so unrelated schemas on the
 * same database are never mistaken for drift. Within those schemas there is
 * no exemption list: every table and every column is manifest-declared, so
 * anything else is foreign.
 *
 * Two catalog queries, no row probes; safe to run as the restricted runtime
 * role. A missing schema is not an error here — information_schema simply
 * returns nothing.
 *
 * `declaredTables` defaults to the bundled manifest; it is a parameter so
 * tests can exercise the classification against a purpose-built schema.
 * Production callers never pass it.
 */
/**
 * Every base table in a manifest-covered schema, declared or not, sorted.
 * "Empty" for the build path means this list is empty: a declared table
 * without a generated-schema row is a leftover of a build the chain cannot
 * vouch for, and `CREATE IF NOT EXISTS` over it would stamp a checksum onto
 * a database nobody has verified.
 */
export async function findLiveManifestSchemaTables(
  db: OpenShapeForgeDatabase,
  declaredTables: readonly UndeclaredSchemaManifestTable[] = manifest.tables as
    UndeclaredSchemaManifestTable[],
): Promise<string[]> {
  const schemas = [...new Set(declaredTables.map((table) => table.schema))];
  if (schemas.length === 0) return [];
  const rows = (
    await sql<{ table_schema: string; table_name: string }>`
      select table_schema, table_name
      from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema in (${sql.join(schemas)})
      order by table_schema, table_name
    `.execute(db)
  ).rows;
  return rows.map((row) => `${row.table_schema}.${row.table_name}`);
}

export async function findUndeclaredDatabaseSchema(
  db: OpenShapeForgeDatabase,
  declaredTables: readonly UndeclaredSchemaManifestTable[] = manifest.tables as
    UndeclaredSchemaManifestTable[],
): Promise<UndeclaredDatabaseSchema> {
  const manifestTables = declaredTables;
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
    if (!declaredColumnsByTable.has(name)) {
      tables.push(name);
    }
  }

  const columns: string[] = [];
  for (const row of liveColumns) {
    const name = `${row.table_schema}.${row.table_name}`;
    // Columns of an undeclared table are already covered by the table entry.
    const declared = declaredColumnsByTable.get(name);
    if (declared === undefined) {
      continue;
    }
    if (!declared.has(row.column_name)) {
      columns.push(`${name}.${row.column_name}`);
    }
  }

  return { tables, columns };
}

/**
 * - "migrate": the database is empty; `db:migrate` builds it.
 * - "reset": the database was built from another manifest, or has tables
 *   but no generated-schema record, and nothing in it is foreign to this
 *   branch. A built database is never changed in place, so `db:reset` (or
 *   a scratch database) is the fix.
 * - "foreign-schema": the database carries schema this branch does not
 *   declare — a shared database another worktree built. The same reset, but
 *   the honest suggestion is a scratch database.
 */
export type SchemaDriftRemediationKind = "migrate" | "reset" | "foreign-schema";

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
const RESET_RECIPE =
  '  OPENSHAPEFORGE_RESET_DATABASE_CONFIRMATION="${DATABASE_URL##*/}" bun run db:reset';

const SCRATCH_DATABASE_RECIPE = [
  '  ADMIN="${OPENSHAPEFORGE_MIGRATE_DATABASE_URL:-$DATABASE_URL}"',
  "  psql \"${ADMIN%/*}/postgres\" -c 'create database openshapeforge_e2e'",
  '  OPENSHAPEFORGE_MIGRATE_DATABASE_URL="${ADMIN%/*}/openshapeforge_e2e" bun run db:migrate',
  '  DATABASE_URL="${DATABASE_URL%/*}/openshapeforge_e2e" bun run test:e2e',
];

/**
 * Turn a drift result plus the undeclared-schema probe into the remediation to
 * print. Pure: the branching lives here, separate from the queries, so the
 * choice between "build it", "rebuild it" and "this database belongs to
 * another branch" is testable without arranging a real drifted database.
 *
 * Two questions. Does the database contain schema this branch does not
 * declare? Then it is someone else's build and a scratch database is the
 * remedy that leaves them alone. Otherwise: is there a build at all? An empty
 * database is built by `db:migrate`; a built one whose checksum differs is
 * rebuilt by `db:reset`, because nothing rolls a built database forward.
 */
export function describeGeneratedSchemaDrift(
  drift: GeneratedSchemaDriftResult,
  undeclared: UndeclaredDatabaseSchema,
  options: {
    databaseName?: string | null;
    /**
     * Every live table in a manifest-covered schema
     * (`findLiveManifestSchemaTables`), for an "unmigrated" database: with
     * any present, the chain refuses to build rather than adopt them, so the
     * remedy is a reset, not `db:migrate`.
     */
    liveTables?: readonly string[];
  } = {},
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
        "`bun run db:migrate` cannot fix this and refuses it whatever the checksum",
        "says: nothing is dropped or altered in place. This is what a database shared between git worktrees",
        "looks like once another branch — one that declares more than this one — has",
        "built it. It is not a regression in the branch under test.",
        "",
        "Run the suite against a scratch database (reuses the connection strings you",
        "already have, without echoing them here):",
        ...SCRATCH_DATABASE_RECIPE,
        "",
        "Or rebuild the shared database from this branch's manifest, destroying its",
        "data — and only until the next worktree rebuilds it:",
        RESET_RECIPE,
      ].join("\n"),
    };
  }

  const leftovers = options.liveTables ?? [];
  if (drift.status === "unmigrated" && leftovers.length > 0) {
    return {
      kind: "reset",
      message: [
        `Generated schema drift detected (status: "${drift.status}"): ${database} has no recorded generated-schema migration but is not empty.`,
        ...checksums,
        "",
        "Tables already present in a manifest-covered schema:",
        ...listUndeclared("table", [...leftovers]),
        "",
        "`bun run db:migrate` builds an empty database only and refuses this one:",
        "adopting these tables would stamp the checksum onto a build nobody verified.",
        "Rebuild it from this branch's manifest, destroying its data:",
        RESET_RECIPE,
        "",
        "Or leave the shared database alone entirely and run against a scratch one:",
        ...SCRATCH_DATABASE_RECIPE,
      ].join("\n"),
    };
  }

  if (drift.status === "unmigrated") {
    return {
      kind: "migrate",
      message: [
        `Generated schema drift detected (status: "${drift.status}"): ${database} has no recorded generated-schema migration.`,
        ...checksums,
        "",
        "Nothing in the database is outside this branch's manifest, so building it",
        "is the fix:",
        "  bun run db:migrate",
        "",
        "To leave the shared database alone entirely, run against a scratch one:",
        ...SCRATCH_DATABASE_RECIPE,
      ].join("\n"),
    };
  }

  return {
    kind: "reset",
    message: [
      `Generated schema drift detected (status: "${drift.status}"): ${database} was built from another manifest.`,
      ...checksums,
      "",
      "A built database is never changed in place — `bun run db:migrate` refuses a",
      "checksum mismatch — so rebuild it from this branch's manifest, destroying",
      "its data:",
      RESET_RECIPE,
      "",
      "Or leave the shared database alone entirely and run against a scratch one:",
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
