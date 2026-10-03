// SPDX-License-Identifier: BUSL-1.1
/**
 * The registry of plugin-declared DDL the migrate chain applies after the
 * generated schema: table constraints (rendered idempotently, see
 * render-constraint-sql.ts) and a plugin's free-form `schemaMigrations`.
 * There is no ledger — every entry runs on every migrate, so free-form SQL
 * must be idempotent (CREATE OR REPLACE, IF NOT EXISTS, guarded DO blocks).
 * The plugin-local version is an ordering key, not a history.
 */
import type {
  CompilerPlugin,
  PluginBaseContext,
  PluginSchemaMigration,
} from "./plugins.js";
import { renderConstraintSql } from "./render-constraint-sql.js";
import { assertTenantBoundReferences } from "./tenant-bound-references.js";
import type { PlatformSchemaManifest } from "./schema.js";

export const PLUGIN_MIGRATION_REGISTRY_PATH =
  "apps/api/src/generated/plugin-migrations/registry.json";

export type GeneratedPluginMigration = {
  plugin: string;
  version: string;
  sql: string;
};

export type GeneratedPluginMigrationRegistry = {
  version: 1;
  migrations: GeneratedPluginMigration[];
};

const pluginNamePattern = /^[a-z][a-z0-9-]*$/;
const migrationVersionPattern = /^\d{4}_[a-z0-9][a-z0-9-]*$/;

function nonEmptySql(sql: string, label: string): string {
  if (sql.trim().length === 0) {
    throw new Error(`${label} has empty SQL.`);
  }
  return sql.endsWith("\n") ? sql : `${sql}\n`;
}
function assertMigrationIdentity(plugin: string, version: string): void {
  if (!pluginNamePattern.test(plugin)) {
    throw new Error(
      `Plugin schema migration owner "${plugin}" is invalid — expected a lowercase kebab-case plugin name.`,
    );
  }
  if (!migrationVersionPattern.test(version)) {
    throw new Error(
      `Plugin "${plugin}" schema migration "${version}" is invalid — expected "NNNN_kebab-name".`,
    );
  }
}

function compareMigrationIdentity(
  left: Pick<GeneratedPluginMigration, "plugin" | "version">,
  right: Pick<GeneratedPluginMigration, "plugin" | "version">,
): number {
  return (
    left.plugin.localeCompare(right.plugin) ||
    left.version.localeCompare(right.version)
  );
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((column, index) => column === right[index])
  );
}

function assertConstraintRelations(manifest: PlatformSchemaManifest): void {
  const relationNames = new Map<string, Map<string, string>>();
  for (const table of manifest.tables) {
    const schema = relationNames.get(table.schema) ?? new Map<string, string>();
    relationNames.set(table.schema, schema);
    schema.set(table.name, `table ${table.schema}.${table.name}`);
    for (const index of table.indexes ?? []) {
      schema.set(index.name, `index ${table.schema}.${index.name}`);
    }
  }
  for (const table of manifest.tables) {
    const schema = relationNames.get(table.schema)!;
    // Column-level primaryKey flags form ONE key however many columns carry
    // them (a composite key, see generate.ts); a constraint-level key on top
    // of that is the second key Postgres refuses.
    const tablePrimaryKeys =
      (table.columns.some((column) => column.primaryKey === true) ? 1 : 0) +
      (table.constraints ?? []).filter(
        (constraint) => constraint.kind === "primaryKey",
      ).length;
    if (tablePrimaryKeys > 1) {
      throw new Error(`Table ${table.schema}.${table.name} declares multiple primary keys.`);
    }
    for (const constraint of table.constraints ?? []) {
      if (constraint.kind !== "primaryKey" && constraint.kind !== "unique") continue;
      const existing = schema.get(constraint.name);
      if (existing) {
        throw new Error(
          `Constraint ${table.schema}.${table.name}.${constraint.name} requires backing index ${table.schema}.${constraint.name}, which collides with ${existing}.`,
        );
      }
      schema.set(
        constraint.name,
        `constraint ${table.schema}.${table.name}.${constraint.name}`,
      );
    }
  }
}

