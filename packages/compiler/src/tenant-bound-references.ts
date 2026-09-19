// SPDX-License-Identifier: BUSL-1.1
/**
 * Tenant safety by construction for every foreign key the compiler emits.
 *
 * A foreign-key check runs as the table owner and is exempt from row-level
 * security, so a single-column reference into a tenant-scoped table happily
 * accepts a row of another tenant. The rule enforced here is therefore
 * structural rather than policy-based: a reference into a tenant-scoped
 * table carries the tenant on both sides, `(tenant, column) -> (tenant_id,
 * id)`, and the local tenant column is the referencing row's own tenant
 * identity. A foreign tenant is then not forbidden but unexpressible.
 *
 * Every manifest passes through `generateArtifacts`, so the assertion lives
 * there rather than in the entity compiler alone: platform tables, plugin
 * tables and promoted entities are held to the same rule.
 */
import type { ColumnDefinition, PlatformSchemaManifest, TableDefinition } from "./schema.js";

export const TENANT_COLUMN = "tenant_id";

function tableKey(table: Pick<TableDefinition, "schema" | "name">): string {
  return `${table.schema}.${table.name}`;
}

function columnKey(table: TableDefinition, column: ColumnDefinition): string {
  return `${tableKey(table)}.${column.name}`;
}

/**
 * The column that identifies the tenant of a row in `table`: `tenant_id` on a
 * tenant-scoped table, `tenantIdentityColumn` on a tenant registry, and
 * `tenant_id` when a global table carries one (an authentication table whose
 * tenant is an output of the lookup, not an input). Undefined when the table
 * has no tenant column at all.
 */
function tenantIdentityColumn(table: TableDefinition): string | undefined {
  if (table.tenantScoped) return TENANT_COLUMN;
  if (table.tenantIdentityColumn) return table.tenantIdentityColumn;
  return table.columns.some((column) => column.name === TENANT_COLUMN) ? TENANT_COLUMN : undefined;
}

/**
 * Refuse every reference into a tenant-scoped table that does not bind the
 * tenant. Also refuses references whose target table or column does not
 * exist, which is what makes the message name the real fix.
 */
export function assertTenantBoundReferences(manifest: PlatformSchemaManifest): void {
  const tables = new Map(manifest.tables.map((table) => [tableKey(table), table]));
  for (const table of manifest.tables) {
    for (const column of table.columns) {
      const reference = column.references;
      if (!reference) continue;
      const targetKey = `${reference.schema}.${reference.table}`;
      const target = tables.get(targetKey);
      if (!target) {
        throw new Error(`${columnKey(table, column)} references unknown table ${targetKey}.`);
      }
      if (!target.columns.some((candidate) => candidate.name === reference.column)) {
        throw new Error(
          `${columnKey(table, column)} references unknown column ${targetKey}.${reference.column}.`,
        );
      }
      if (!target.tenantScoped) continue;
      // The referencing row's own tenant identity pointing at a tenant row is
      // the binding itself; prefixing it again would compare a column with
      // itself.
      if (column.name === tenantIdentityColumn(table)) continue;

      const localColumns = reference.localColumns ?? [column.name];
      const targetColumns = reference.targetColumns ?? [reference.column];
      const tenantPosition = targetColumns.indexOf(TENANT_COLUMN);
      const localTenant = tenantIdentityColumn(table);
      if (tenantPosition < 0) {
        const fix =
          `set references.localColumns: [${localTenant ?? "<tenant column>"}, ${column.name}] ` +
          `and references.targetColumns: [${TENANT_COLUMN}, ${reference.column}]`;
        throw new Error(
          table.tenantScoped
            ? `${columnKey(table, column)} references tenant-scoped ${targetKey} by (${column.name}) alone; ` +
              `a tenant-scoped row must reuse its own tenant: ${fix}.`
            : `Global table ${tableKey(table)} may reference tenant-scoped ${targetKey} only through an explicit ` +
              `tenant column pair, but ${column.name} references it by (${column.name}) alone: ${fix}.`,
        );
      }
      const localTenantColumn = localColumns[tenantPosition];
      if (table.tenantScoped && localTenantColumn !== TENANT_COLUMN) {
        throw new Error(
          `${columnKey(table, column)} binds ${targetKey}.${TENANT_COLUMN} to ${localTenantColumn}; ` +
            `a tenant-scoped row must reuse its own ${TENANT_COLUMN} (references.localColumns: [${TENANT_COLUMN}, ${column.name}]).`,
        );
      }
      const local = table.columns.find((candidate) => candidate.name === localTenantColumn);
      if (!local || local.type !== "uuid" || !(local.required || local.primaryKey)) {
        throw new Error(
          `${columnKey(table, column)} binds ${targetKey}.${TENANT_COLUMN} to ${localTenantColumn}, ` +
            `which must be a required UUID column of ${tableKey(table)}; a nullable tenant leaves the foreign key unchecked.`,
        );
      }
    }
  }
}

/**
 * A composite reference needs a matching unique index on its target. The
 * entity compiler adds `(tenant_id, id)` as it attaches each reference; this
 * does the same for references declared on platform and plugin tables, so a
 * YAML author names the pair and nothing else.
 */
export function ensureCompositeReferenceKeys(manifest: PlatformSchemaManifest): void {
  const tables = new Map(manifest.tables.map((table) => [tableKey(table), table]));
  for (const table of manifest.tables) {
    for (const column of table.columns) {
      const targetColumns = column.references?.targetColumns;
      if (!column.references || !targetColumns) continue;
      const target = tables.get(`${column.references.schema}.${column.references.table}`);
      if (!target) continue;
      const indexes = target.indexes ??= [];
      if (indexes.some((index) => index.unique && !index.where &&
        index.columns.length === targetColumns.length &&
        index.columns.every((name, position) => name === targetColumns[position]))) continue;
      const name = `${target.name}_${targetColumns.join("_")}_key`;
      if (indexes.some((index) => index.name === name)) {
        throw new Error(`Composite reference key collides with ${tableKey(target)}.${name}.`);
      }
      indexes.push({ name, columns: [...targetColumns], unique: true });
    }
  }
}
