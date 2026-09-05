// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import type {
  CompilerPlugin,
  PluginBaseContext,
  PluginSchemaMigration,
} from "./plugins.js";
import type {
  PlatformSchemaManifest,
  TableConstraintDefinition,
  TableDefinition,
} from "./schema.js";

export const PLUGIN_MIGRATION_REGISTRY_PATH =
  "apps/api/src/generated/plugin-migrations/registry.json";

export type GeneratedPluginMigration = {
  plugin: string;
  version: string;
  checksum: string;
  sql: string;
};

export type GeneratedPluginMigrationRegistry = {
  version: 1;
  migrations: GeneratedPluginMigration[];
};

const pluginNamePattern = /^[a-z][a-z0-9-]*$/;
const migrationVersionPattern = /^\d{4}_[a-z0-9][a-z0-9-]*$/;
const constraintNamePattern = /^[a-z][a-z0-9_]*$/;
const onDeleteActions = new Set(["CASCADE", "RESTRICT", "SET NULL"]);

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

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

function assertSingleCheckExpression(expression: string, label: string): void {
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]!;
    if (character === "'" || character === '"') {
      const quote = character;
      while (++index < expression.length) {
        if (expression[index] !== quote) continue;
        if (expression[index + 1] === quote) index += 1;
        else break;
      }
      continue;
    }
    if (character === "$") {
      const delimiter = expression
        .slice(index)
        .match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const closing = expression.indexOf(delimiter, index + delimiter.length);
        if (closing === -1) {
          throw new Error(`${label} has an unterminated dollar-quoted string.`);
        }
        index = closing + delimiter.length - 1;
        continue;
      }
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      if (depth === 0) {
        throw new Error(`${label} closes the compiler-owned CHECK expression.`);
      }
      depth -= 1;
    }
  }
  if (depth !== 0) throw new Error(`${label} has unbalanced parentheses.`);
}

function assertColumns(
  table: TableDefinition,
  constraint: TableConstraintDefinition,
): void {
  if (constraint.kind === "check") return;
  if (constraint.columns.length === 0) {
    throw new Error(
      `Constraint ${table.schema}.${table.name}.${constraint.name} has no columns.`,
    );
  }
  const present = new Set(table.columns.map((column) => column.name));
  const seen = new Set<string>();
  for (const column of constraint.columns) {
    if (!present.has(column)) {
      throw new Error(
        `Constraint ${table.schema}.${table.name}.${constraint.name} references unknown column "${column}".`,
      );
    }
    if (seen.has(column)) {
      throw new Error(
        `Constraint ${table.schema}.${table.name}.${constraint.name} repeats column "${column}".`,
      );
    }
    seen.add(column);
  }
  if (
    constraint.kind === "foreignKey" &&
    constraint.references.columns.length !== constraint.columns.length
  ) {
    throw new Error(
      `Foreign key ${table.schema}.${table.name}.${constraint.name} has ${constraint.columns.length} local column(s) but ${constraint.references.columns.length} referenced column(s).`,
    );
  }
}

