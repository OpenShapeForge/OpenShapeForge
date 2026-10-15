// SPDX-License-Identifier: BUSL-1.1
/**
 * The generated-schema step of the migrate chain: build, no-op, roll forward
 * or refuse.
 *
 * The applied generated-manifest checksum is recorded in
 * platform.schema_migrations under version "0001_generated_platform_schema".
 * On every run:
 *
 * - no row, and no table in any manifest-covered schema -> build: apply
 *   schema.sql, record the checksum and the versioned-migration baseline in
 *   the same transaction.
 * - no row, but tables in a covered schema -> refuse. schema.sql is
 *   CREATE IF NOT EXISTS throughout, so applying it over leftovers would
 *   stamp the checksum onto a database nobody verified.
 * - checksum equal, nothing undeclared -> no-op; the idempotent invariants
 *   that follow still run.
 * - checksum equal, but an undeclared table or column -> refuse: one
 *   declared source of truth per table, whatever the checksum says.
 * - checksum differs -> diff the bundled manifest against the live
 *   information_schema. Purely ADDITIVE drift (new tables, new columns
 *   Postgres can add without a backfill) is applied: ADD COLUMN for the
 *   missing columns, then the full idempotent schema.sql (new tables,
 *   indexes, refreshed RLS policies, guarded foreign keys), then the
 *   recorded checksum rolls forward — all in one transaction. NON-additive
 *   drift (a dropped, renamed or retyped column, a table no longer declared,
 *   a required column with no default on a populated table, a changed
 *   default or nullability) is refused with the exact listing: a versioned
 *   migration (`bun run db:migration:new`) transforms the database first, or
 *   — for a disposable development database only — `bun run db:reset`
 *   rebuilds it.
 *
 * What the diff compares is tables and columns. A changed index, generated
 * policy expression or foreign-key column set under an existing name is not
 * detected: schema.sql guards those by name. Such a change needs a versioned
 * migration that drops the old object so the roll-forward re-creates it.
 *
 * `db` must be a connection-bound Kysely instance (migrate.ts runs the chain
 * inside runtime.db.connection().execute): the build and the roll-forward use
 * explicit BEGIN/COMMIT so the DDL and the ledger rows land atomically.
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

export type GeneratedSchemaRollForwardSummary = {
  /** Qualified names ("erp.relations") of tables created by the roll-forward. */
  addedTables: string[];
  /** Qualified column names ("erp.relations.notes") added by the roll-forward. */
  addedColumns: string[];
};

export type GeneratedSchemaMigrationResult = {
  version: string;
  checksum: string;
  /** True when this run built the database or rolled it forward. */
  applied: boolean;
  /** True when this run built an empty database from the manifest. */
  built?: boolean;
  rollForward?: GeneratedSchemaRollForwardSummary;
};

export type ManifestColumn = {
  name: string;
  type: string;
  required: boolean;
  primaryKey: boolean;
  generated: string | null;
  /** Verbatim SQL default expression, when the compiler records one. */
  default?: string;
};

export type ManifestTable = {
  /** Qualified name, e.g. "erp.relations". */
  name: string;
  schema: string;
  table: string;
  columns: ManifestColumn[];
};

const manifestTables = manifest.tables as unknown as ManifestTable[];

/**
 * Manifest scalar type -> information_schema.columns (data_type, udt_name).
 * Anything not in this map is classified as non-additive drift rather than
 * guessed at.
 */
const informationSchemaType: Record<string, { dataType: string; udtName?: string }> = {
  text: { dataType: "text" },
  "text[]": { dataType: "ARRAY", udtName: "_text" },
  uuid: { dataType: "uuid" },
  timestamptz: { dataType: "timestamp with time zone" },
  jsonb: { dataType: "jsonb" },
  integer: { dataType: "integer" },
  bigint: { dataType: "bigint" },
  numeric: { dataType: "numeric" },
  boolean: { dataType: "boolean" },
  date: { dataType: "date" },
};

async function readGeneratedSchemaSql() {
  return readFile(
    new URL("../../generated/db/schema.sql", import.meta.url),
    "utf8",
  );
}

function quoteIdent(value: string): string {
  return `"${value}"`;
}

/**
 * Trim a SQL default expression, collapsing "absent" and "blank" to null.
 * Used verbatim in drift messages so the reader sees what was authored and
 * what the database reports, not a rewritten form.
 */
