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

/**
 * Strict SQL column-identifier allowlist. Authoring-controlled column names
 * (persisted.column, belongsTo foreignKey — and, transitively, the
 * authorization owner/group columns which must reference one of these) flow
 * verbatim into generated DDL and RLS predicates via quoteIdent(). Anything
 * outside a plain lowercase snake_case identifier is rejected here, BEFORE any
 * SQL is emitted, so a hostile name like `foo" GENERATED ALWAYS ... --` or one
 * that closes the RLS predicate paren can never reach the generator. quoteIdent
 * still escapes embedded quotes as defense-in-depth, but this is the primary
 * guard.
 */
const SAFE_COLUMN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function validateColumnIdentifier(column: string, source: string): void {
  if (!SAFE_COLUMN_IDENTIFIER.test(column)) {
    throw new Error(
      `Unsafe storage column name "${column}" (from ${source}) — column names must match ${SAFE_COLUMN_IDENTIFIER} ` +
        `(lowercase letters, digits, and underscores; not starting with a digit). ` +
        `This identifier is emitted into generated SQL DDL and RLS policies and cannot contain other characters.`,
    );
  }
}

export function resolveStorageColumns(
  coreFields: Field[],
  profiles: EntityProfile[],
  relationships: Relationship[]
): CompiledColumn[] {
  const columns: CompiledColumn[] = [];

  // Core fields
  for (const field of coreFields) {
    if (!field.persisted) continue;
    validateColumnIdentifier(field.persisted.column, `field "${field.key}" persisted.column`);
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
      validateColumnIdentifier(rel.foreignKey, `belongsTo "${rel.key}" foreignKey`);
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
      validateColumnIdentifier(
        field.persisted.column,
        `profile "${profile.profile}" field "${field.key}" persisted.column`,
      );
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
