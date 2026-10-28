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
 *
 * A compiler-rendered constraint is guarded by name alone, which a database
 * carried forward by the roll-forward cannot rely on: an options list that
 * gains a value keeps its constraint name, and an entity-value check that
 * changes is renamed by its digest. So each rendered block is recognised
 * (`parseCompilerConstraint`): a CHECK is reconciled by definition
 * (`ensureCheckConstraint`), every recognised constraint is marked as owned
 * with a comment, and an owned constraint the registry no longer renders is
 * dropped — after the new ones are in place, so a failed add leaves the old
 * guard standing.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import { ensureCheckConstraint } from "./sql-invariants.js";
import { APP_ROLE } from "./app-role.js";

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
  /** Owned constraints dropped because no entry renders them any more. */
  removed: string[];
};

/** Comment that marks a constraint as rendered by a plugin registry entry. */
const OWNED_CONSTRAINT_COMMENT_PREFIX = "osf:plugin-constraint:";

/**
 * The exact block packages/compiler/src/render-constraint-sql.ts renders for
 * one table constraint. Anything else — free-form plugin SQL — is run as it
 * is and never marked.
 */
const compilerConstraintBlock =
  /^DO \$osf\$\nBEGIN\n  IF NOT EXISTS \(\n    SELECT 1 FROM pg_constraint\n    WHERE conrelid = '"([a-z_][a-z0-9_]*)"\."([a-z_][a-z0-9_]*)"'::regclass AND conname = '([a-z][a-z0-9_]*)'\n  \) THEN\n    ALTER TABLE "\1"\."\2"\n      ADD CONSTRAINT "\3" (.+);\n  END IF;\nEND\n\$osf\$;\n*$/s;

export type CompilerConstraint = {
  /** Qualified, unquoted: "erp.blocks". */
  table: string;
  name: string;
  /** As rendered: `CHECK (...)`, `UNIQUE (...)`, `FOREIGN KEY ...`. */
  definition: string;
};

export function parseCompilerConstraint(text: string): CompilerConstraint | undefined {
  const match = compilerConstraintBlock.exec(text);
  if (match === null) return undefined;
  return {
    table: `${match[1]}.${match[2]}`,
    name: match[3]!,
    definition: match[4]!,
  };
}

function checkExpression(definition: string): string | undefined {
  return definition.startsWith("CHECK (") && definition.endsWith(")")
    ? definition.slice("CHECK (".length, -1)
    : undefined;
}

function quotedTable(table: string): string {
  return table.split(".").map((part) => `"${part}"`).join(".");
}

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
  const rendered = new Set<string>();
  for (const migration of migrations) {
    const identity = pluginMigrationIdentity(migration);
    const owned = parseCompilerConstraint(migration.sql);
    await sql`begin`.execute(db);
    try {
      // Plugin DDL can scope database policies to the host's configured
      // runtime role without guessing its name. The setting is transaction
      // local and is supplied by the host, not by request/session input.
      await sql`select set_config('osf.migration_app_role', ${APP_ROLE}, true)`.execute(db);
      const expression = owned && checkExpression(owned.definition);
      if (owned && expression !== undefined) {
        await ensureCheckConstraint(db, { table: owned.table, name: owned.name, expression });
      } else {
        await sql.raw(migration.sql).execute(db);
      }
      if (owned) {
        await sql
          .raw(
            `COMMENT ON CONSTRAINT "${owned.name}" ON ${quotedTable(owned.table)} IS '${OWNED_CONSTRAINT_COMMENT_PREFIX}${migration.plugin}'`,
          )
          .execute(db);
        rendered.add(`${owned.table}.${owned.name}`);
      }
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
  return { applied, removed: await dropUnrenderedConstraints(db, rendered) };
}

/**
 * Drop every constraint marked as plugin-owned that no registry entry renders
 * any more: a retired options check, or an entity-value check whose digest
 * changed with its definition.
 */
async function dropUnrenderedConstraints(
  db: Kysely<any>,
  rendered: ReadonlySet<string>,
): Promise<string[]> {
  const owned = await sql<{ table: string; name: string }>`
    select n.nspname || '.' || t.relname as "table", c.conname as name
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_description d
      on d.objoid = c.oid and d.classoid = 'pg_constraint'::regclass and d.objsubid = 0
    where d.description like ${`${OWNED_CONSTRAINT_COMMENT_PREFIX}%`}
    order by 1, 2
  `.execute(db);
  const stale = owned.rows.filter((row) => !rendered.has(`${row.table}.${row.name}`));
  if (stale.length === 0) return [];
  await sql`begin`.execute(db);
  try {
    for (const row of stale) {
      await sql`alter table ${sql.id(...(row.table.split(".") as [string, string]))} drop constraint ${sql.id(row.name)}`.execute(db);
    }
    await sql`commit`.execute(db);
  } catch (error) {
    await sql`rollback`.execute(db);
    throw error;
  }
  return stale.map((row) => `${row.table}.${row.name}`);
}
