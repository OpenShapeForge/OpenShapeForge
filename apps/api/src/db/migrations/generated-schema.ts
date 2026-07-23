// SPDX-License-Identifier: BUSL-1.1
/**
 * Roll-forward migrator for the compiler-generated schema.
 *
 * The applied generated-manifest checksum is recorded in
 * platform.schema_migrations under version "0001_generated_platform_schema".
 * On every run:
 *
 * - no row            -> fresh install: apply schema.sql, record the checksum.
 * - checksum equal    -> no-op.
 * - checksum differs  -> diff the bundled manifest against the live
 *   information_schema. Purely ADDITIVE drift (new tables, new columns that
 *   Postgres can add without a backfill) is applied automatically:
 *   ALTER TABLE ... ADD COLUMN IF NOT EXISTS for missing columns, then the
 *   full idempotent schema.sql (new tables, indexes, refreshed RLS policies,
 *   FKs), then the recorded checksum is rolled forward. NON-additive drift
 *   (dropped/renamed/retyped columns, tables no longer in the manifest,
 *   required no-default columns on populated tables) hard-errors with an
 *   exact listing — write a versioned migration (bun run db:migration:new)
 *   that transforms the schema, then rerun db:migrate.
 *
 * The generated schema.sql itself stays idempotent (CREATE ... IF NOT EXISTS
 * throughout; RLS policies DROP IF EXISTS + CREATE), so re-applying it during
 * a roll-forward is safe.
 *
 * `db` must be a connection-bound Kysely instance (migrate.ts runs the chain
 * inside runtime.db.connection().execute): the roll-forward uses explicit
 * BEGIN/COMMIT so all DDL plus the checksum update land atomically.
 */
import { readFile } from "node:fs/promises";
import { sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";
import { ensureSchemaMigrationsTable } from "./schema-migrations-table.js";

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
  applied: boolean;
  rollForward?: GeneratedSchemaRollForwardSummary;
};

type ManifestColumn = {
  name: string;
  type: string;
  required: boolean;
  primaryKey: boolean;
  generated: string | null;
  /** Verbatim SQL default expression, when the compiler records one. */
  default?: string;
};

type ManifestTable = {
  /** Qualified name, e.g. "erp.relations". */
  name: string;
  schema: string;
  table: string;
  columns: ManifestColumn[];
};

const manifestTables = manifest.tables as unknown as ManifestTable[];

/**
 * Tables inside manifest-covered schemas that are managed by dedicated
 * migrations rather than the generated manifest. They are never treated as
 * "disappeared from the manifest" drift. platform.schema_migrations is
 * currently in the manifest too; keeping it here is defensive.
 */
const nonManifestManagedTables = new Set<string>([
  "platform.schema_migrations",
  "platform.system_bypass_audit",
]);

/**
 * Manifest scalar type -> information_schema.columns.data_type. Anything not
 * in this map is classified as non-additive drift rather than guessed at.
 */
