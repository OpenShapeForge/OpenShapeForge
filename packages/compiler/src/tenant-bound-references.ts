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
 * tables, promoted entities, column references and table-level foreignKey
 * constraints are held to the same rule.
 *
 * The one single-column key into a tenant-scoped table that is accepted is a
 * row's own tenant column pointing at a tenant registry entity — and only
 * when that registry carries CHECK (id = tenant_id). The key alone would
 * not prove anything: a foreign-key check runs without row-level security,
 * so `tenant_id -> tenants(id)` accepts any registry row. With the check,
 * the referenced row's id is its tenant, and that id is the referencing
 * row's tenant: bound, structurally. The entity compiler stamps the check
 * on the registry as it attaches the reference (backend-manifest.ts).
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

/** The check a tenant registry entity carries so that its `id` IS its tenant. */
export const TENANT_IDENTITY_CHECK_EXPRESSION = "id = tenant_id";

export function tenantIdentityCheckName(table: Pick<TableDefinition, "name">): string {
  return `${table.name}_tenant_identity_check`;
}

/**
 * Whether `table` proves `id = tenant_id` on every row. A row's own
 * `tenant_id` referencing such a table is therefore bound: the referenced
 * row's tenant is its id, which is the referencing row's tenant. Without the
 * check the single-column key would accept any tenant-scoped row, because a
 * foreign-key check bypasses row-level security.
 */
export function hasTenantIdentityCheck(table: TableDefinition): boolean {
  return (table.constraints ?? []).some((constraint) =>
    constraint.kind === "check" &&
    constraint.expression.replace(/\s+/g, " ").trim() === TENANT_IDENTITY_CHECK_EXPRESSION);
}

type BoundReference = {
  label: string;
  /** The column the reference is declared on; the whole key for a table constraint. */
  declaredColumn: string;
  localColumns: readonly string[];
  targetColumns: readonly string[];
  target: TableDefinition;
  /** How the local and target column lists are spelled where this reference is authored. */
  spelling: { local: string; target: string };
};

export const columnReferenceSpelling = { local: "references.localColumns", target: "references.targetColumns" };
export const tableConstraintSpelling = { local: "columns", target: "references.columns" };

/**
 * Every referenced column must exist on the target and match the type of the
 * local column it pairs with; a name that only fails inside PostgreSQL would
 * surface at migrate time, after generation had claimed success.
 */
function assertReferencePairs(
  table: TableDefinition,
  label: string,
  localColumns: readonly string[],
  targetColumns: readonly string[],
  target: TableDefinition,
): void {
  const targetKey = tableKey(target);
  if (localColumns.length !== targetColumns.length || localColumns.length === 0) {
    throw new Error(`${label} pairs ${localColumns.length} local column(s) with ${targetColumns.length} referenced column(s).`);
  }
  targetColumns.forEach((name, position) => {
    const targetColumn = target.columns.find((candidate) => candidate.name === name);
    if (!targetColumn) throw new Error(`${label} references unknown column ${targetKey}.${name}.`);
    const local = table.columns.find((candidate) => candidate.name === localColumns[position]);
    if (!local) throw new Error(`${label} names unknown local column ${localColumns[position]}.`);
    if (local.type !== targetColumn.type) {
      throw new Error(
        `${label} pairs ${tableKey(table)}.${local.name} (${local.type}) with ${targetKey}.${name} (${targetColumn.type}); the types must match.`,
      );
    }
  });
}

function assertBoundReference(table: TableDefinition, reference: BoundReference): void {
  const { label, declaredColumn, localColumns, targetColumns, target, spelling } = reference;
  const targetKey = tableKey(target);
  assertReferencePairs(table, label, localColumns, targetColumns, target);
  if (!target.tenantScoped) return;
  if (localColumns.length === 1 && declaredColumn === tenantIdentityColumn(table)) {
    const identity = table.columns.find((candidate) => candidate.name === declaredColumn);
    if (!identity || identity.type !== "uuid" || !(identity.required || identity.primaryKey)) {
      throw new Error(
        `${label} is the row's tenant identity and must be a required UUID column; a nullable tenant leaves the foreign key unchecked.`,
      );
    }
    if (targetColumns.length !== 1 || targetColumns[0] !== "id") {
      throw new Error(
        `${label} is the row's tenant identity and may only reference ${targetKey}.id, not (${targetColumns.join(", ")}).`,
      );
    }
    if (hasTenantIdentityCheck(target)) return;
    throw new Error(
      `${label} is the row's tenant identity but ${targetKey} does not prove id = tenant_id; ` +
        `only a tenant registry carrying CHECK (${TENANT_IDENTITY_CHECK_EXPRESSION}) may be referenced by a tenant column alone.`,
    );
  }
  const tenantPosition = targetColumns.indexOf(TENANT_COLUMN);
  const localTenant = tenantIdentityColumn(table);
  const targetIdColumn = targetColumns.find((name) => name !== TENANT_COLUMN) ?? "id";
  if (tenantPosition < 0) {
    const key = `(${localColumns.join(", ")})`;
    const fix =
      `set ${spelling.local}: [${localTenant ?? "<tenant column>"}, ${declaredColumn}] ` +
      `and ${spelling.target}: [${TENANT_COLUMN}, ${targetIdColumn}]`;
    throw new Error(
      table.tenantScoped
        ? `${label} references tenant-scoped ${targetKey} by ${key} alone; ` +
          `a tenant-scoped row must reuse its own tenant: ${fix}.`
        : `Global table ${tableKey(table)} may reference tenant-scoped ${targetKey} only through an explicit ` +
          `tenant column pair, but ${declaredColumn} references it by ${key} alone: ${fix}.`,
    );
  }
  const localTenantColumn = localColumns[tenantPosition]!;
  if (table.tenantScoped && localTenantColumn !== TENANT_COLUMN) {
    throw new Error(
      `${label} binds ${targetKey}.${TENANT_COLUMN} to ${localTenantColumn}; ` +
        `a tenant-scoped row must reuse its own ${TENANT_COLUMN} (${spelling.local}: [${TENANT_COLUMN}, ${declaredColumn}]).`,
    );
  }
  const local = table.columns.find((candidate) => candidate.name === localTenantColumn);
  if (!local || local.type !== "uuid" || !(local.required || local.primaryKey)) {
    throw new Error(
      `${label} binds ${targetKey}.${TENANT_COLUMN} to ${localTenantColumn}, ` +
        `which must be a required UUID column of ${tableKey(table)}; a nullable tenant leaves the foreign key unchecked.`,
    );
  }
}