function renderConstraintSql(
  table: TableDefinition,
  constraint: TableConstraintDefinition,
): string {
  assertColumns(table, constraint);
  if (!constraintNamePattern.test(constraint.name)) {
    throw new Error(
      `Constraint name ${table.schema}.${table.name}.${constraint.name} must be a lower_snake_case identifier.`,
    );
  }
  if (
    constraint.kind === "primaryKey" &&
    table.columns.some((column) => column.primaryKey === true)
  ) {
    throw new Error(
      `Table ${table.schema}.${table.name} declares both a column primary key and table constraint ${constraint.name}.`,
    );
  }

  const tableName = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
  const prefix =
    `ALTER TABLE ${tableName}\n` +
    `  ADD CONSTRAINT ${quoteIdent(constraint.name)} `;

  if (constraint.kind === "check") {
    if (constraint.expression.trim().length === 0) {
      throw new Error(
        `Check constraint ${table.schema}.${table.name}.${constraint.name} has an empty expression.`,
      );
    }
    if (/;|--|\/\*|\*\//.test(constraint.expression)) {
      throw new Error(
        `Check constraint ${table.schema}.${table.name}.${constraint.name} must not contain a statement terminator or comment. Use schemaMigrations for free-form SQL.`,
      );
    }
    assertSingleCheckExpression(
      constraint.expression,
      `Check constraint ${table.schema}.${table.name}.${constraint.name}`,
    );
    return `${prefix}CHECK (${constraint.expression});\n`;
  }

  const columns = `(${constraint.columns.map(quoteIdent).join(", ")})`;
  if (constraint.kind === "primaryKey") {
    return `${prefix}PRIMARY KEY ${columns};\n`;
  }
  if (constraint.kind === "unique") {
    return `${prefix}UNIQUE ${columns};\n`;
  }

  const referenced =
    `${quoteIdent(constraint.references.schema)}.${quoteIdent(constraint.references.table)}` +
    ` (${constraint.references.columns.map(quoteIdent).join(", ")})`;
  if (constraint.onDelete && !onDeleteActions.has(constraint.onDelete)) {
    throw new Error(
      `Foreign key ${table.schema}.${table.name}.${constraint.name} has unsupported ON DELETE action "${constraint.onDelete}".`,
    );
  }
  if (constraint.initiallyDeferred && !constraint.deferrable) {
    throw new Error(
      `Foreign key ${table.schema}.${table.name}.${constraint.name} is initially deferred but not deferrable.`,
    );
  }
  const onDelete = constraint.onDelete ? ` ON DELETE ${constraint.onDelete}` : "";
  const deferred = constraint.deferrable
    ? ` DEFERRABLE${constraint.initiallyDeferred ? " INITIALLY DEFERRED" : ""}`
    : "";
  return `${prefix}FOREIGN KEY ${columns} REFERENCES ${referenced}${onDelete}${deferred};\n`;
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
    const tablePrimaryKeys =
      table.columns.filter((column) => column.primaryKey === true).length +
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
      // A column-level primaryKey is only a single-column key when the table is
      // global. On a tenant-scoped table the emitted key is (tenant_id, <id>)
      // — see tenantScopedIdentityColumn in generate.ts — so a plugin FK that
      // names the identity column alone has no key to attach to and must fail
      // here rather than at migrate time. That refusal is the point: an
      // RLS-bypassing single-column reference into another tenant's row is
      // exactly what issue #509 closed.
      const immediatelyUnique =
        (constraint.references.columns.length === 1 &&
          !target.tenantScoped &&
          target.columns.some(
            (column) =>
              column.name === constraint.references.columns[0] && column.primaryKey === true,
          )) ||
        (constraint.references.columns.length === 2 &&
          constraint.references.columns[0] === "tenant_id" &&
          target.tenantScoped === true &&
          target.columns.some(
            (column) =>
              column.name === constraint.references.columns[1] && column.primaryKey === true,
          )) ||
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
  return { plugin, version: migration.version, checksum: checksum(sql), sql };
}

/**
 * Build the one immutable migration registry consumed by the API migrator.
 * Constraint migrations and free-form plugin DDL share a plugin-local version
 * namespace, so ordering and collisions are explicit rather than dependent on
 * object iteration.
 */
export function collectPluginMigrationRegistry(
  manifest: PlatformSchemaManifest,
  plugins: readonly CompilerPlugin[],
  context?: PluginBaseContext,
): GeneratedPluginMigrationRegistry {
  const entries: GeneratedPluginMigration[] = [];
  assertConstraintRelations(manifest);
  assertForeignKeyTargets(manifest);

  for (const table of manifest.tables) {
    const constraintNames = new Set<string>();
    for (const constraint of table.constraints ?? []) {
      if (constraintNames.has(constraint.name)) {
        throw new Error(
          `Table ${table.schema}.${table.name} declares duplicate constraint name "${constraint.name}".`,
        );
      }
      constraintNames.add(constraint.name);
      const plugin = table.pluginOwner;
      if (!plugin) {
        throw new Error(
          `Table ${table.schema}.${table.name} declares versioned constraint ${constraint.name} but has no plugin owner. Table constraints are currently a compiler-plugin contract.`,
        );
      }
      assertMigrationIdentity(plugin, constraint.version);
      const sql = renderConstraintSql(table, constraint);
      entries.push({
        plugin,
        version: constraint.version,
        checksum: checksum(sql),
        sql,
      });
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