function assertForeignKeyTargets(manifest: PlatformSchemaManifest): void {
  const tables = new Map(
    manifest.tables.map((table) => [`${table.schema}.${table.name}`, table]),
  );
  for (const table of manifest.tables) {
    for (const constraint of table.constraints ?? []) {
      if (constraint.kind !== "foreignKey") continue;
      const targetName = `${constraint.references.schema}.${constraint.references.table}`;
      const target = tables.get(targetName);
      if (!target) {
        throw new Error(
          `Foreign key ${table.schema}.${table.name}.${constraint.name} references unknown table ${targetName}.`,
        );
      }
      const targetColumns = new Set(target.columns.map((column) => column.name));
      for (const column of constraint.references.columns) {
        if (!targetColumns.has(column)) {
          throw new Error(
            `Foreign key ${table.schema}.${table.name}.${constraint.name} references unknown column ${targetName}.${column}.`,
          );
        }
      }
      // The column-level key is unique only as a whole: one member of a
      // composite key does not identify a row on its own.
      const immediatelyUnique =
        sameColumns(
          target.columns
            .filter((column) => column.primaryKey === true)
            .map((column) => column.name),
          constraint.references.columns,
        ) ||
        (target.indexes ?? []).some(
          (index) =>
            index.unique === true &&
            sameColumns(index.columns, constraint.references.columns),
        );
      if (immediatelyUnique) continue;
      const targetConstraint = (target.constraints ?? []).find(
        (candidate) =>
          (candidate.kind === "primaryKey" || candidate.kind === "unique") &&
          sameColumns(candidate.columns, constraint.references.columns),
      );
      if (!targetConstraint) {
        throw new Error(
          `Foreign key ${table.schema}.${table.name}.${constraint.name} targets ${targetName} (${constraint.references.columns.join(", ")}), which has no matching primary key or unique constraint.`,
        );
      }
      if (!table.pluginOwner || !target.pluginOwner) continue;
      if (
        compareMigrationIdentity(
          { plugin: target.pluginOwner, version: targetConstraint.version },
          { plugin: table.pluginOwner, version: constraint.version },
        ) >= 0
      ) {
        throw new Error(
          `Foreign key ${table.schema}.${table.name}.${constraint.name} is ordered before target key ${targetName}.${targetConstraint.name}; plugin migrations apply by plugin name then version.`,
        );
      }
    }
  }
}

function migrationEntry(
  plugin: string,
  migration: PluginSchemaMigration,
): GeneratedPluginMigration {
  assertMigrationIdentity(plugin, migration.version);
  const sql = nonEmptySql(
    migration.sql,
    `Plugin "${plugin}" schema migration "${migration.version}"`,
  );
  return { plugin, version: migration.version, sql };
}

/**
 * Build the registry consumed by the API migrate chain. Constraint entries and
 * free-form plugin DDL share a plugin-local version namespace, so ordering and
 * collisions are explicit rather than dependent on object iteration.
 */
export function collectPluginMigrationRegistry(
  manifest: PlatformSchemaManifest,
  plugins: readonly CompilerPlugin[],
  context?: PluginBaseContext,
): GeneratedPluginMigrationRegistry {
  const entries: GeneratedPluginMigration[] = [];
  assertConstraintRelations(manifest);
  assertForeignKeyTargets(manifest);
  assertTenantBoundReferences(manifest);

  for (const table of manifest.tables) {
    const constraintNames = new Set<string>();
    for (const constraint of table.constraints ?? []) {
      if (constraintNames.has(constraint.name)) {
        throw new Error(
          `Table ${table.schema}.${table.name} declares duplicate constraint name "${constraint.name}".`,
        );
      }
      constraintNames.add(constraint.name);
      const plugin = constraint.compilerOwned ? "osf-compiler" : table.pluginOwner;
      if (!plugin) {
        throw new Error(
          `Table ${table.schema}.${table.name} declares constraint ${constraint.name} but has no plugin owner. Table constraints are currently a compiler-plugin contract.`,
        );
      }
      assertMigrationIdentity(plugin, constraint.version);
      const sql = renderConstraintSql(table, constraint);
      entries.push({ plugin, version: constraint.version, sql });
    }
  }

  for (const plugin of plugins) {
    let migrations: PluginSchemaMigration[];
    if (typeof plugin.schemaMigrations === "function") {
      if (!context) {
        throw new Error(
          `Plugin "${plugin.name}" uses context-dependent schemaMigrations, but no plugin context was provided.`,
        );
      }
      migrations = plugin.schemaMigrations(context);
    } else {
      migrations = plugin.schemaMigrations ?? [];
    }
    for (const migration of migrations) {
      entries.push(migrationEntry(plugin.name, migration));
    }
  }

  entries.sort(compareMigrationIdentity);
  const seen = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.plugin}:${entry.version}`;
    if (seen.has(identity)) {
      throw new Error(`Duplicate plugin schema migration "${identity}".`);
    }
    seen.add(identity);
  }

  return { version: 1, migrations: entries };
}

export function renderPluginMigrationRegistry(
  registry: GeneratedPluginMigrationRegistry,
): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}