function trimDefault(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The manifest's defaults as Postgres itself would store them.
 *
 * A default is kept in Postgres' own canonical spelling — a cast appended to a
 * bare literal (`'process'` reads back as `'process'::text`), a function call
 * parenthesised before a cast, a jsonb literal re-serialised with its keys
 * re-ordered — so an authored expression cannot be compared to
 * information_schema.columns.column_default as text. Instead every distinct
 * (type, default) pair is declared on one temporary table and read back: the
 * live default and the intended one are then both Postgres' own rendering,
 * compared byte for byte. Nothing is normalised by hand, so nothing real can
 * be normalised away.
 *
 * The expressions are the compiler's, exactly as schema.sql renders them, and
 * the types are checked against `informationSchemaType` first.
 */
async function canonicalDefaults(
  db: OpenShapeForgeDatabase,
  columns: readonly ManifestColumn[],
): Promise<(column: ManifestColumn) => string | null> {
  const key = (column: ManifestColumn) => `${column.type}\u0000${column.default}`;
  const distinct = [...new Map(columns.map((column) => [key(column), column])).values()];
  const canonical = new Map<string, string | null>();
  const lookup = (column: ManifestColumn) => canonical.get(key(column)) ?? null;
  if (distinct.length === 0) return lookup;

  await sql`drop table if exists pg_temp.osf_default_probe`.execute(db);
  await sql
    .raw(
      `create temporary table osf_default_probe (${distinct
        .map((column, index) => `c${index} ${column.type} default ${column.default}`)
        .join(", ")})`,
    )
    .execute(db);
  try {
    const rows = await sql<{ column_name: string; column_default: string | null }>`
      select column_name, column_default
      from information_schema.columns
      where table_schema = (select nspname from pg_namespace where oid = pg_my_temp_schema())
        and table_name = 'osf_default_probe'
    `.execute(db);
    const byName = new Map(rows.rows.map((row) => [row.column_name, row.column_default]));
    distinct.forEach((column, index) => {
      canonical.set(key(column), byName.get(`c${index}`) ?? null);
    });
  } finally {
    await sql`drop table if exists pg_temp.osf_default_probe`.execute(db);
  }
  return lookup;
}

/**
 * ADD COLUMN DDL for a manifest column. The column definition mirrors
 * packages/compiler/src/generate.ts renderColumnSql: type, identity, not
 * null, default. A primary-key column never reaches this function — adding
 * one to an existing table is classified as non-additive first.
 */
function renderAddColumnSql(table: ManifestTable, column: ManifestColumn): string {
  const parts = [quoteIdent(column.name), column.type];
  if (column.generated === "identity") {
    parts.push("GENERATED BY DEFAULT AS IDENTITY");
  }
  if (column.required) {
    parts.push("NOT NULL");
  }
  if (column.default !== undefined) {
    parts.push("DEFAULT", column.default);
  }
  return `ALTER TABLE ${quoteIdent(table.schema)}.${quoteIdent(table.table)} ADD COLUMN IF NOT EXISTS ${parts.join(" ")};`;
}

type AdditiveColumn = { table: ManifestTable; column: ManifestColumn };

export type ManifestSchemaDiff = {
  missingTables: ManifestTable[];
  missingColumns: AdditiveColumn[];
  /** Human-readable descriptions of every non-additive difference. */
  nonAdditive: string[];
};

/**
 * Diff the bundled manifest against the live database (tables + columns of
 * every schema the manifest covers) and classify each difference.
 *
 * Additive:
 * - manifest table missing in the database;
 * - manifest column missing on an existing table, when Postgres can add it
 *   without a backfill (nullable, or has a default, or is identity, or the
 *   table has no rows).
 *
 * Non-additive:
 * - required no-default non-identity column missing on a table WITH rows;
 * - primary-key column missing on an existing table;
 * - database column or table absent from the manifest (dropped or renamed);
 * - column type, nullability, identity, or (manifest-declared) default
 *   mismatch;
 * - manifest column type with no known information_schema mapping.
 *
 * Row probes run as the migrate role. Should a FORCE-RLS policy ever hide
 * rows from it, misclassification is fail-safe: the ADD COLUMN ... NOT NULL
 * that follows is rejected by Postgres itself and the transaction rolls back.
 *
 * `tables` defaults to the bundled manifest; it is a parameter so the
 * classification can be exercised against a purpose-built schema in tests.
 * Production callers never pass it.
 */
export async function diffManifestAgainstDatabase(
  db: OpenShapeForgeDatabase,
  tables: readonly ManifestTable[] = manifestTables,
): Promise<ManifestSchemaDiff> {
  const schemas = [...new Set(tables.map((table) => table.schema))];
  if (schemas.length === 0) return { missingTables: [], missingColumns: [], nonAdditive: [] };

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
    await sql<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      is_identity: string;
      column_default: string | null;
    }>`
      select table_schema, table_name, column_name, data_type, udt_name,
        is_nullable, is_identity, column_default
      from information_schema.columns
      where table_schema in (${sql.join(schemas)})
      order by table_schema, table_name, ordinal_position
    `.execute(db)
  ).rows;

  const liveTableNames = new Set(
    liveTables.map((row) => `${row.table_schema}.${row.table_name}`),
  );
  const liveColumnsByTable = new Map<string, Map<string, (typeof liveColumns)[number]>>();
  for (const row of liveColumns) {
    const tableName = `${row.table_schema}.${row.table_name}`;
    let columns = liveColumnsByTable.get(tableName);
    if (columns === undefined) {
      columns = new Map();
      liveColumnsByTable.set(tableName, columns);
    }
    columns.set(row.column_name, row);
  }

  const missingTables: ManifestTable[] = [];
  const missingColumns: AdditiveColumn[] = [];
  const nonAdditive: string[] = [];

  const intendedDefault = await canonicalDefaults(
    db,
    tables.flatMap((table) =>
      table.columns.filter(
        (column) =>
          column.default !== undefined &&
          informationSchemaType[column.type] !== undefined &&
          liveColumnsByTable.get(table.name)?.has(column.name) === true,
      ),
    ),
  );

  const hasRowsCache = new Map<string, boolean>();
  const tableHasRows = async (table: ManifestTable): Promise<boolean> => {
    const cached = hasRowsCache.get(table.name);
    if (cached !== undefined) return cached;
    const probe = await sql<{ present: boolean }>`
      select exists (select 1 from ${sql.id(table.schema, table.table)}) as present
    `.execute(db);
    const hasRows = probe.rows[0]?.present ?? false;
    hasRowsCache.set(table.name, hasRows);
    return hasRows;
  };

  for (const table of tables) {
    if (!liveTableNames.has(table.name)) {
      missingTables.push(table);
      continue;
    }

    const live = liveColumnsByTable.get(table.name) ?? new Map();

    for (const column of table.columns) {
      const expected = informationSchemaType[column.type];
      if (expected === undefined) {
        nonAdditive.push(
          `${table.name}.${column.name}: manifest type "${column.type}" has no known information_schema mapping`,
        );
        continue;
      }

      const liveColumn = live.get(column.name);
      if (liveColumn === undefined) {
        if (column.primaryKey) {
          nonAdditive.push(
            `${table.name}.${column.name}: primary-key column cannot be added to an existing table`,
          );
          continue;
        }
        const needsBackfill =
          column.required &&
          column.default === undefined &&
          column.generated !== "identity";
        if (needsBackfill && (await tableHasRows(table))) {
          nonAdditive.push(
            `${table.name}.${column.name}: required column with no default cannot be added — the table has rows and needs a backfill`,
          );
        } else {
          missingColumns.push({ table, column });
        }
        continue;
      }

      if (
        liveColumn.data_type !== expected.dataType ||
        (expected.udtName !== undefined && liveColumn.udt_name !== expected.udtName)
      ) {
        nonAdditive.push(
          `${table.name}.${column.name}: type mismatch — manifest expects ${column.type}, database has "${liveColumn.data_type === "ARRAY" ? liveColumn.udt_name : liveColumn.data_type}"`,
        );
      }
      const expectedNullable = !(column.required || column.primaryKey);
      const liveNullable = liveColumn.is_nullable === "YES";
      if (liveNullable !== expectedNullable) {
        nonAdditive.push(
          `${table.name}.${column.name}: nullability mismatch — manifest says ${expectedNullable ? "nullable" : "NOT NULL"}, database column is ${liveNullable ? "nullable" : "NOT NULL"}`,
        );
      }
      const expectedIdentity = column.generated === "identity";
      const liveIdentity = liveColumn.is_identity === "YES";
      if (liveIdentity !== expectedIdentity) {
        nonAdditive.push(
          `${table.name}.${column.name}: identity mismatch — manifest says ${expectedIdentity ? "identity" : "not identity"}, database column is ${liveIdentity ? "identity" : "not identity"}`,
        );
      }
      // Only checked when the manifest declares a default, so a database-side
      // default the manifest never asserts (an identity sequence) never trips
      // this. schema.sql cannot ALTER a default in place, so a changed one is
      // refused rather than silently left stale.
      if (column.default !== undefined) {
        if (intendedDefault(column) !== liveColumn.column_default) {
          const liveShown = trimDefault(liveColumn.column_default);
          nonAdditive.push(
            `${table.name}.${column.name}: default mismatch — manifest expects DEFAULT ${trimDefault(column.default)}, database column has ${liveShown ? `DEFAULT ${liveShown}` : "no default"}`,
          );
        }
      }
    }

    const declared = new Set(table.columns.map((column) => column.name));
    for (const columnName of live.keys()) {
      if (!declared.has(columnName)) {
        nonAdditive.push(
          `${table.name}.${columnName}: column exists in the database but not in the generated manifest`,
        );
      }
    }
  }

  const manifestTableNames = new Set(tables.map((table) => table.name));
  for (const tableName of liveTableNames) {
    if (!manifestTableNames.has(tableName)) {
      nonAdditive.push(
        `${tableName}: table exists in the database but is not in the generated manifest`,
      );
    }
  }

  return { missingTables, missingColumns, nonAdditive };
}

