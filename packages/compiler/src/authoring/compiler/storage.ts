// @ts-nocheck
/**
 * Storage compiler — maps entity fields to SQL column definitions.
 *
 * Pipeline position: called early by the main compiler orchestrator. Processes
 * core fields, belongsTo foreign key columns, and profile-specific fields into
 * a flat list of CompiledColumn objects. Only persisted fields (those with a
 * `persisted` config) produce columns. Validates that no duplicate column names exist.
 *
 * Input:  Core Field[], EntityProfile[], Relationship[] (for FK columns).
 * Output: CompiledColumn[] — column name, SQL type, nullable flag, storage class.
 */
import type { Field, EntityProfile, Relationship, CompiledColumn } from "../types.js";
import { fieldSqlType } from "./helpers.js";

export function resolveStorageColumns(
  coreFields: Field[],
  profiles: EntityProfile[],
  relationships: Relationship[]
): CompiledColumn[] {
  const columns: CompiledColumn[] = [];

  // Core fields
  for (const field of coreFields) {
    if (!field.persisted) continue;
    columns.push({
      field: field.key,
      column: field.persisted.column,
      type: fieldSqlType(field),
      nullable: !field.required,
      storageClass: "core",
    });
  }

  // belongsTo FK columns.
  //
  // Tenant is special: the user-facing tenant identifier across the system
  // (JWT `tid` claim, RLS `app.tenant_id` session var, `entity_row_access.group_id`)
  // is the tenant *slug*, not the synthetic UUID primary key. So a `belongsTo: Tenant`
  // FK is emitted as `text not null` referencing `tenants(slug)`, not `uuid` referencing
  // `tenants(id)`. This keeps tenant-scoped tables joinable directly against the slug
  // the JWT delivers, instead of forcing a slug→uuid lookup on every authenticated
  // request. See generators/db.ts for the matching FK target column.
  for (const rel of relationships) {
    if (rel.kind === "belongsTo" && rel.foreignKey) {
      if (!columns.some((c) => c.column === rel.foreignKey)) {
        const isTenantFk = rel.target === "Tenant";
        columns.push({
          field: rel.key + "Id",
          column: rel.foreignKey,
          type: isTenantFk ? "text" : "uuid",
          nullable: !isTenantFk,
          storageClass: "core",
        });
      }
    }
  }

  // Profile fields
  for (const profile of profiles) {
    if (!profile.fields) continue;
    for (const field of profile.fields) {
      if (!field.persisted) continue;
      columns.push({
        field: field.key,
        column: field.persisted.column,
        type: fieldSqlType(field),
        nullable: !field.required,
        storageClass: "profile",
        profile: profile.profile,
      });
    }
  }

  // Detect duplicate column names
  const seenColumns = new Set<string>();
  for (const col of columns) {
    if (seenColumns.has(col.column)) {
      throw new Error(`Duplicate storage column "${col.column}" — would produce invalid SQL`);
    }
    seenColumns.add(col.column);
  }

  return columns;
}