const informationSchemaDataType: Record<string, string> = {
  text: "text",
  uuid: "uuid",
  timestamptz: "timestamp with time zone",
  jsonb: "jsonb",
  integer: "integer",
  bigint: "bigint",
  numeric: "numeric",
  boolean: "boolean",
  date: "date",
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
 * Normalize a SQL default expression for drift comparison. The manifest records
 * the verbatim authoring default (e.g. `now()`, `'{}'::jsonb`) while Postgres
 * re-serializes information_schema.column_default in its own canonical form.
 * For the scalar defaults this schema uses those forms coincide; we still trim
 * surrounding whitespace so cosmetic differences never register as drift.
 */
function normalizeDefault(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * ADD COLUMN DDL for a manifest column. The column definition mirrors
 * packages/compiler/src/generate.ts renderColumnSql exactly: type, identity,
 * primary key, not null, default. The manifest type doubles as the SQL type
 * token (the compiler's sqlType mapping is the identity on these names);
 * unknown types never reach this function — the diff classifies them as
 * non-additive first.
 */
function renderAddColumnSql(table: ManifestTable, column: ManifestColumn): string {
  const parts = [quoteIdent(column.name), column.type];
  if (column.generated === "identity") {
    parts.push("GENERATED BY DEFAULT AS IDENTITY");
  }
  if (column.primaryKey) {
    parts.push("PRIMARY KEY");
  }
  if (column.required || column.primaryKey) {
    parts.push("NOT NULL");
  }
  if (column.default !== undefined) {
    parts.push("DEFAULT", column.default);
  }
  return `ALTER TABLE ${quoteIdent(table.schema)}.${quoteIdent(table.table)} ADD COLUMN IF NOT EXISTS ${parts.join(" ")};`;
}

type AdditiveColumn = { table: ManifestTable; column: ManifestColumn };

type ManifestSchemaDiff = {
  missingTables: ManifestTable[];
  missingColumns: AdditiveColumn[];
  /** Human-readable descriptions of every non-additive difference. */
  nonAdditive: string[];
};

/**
 * Diff the bundled manifest against the live database (tables + columns of
 * every schema the manifest covers) and classify each difference as additive
 * or non-additive.
 *
 * Additive:
 * - manifest table missing in the DB;
 * - manifest column missing on an existing table, when Postgres can add it
 *   without a backfill (nullable, or has a default, or is identity, or the
 *   table has no rows).
 *
 * Non-additive:
 * - required no-default non-identity column missing on a table WITH rows;
 * - DB column absent from the manifest;
 * - column type, nullability, identity, or (manifest-declared) default mismatch;
 * - DB table (in a covered schema, not in nonManifestManagedTables) absent
 *   from the manifest;
 * - manifest column type with no known information_schema mapping.
 *
 * Row-count probes honor RLS: the migration role is expected to be the
 * superuser/owner used by db:migrate. If a FORCE-RLS policy ever hid rows
 * from a non-superuser migration role, misclassification is fail-safe — the
 * subsequent ADD COLUMN ... NOT NULL would be rejected by Postgres itself.
 */
async function diffManifestAgainstDatabase(
  db: OpenShapeForgeDatabase,
): Promise<ManifestSchemaDiff> {
  const schemas = [...new Set(manifestTables.map((table) => table.schema))];

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
      is_nullable: string;
      is_identity: string;
      column_default: string | null;
    }>`
      select table_schema, table_name, column_name, data_type, is_nullable, is_identity, column_default
      from information_schema.columns
      where table_schema in (${sql.join(schemas)})
      order by table_schema, table_name, ordinal_position
    `.execute(db)
  ).rows;

  const liveTableNames = new Set(
    liveTables.map((row) => `${row.table_schema}.${row.table_name}`),
  );
  const liveColumnsByTable = new Map<
    string,
    Map<
      string,
      { dataType: string; isNullable: string; isIdentity: string; columnDefault: string | null }
    >
  >();
  for (const row of liveColumns) {
    const tableName = `${row.table_schema}.${row.table_name}`;
    let columns = liveColumnsByTable.get(tableName);
    if (columns === undefined) {
      columns = new Map();
      liveColumnsByTable.set(tableName, columns);
    }
    columns.set(row.column_name, {
      dataType: row.data_type,
      isNullable: row.is_nullable,
      isIdentity: row.is_identity,
      columnDefault: row.column_default,
    });
  }

  const missingTables: ManifestTable[] = [];
  const missingColumns: AdditiveColumn[] = [];
  const nonAdditive: string[] = [];

  const hasRowsCache = new Map<string, boolean>();
  const tableHasRows = async (table: ManifestTable): Promise<boolean> => {
    const cached = hasRowsCache.get(table.name);
    if (cached !== undefined) {
      return cached;
    }
    const probe = await sql<{ present: boolean }>`
      select exists (select 1 from ${sql.id(table.schema, table.table)}) as present
    `.execute(db);
    const hasRows = probe.rows[0]?.present ?? false;
    hasRowsCache.set(table.name, hasRows);
    return hasRows;
  };

  for (const table of manifestTables) {
    if (!liveTableNames.has(table.name)) {
      missingTables.push(table);
      continue;
    }

    const live = liveColumnsByTable.get(table.name) ?? new Map<string, never>();

    for (const column of table.columns) {
      const expectedDataType = informationSchemaDataType[column.type];
      if (expectedDataType === undefined) {
        nonAdditive.push(
          `${table.name}.${column.name}: manifest type "${column.type}" has no known information_schema mapping`,
        );
        continue;
      }

      const liveColumn = live.get(column.name);
      if (liveColumn === undefined) {
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

      if (liveColumn.dataType !== expectedDataType) {
        nonAdditive.push(
          `${table.name}.${column.name}: type mismatch — manifest expects ${column.type} ("${expectedDataType}"), database has "${liveColumn.dataType}"`,
        );
      }
      const expectedNullable = !(column.required || column.primaryKey);
      const liveNullable = liveColumn.isNullable === "YES";
      if (liveNullable !== expectedNullable) {
        nonAdditive.push(
          `${table.name}.${column.name}: nullability mismatch — manifest says ${expectedNullable ? "nullable" : "NOT NULL"}, database column is ${liveNullable ? "nullable" : "NOT NULL"}`,
        );
      }
      const expectedIdentity = column.generated === "identity";
      const liveIdentity = liveColumn.isIdentity === "YES";
      if (liveIdentity !== expectedIdentity) {
        nonAdditive.push(
          `${table.name}.${column.name}: identity mismatch — manifest says ${expectedIdentity ? "identity" : "not identity"}, database column is ${liveIdentity ? "identity" : "not identity"}`,
        );
      }
      // Default drift. Only checked when the manifest declares a default, so a
      // DB-side implicit default the manifest never asserts never trips this.
      // The roll-forward cannot ALTER a default in place (schema.sql is
      // CREATE ... IF NOT EXISTS only), so a changed default is surfaced as a
      // non-additive difference that hard-errors with remediation instructions
      // rather than silently persisting the stale default.
      if (column.default !== undefined) {
        const expectedDefault = normalizeDefault(column.default);
        const liveDefault = normalizeDefault(liveColumn.columnDefault);
        if (expectedDefault !== liveDefault) {
          nonAdditive.push(
            `${table.name}.${column.name}: default mismatch — manifest expects DEFAULT ${expectedDefault ?? "(none)"}, database column has ${liveDefault ? `DEFAULT ${liveDefault}` : "no default"}`,
          );
        }
      }
    }

    for (const columnName of live.keys()) {
      if (!table.columns.some((column) => column.name === columnName)) {
        nonAdditive.push(
          `${table.name}.${columnName}: column exists in the database but not in the generated manifest`,
        );
      }
    }
  }

  const manifestTableNames = new Set(manifestTables.map((table) => table.name));
  for (const tableName of liveTableNames) {
    if (
      !manifestTableNames.has(tableName) &&
      !nonManifestManagedTables.has(tableName)
    ) {
      nonAdditive.push(
        `${tableName}: table exists in the database but is not in the generated manifest`,
      );
    }
  }

  return { missingTables, missingColumns, nonAdditive };
}

function nonAdditiveDriftError(
  recordedChecksum: string,
  drift: string[],
): Error {
  return new Error(
    [
      `Generated schema roll-forward blocked by non-additive drift (recorded checksum ${recordedChecksum}, manifest checksum ${manifest.checksum}).`,
      "",
      "Non-additive differences:",
      ...drift.map((line) => `  - ${line}`),
      "",
      "Remediation: write a versioned migration (bun run db:migration:new <name>) that transforms the schema so the remaining diff is additive, then rerun bun run db:migrate. Alternatively, reset the database volume (destroys all data).",
    ].join("\n"),
  );
}

export async function applyGeneratedSchemaMigration(
  db: OpenShapeForgeDatabase,
  appliedBy = "apps/api",
): Promise<GeneratedSchemaMigrationResult> {
  await ensureSchemaMigrationsTable(db);

  const existing = await db
    .selectFrom("platform.schema_migrations")
    .select(["checksum"])
    .where("version", "=", generatedSchemaMigrationVersion)
    .executeTakeFirst();

  if (existing === undefined) {
    // Fresh install: apply the full generated schema and record the checksum.
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

  if (existing.checksum === manifest.checksum) {
    return {
      version: generatedSchemaMigrationVersion,
      checksum: manifest.checksum,
      applied: false,
    };
  }

  // Recorded checksum differs from the bundled manifest: roll forward if the
  // drift is purely additive, otherwise fail with the exact differences.
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
    // indexes, refreshes RLS policies, ensures FKs.
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

  console.log(
    JSON.stringify({
      event: "generated_schema_roll_forward",
      fromChecksum: existing.checksum,
      toChecksum: manifest.checksum,
      addedTableCount: summary.addedTables.length,
      addedColumnCount: summary.addedColumns.length,
      addedTables: summary.addedTables,
      addedColumns: summary.addedColumns,
    }),
  );

  return {
    version: generatedSchemaMigrationVersion,
    checksum: manifest.checksum,
    applied: true,
    rollForward: summary,
  };
}