/**
 * Refuse every reference into a tenant-scoped table that does not bind the
 * tenant — column references and table-level foreignKey constraints alike.
 * Also refuses references whose target table or column does not exist,
 * which is what makes the message name the real fix.
 */
export function assertTenantBoundReferences(manifest: PlatformSchemaManifest): void {
  const tables = new Map(manifest.tables.map((table) => [tableKey(table), table]));
  const resolve = (label: string, schema: string, name: string): TableDefinition => {
    const targetKey = `${schema}.${name}`;
    const target = tables.get(targetKey);
    if (!target) throw new Error(`${label} references unknown table ${targetKey}.`);
    return target;
  };
  for (const table of manifest.tables) {
    for (const column of table.columns) {
      const reference = column.references;
      if (!reference) continue;
      const label = columnKey(table, column);
      if ((reference.localColumns === undefined) !== (reference.targetColumns === undefined)) {
        throw new Error(`Invalid composite foreign key ${label}: localColumns and targetColumns go together.`);
      }
      const targetColumns = reference.targetColumns ?? [reference.column];
      const target = resolve(label, reference.schema, reference.table);
      if (!target.columns.some((candidate) => candidate.name === reference.column)) {
        throw new Error(`${label} references unknown column ${tableKey(target)}.${reference.column}.`);
      }
      assertBoundReference(table, {
        label, declaredColumn: column.name, target, spelling: columnReferenceSpelling,
        localColumns: reference.localColumns ?? [column.name], targetColumns,
      });
    }
    for (const constraint of table.constraints ?? []) {
      if (constraint.kind !== "foreignKey") continue;
      const label = `Foreign key ${tableKey(table)}.${constraint.name}`;
      const target = resolve(label, constraint.references.schema, constraint.references.table);
      const declaredColumn = constraint.columns.find((name) => name !== tenantIdentityColumn(table)) ?? constraint.columns[0]!;
      assertBoundReference(table, {
        label, declaredColumn, target, spelling: tableConstraintSpelling,
        localColumns: constraint.columns, targetColumns: constraint.references.columns,
      });
    }
  }
}

/**
 * The `ON DELETE` clause of a foreign key. `SET NULL` nulls every column of
 * the key unless told which; on a tenant-bound key that would be the row's
 * NOT NULL tenant_id, or a registry's own primary key. The clause therefore
 * names the nullable columns alone (`SET NULL (a, b)`, PostgreSQL 15+), and
 * a key whose reference columns are all NOT NULL cannot carry SET NULL: the
 * delete would fail instead of clearing the pointer.
 */
export function renderOnDeleteSql(
  table: TableDefinition,
  label: string,
  localColumns: readonly string[],
  action: "CASCADE" | "RESTRICT" | "SET NULL" | undefined,
): string {
  if (!action) return "";
  if (action !== "SET NULL") return ` ON DELETE ${action}`;
  const nullable = localColumns.filter((name) => {
    const column = table.columns.find((candidate) => candidate.name === name);
    return column && !column.required && !column.primaryKey;
  });
  const tenant = tenantIdentityColumn(table);
  const pointers = localColumns.filter((name) => name !== tenant);
  if (pointers.length === 0 || pointers.some((name) => !nullable.includes(name))) {
    throw new Error(
      `${label} is NOT NULL and cannot use ON DELETE SET NULL; ` +
        "make the column nullable or choose CASCADE or RESTRICT.",
    );
  }
  if (nullable.length === localColumns.length && localColumns.length === 1) return " ON DELETE SET NULL";
  return ` ON DELETE SET NULL (${nullable.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ")})`;
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
      const label = columnKey(table, column);
      const target = tables.get(`${column.references.schema}.${column.references.table}`);
      if (!target) throw new Error(`${label} references unknown table ${column.references.schema}.${column.references.table}.`);
      assertReferencePairs(table, label, column.references.localColumns ?? [column.name], targetColumns, target);
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
