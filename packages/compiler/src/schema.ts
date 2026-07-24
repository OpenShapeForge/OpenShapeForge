// SPDX-License-Identifier: BUSL-1.1
export type ScalarType =
  | "uuid"
  | "text"
  | "boolean"
  | "integer"
  | "bigint"
  | "numeric"
  | "date"
  | "timestamptz"
  | "jsonb";

export type ReferenceDefinition = {
  schema: string;
  table: string;
  column: string;
  onDelete?: "CASCADE" | "RESTRICT" | "SET NULL";
};

export type IndexDefinition = {
  name: string;
  columns: string[];
  /**
   * When true, the generated SQL emits `CREATE UNIQUE INDEX` instead of
   * `CREATE INDEX`. Used by entities that depend on database-enforced
   * uniqueness for their `ON CONFLICT (...) DO NOTHING` idempotency
   * patterns (e.g. financial run/run-item ledgers).
   */
  unique?: boolean;
  /**
   * Optional partial-index predicate, emitted as `WHERE <predicate>`. Used by
   * RowScope-emitted indexes (e.g. `WHERE assignee_id IS NOT NULL`) so the
   * index stays narrow when most rows have no assignee/owner.
   */
  where?: string;
};

/**
 * Multi-axis row-level access policy.
 *
 * Generates a single policy with OR-combined predicates over three axes:
 *   tenant : tenant_id = app.current_tenant() (always required)
 *   group  : group column = ANY(app.current_groups())
 *   user   : user columns = app.current_user_id()
 *
 * Plus an outermost `app.bypass_rls()` short-circuit and an
 * `app.has_scope('tenant')` shortcut for bypass-role users.
 *
 * Performance contract: every column referenced here must have a matching
 * composite index emitted in the same migration. The compiler emits those
 * indexes automatically (see deriveRowScopeIndexes).
 */
export type RowScopePolicy = {
  /**
   * The group axis. Optional — entities that only use tenant + user axes
   * leave this undefined.
   */
  group?: {
    column: string;
    /**
     * Controls how the group set is expanded relative to the user's directly
     * bound org units:
     *   descendants -- visibility extends DOWN the hierarchy (default)
     *   ancestors   -- visibility extends UP the hierarchy
     *   exact       -- no expansion; only the directly bound groups match
     *
     * Resolution happens at login (identity resolver) against
     * erp.org_unit_closure. Policies always compare to the already-expanded
     * `app.current_groups()` array, so this field is metadata for the
     * resolver, not the policy.
     */
    expand?: "descendants" | "ancestors" | "exact";
  };
  /**
   * The user axis. Each column listed is OR-combined with the others; a row
   * is visible if ANY listed column equals the current user id.
   */
  userColumns?: string[];
  /**
   * Owner/group columns whose NULL rows are visible tenant-wide (the
   * `empty: public` semantics). Each column listed here emits an extra
   * `"{col}" IS NULL` OR-branch alongside the axis predicate, so an unowned
   * (NULL-column) row stays visible to every user in the tenant. When a
   * column is absent from this list, NULL-column rows match no branch and are
   * hidden (`empty: restricted`).
   */
  nullVisibleColumns?: string[];
  /**
   * Roles that grant tenant-wide scope (the `app.has_scope('tenant')`
   * shortcut). The identity resolver inspects this set to set `app.scope`
   * at session establishment.
   */
  bypassRoles?: string[];
};

export type RetentionAction = "retain" | "archive" | "redact" | "delete";

export type RetentionDuration = {
  years?: number;
  months?: number;
  days?: number;
};

export type RetentionRuleDefinition = {
  id: string;
  after: RetentionDuration;
  action: RetentionAction;
  reason?: string;
};

export type RetentionDefinition = {
  clock: {
    column: string;
    fallbackColumns?: string[];
  };
  rules: RetentionRuleDefinition[];
  source?: string;
};

export type ColumnDefinition = {
  name: string;
  type: ScalarType;
  primaryKey?: boolean;
  required?: boolean;
  default?: string;
  generated?: "identity";
  references?: ReferenceDefinition;
  sourceField?: string;
};

export type LocalizedTextManifest = {
  en?: string;
  nl?: string;
  fr?: string;
};

export type TableSourceDefinition = {
  path?: string;
  authoringEntityName?: string;
  authoringEntitySlug?: string;
  generatedCrudEligibility?: "explicitly_enabled" | "explicitly_disabled";
  /**
   * Authored localized labels for the entity (e.g. `{ en: "Contact Moment",
   * nl: "Contactmoment" }`). Surfaced for service-side consumers that render
   * entity-typed strings (timeline projection, audit summaries) without
   * hard-coding per-entity Dutch labels in the API.
   */
  labels?: LocalizedTextManifest;
  /**
   * Authored mustache-style display template for an instance of this entity
   * (e.g. `"{{subject}}"`, `"{{firstName}} {{lastName}}"`). Surfaced so the
   * service can render a friendly instance description (timeline, audit) by
   * evaluating the template against the source row, using the column
   * `sourceField` map to bridge authoring fields → DB columns.
   */
  displayTemplate?: string;
  graphql?: {
    typeName: string;
    singleQueryName: string;
    listQueryName: string;
    createMutationName: string;
    updateMutationName: string;
    deleteMutationName: string;
    relationships: Array<{
      name: string;
      target: string;
      type: string;
      resolve: "belongsTo" | "hasMany";
      foreignKey?: string;
    }>;
    /**
     * Effective default sort for any embedded list rendering of this entity.
     *
     * Derived once per entity by the compiler from the entity's compiled
     * view presentations (preferring `core.listCompact.defaultSort` over
     * `core.list.defaultSort`). Surfaced here so the API can apply it
     * uniformly when resolving `hasMany` relationships — without each
     * embedded list having to repeat the sort, and without the resolver
     * having to introspect compiled views at runtime.
     *
     * `field` is the camelCase field name (e.g. `occurredAt`) — the API's
     * generated CRUD resolver maps it back to the underlying column via
     * `fieldColumnMap`.
     */
    defaultSort?: { field: string; direction: "asc" | "desc" };
  };
  relationshipStatus?: {
    emittedReferences: string[];
    skippedReferences: string[];
  };
  retentionSource?: string;
};

export type TableDefinition = {
  schema: string;
  name: string;
  tenantScoped: boolean;
  domainInternal?: boolean;
  generatedCrud?: boolean;
  columns: ColumnDefinition[];
  indexes?: IndexDefinition[];
  retention?: RetentionDefinition;
  source?: TableSourceDefinition;
  /**
   * Multi-axis RLS configuration. When set, the emitter renders the
   * canonical group/user policy alongside the tenant predicate AND emits
   * the supporting composite indexes. Requires `tenantScoped: true`.
   */
  rowScope?: RowScopePolicy;
};

export type RelationshipRegisterEntry = {
  from: {
    schema: string;
    table: string;
    column: string;
  };
  to: {
    schema: string;
    table: string;
    column: string;
  };
};

export type PlatformSchemaManifest = {
  version: number;
  description?: string;
  relationshipRegister?: RelationshipRegisterEntry[];
  tables: TableDefinition[];
};

export type GeneratedArtifact = {
  path: string;
  contents: string;
};