const NON_ADDITIVE_REMEDIATION = [
  "A database whose data must be kept: write a versioned migration that transforms it so the",
  "remaining diff is additive (`bun run db:migration:new <name>`), then rerun `bun run db:migrate`.",
  "A disposable development database: `bun run db:reset` rebuilds it from the manifest,",
  "destroying every row, or build a scratch one instead (docs/testing.md, \"One Postgres, many worktrees\").",
];

/**
 * The refusal for a built database whose drift from the bundled manifest is
 * not purely additive. Exported so the tests can assert the exact
 * remediation a developer is shown.
 */
export function nonAdditiveDriftError(
  recordedChecksum: string,
  drift: readonly string[],
): Error {
  return new Error(
    [
      `Generated schema roll-forward blocked by non-additive drift (recorded checksum ${recordedChecksum}, manifest checksum ${manifest.checksum}).`,
      "",
      "Non-additive differences:",
      ...drift.map((line) => `  - ${line}`),
      "",
      ...NON_ADDITIVE_REMEDIATION,
    ].join("\n"),
  );
}

/**
 * The refusal for a database with no generated-schema row that is not empty
 * (`leftovers`), or for a built one carrying objects the manifest does not
 * declare (`undeclared`). Neither is something to build or roll over.
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
      ...(status === "unmigrated"
        ? [
            "A database is built from the manifest on an empty database only; nothing is adopted.",
            "Rebuild it: `bun run db:reset` drops and recreates the database (destroying every row),",
            "or build a scratch one instead (docs/testing.md, \"One Postgres, many worktrees\").",
          ]
        : NON_ADDITIVE_REMEDIATION),
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
  options: {
    appliedBy?: string | undefined;
    /**
     * Ledger rows a build records with the schema: the versioned migrations
     * the manifest already incorporates (versionedMigrationBaseline).
     */
    baseline?: readonly { version: string; checksum: string }[];
  } = {},
): Promise<GeneratedSchemaMigrationResult> {
  const appliedBy = options.appliedBy ?? "apps/api";
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
        .values([
          {
            version: generatedSchemaMigrationVersion,
            checksum: manifest.checksum,
            applied_by: appliedBy,
          },
          ...(options.baseline ?? []).map((row) => ({
            version: row.version,
            checksum: row.checksum,
            applied_by: `${appliedBy} baseline`,
          })),
        ])
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
      built: true,
    };
  }

  if (existing.checksum === manifest.checksum) {
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

  // Recorded checksum differs from the bundled manifest: roll forward if the
  // drift is purely additive, otherwise refuse with the exact differences.
  const diff = await diffManifestAgainstDatabase(db);
  if (diff.nonAdditive.length > 0) {
    throw nonAdditiveDriftError(existing.checksum, diff.nonAdditive);
  }

  const summary: GeneratedSchemaRollForwardSummary = {
    addedTables: diff.missingTables.map((table) => table.name),
    addedColumns: diff.missingColumns.map(
      ({ table, column }) => `${table.name}.${column.name}`,
    ),
  };

  const schemaSql = await readGeneratedSchemaSql();
  await sql`begin`.execute(db);
  try {
    for (const entry of diff.missingColumns) {
      await sql.raw(renderAddColumnSql(entry.table, entry.column)).execute(db);
    }
    // Re-apply the idempotent generated schema: creates missing tables and
    // indexes, refreshes RLS policies, ensures foreign keys.
    await sql.raw(schemaSql).execute(db);
    await db
      .updateTable("platform.schema_migrations")
      .set({
        checksum: manifest.checksum,
        applied_at: new Date(),
        applied_by: appliedBy,
      })
      .where("version", "=", generatedSchemaMigrationVersion)
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
    rollForward: summary,
  };
}
