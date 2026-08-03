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

/**
 * The authored disposition action, preserved verbatim so a future retention
 * executor can distinguish (e.g.) a crypto-erase from a value redaction — the
 * coarse {@link RetentionAction} collapses several of these to `redact`.
 */
export type RetentionDisposition =
  | "keep"
  | "archive"
  | "delete"
  | "anonymize"
  | "mask"
  | "cryptoDelete"
  | "review";

export type RetentionDuration = {
  years?: number;
  months?: number;
  days?: number;
};

/**
 * Human-review gate that must be cleared before a rule's disposition may run.
 * Carried through so an executor can route records to the named queue instead
 * of destroying them unattended.
 */
export type RetentionReviewGate = {
  required: boolean;
  queue?: string;
};

export type RetentionRuleDefinition = {
  id: string;
  after: RetentionDuration;
  action: RetentionAction;
  /** Authored disposition before {@link RetentionAction} coarsening. */
  disposition?: RetentionDisposition;
  reason?: string;
  /** Human-review gate that must clear before this rule may act. */
  review?: RetentionReviewGate;
  /**
   * Present when the disposition is `cryptoDelete`: the key an executor must
   * destroy to render the record unrecoverable, rather than deleting rows.
   */
  cryptoDelete?: {
    keyReference?: string;
  };
};

/**
 * Legal-hold / litigation-hold control plane. When `suspendDestruction` is
 * true a retention executor MUST NOT run any destructive disposition for the
 * table, regardless of clock expiry, until the hold is lifted.
 */
export type RetentionLegalHold = {
  suspendDestruction: boolean;
};

/**
 * Advisory metadata describing how a data-subject erasure request should
 * cascade from this table to dependent PII. This is metadata only: no runtime
 * enforcement exists yet (tracked as a follow-up). Downstream tooling and
 * operators consume it to drive/verify ordered erasure.
 */
export type RetentionErasure = {
  /** This table participates in subject-scoped erasure. */
  subjectScoped?: boolean;
  /** Columns that identify the data subject (e.g. relation_id). */
  subjectColumns?: string[];
  /** Dependent tables that must be erased when this subject is erased. */
  cascades?: Array<{
    schema: string;
    table: string;
    /** Column on the dependent table referencing this table. */
    via: string;
  }>;
};

export type RetentionDefinition = {
  clock: {
    column: string;
    /** Column type of the clock anchor. `date` anchors are permitted. */
    type?: "timestamptz" | "date";
    fallbackColumns?: string[];
  };
  rules: RetentionRuleDefinition[];
  /** Legal hold that suspends all destructive dispositions while active. */
  legalHold?: RetentionLegalHold;
  /** Subject-erasure cascade metadata (advisory; no runtime enforcement yet). */
  erasure?: RetentionErasure;
  source?: string;
};

/**
 * Data-classification tier for a column, carried from the authoring
 * `classification.sensitivity` of the field that backs it. Consumed at runtime
 * to redact sensitive columns from readers who lack a write-grant on the entity
 * (field-level data protection — issues #96/#101). `public`/`internal` are not
 * emitted (they impose no restriction); only the restricting tiers surface.
 */
export type ColumnSensitivity = "confidential" | "pii" | "bsn";

export type ColumnDefinition = {
  name: string;
  type: ScalarType;
  primaryKey?: boolean;
  required?: boolean;
  default?: string;
  generated?: "identity";
  references?: ReferenceDefinition;
  sourceField?: string;
  /**
   * Data-classification tier propagated from the authoring field's
   * `classification.sensitivity`. Only the restricting tiers
   * (`confidential`/`pii`/`bsn`) are recorded; `public`/`internal` are omitted
   * so byte-identical output is preserved for unclassified columns.
   */
  classification?: ColumnSensitivity;
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
  /**
   * Opt-in generated REST exposure for this table. Present only when the
   * authoring entity declared a `rest:` block AND the table is generated-CRUD
   * enabled — the backend manifest fails compilation on the mismatch. The
   * API runtime registers Fastify routes under /api/rest/v1/{basePath} for
   * each enabled operation, delegating to the same generated CRUD layer as
   * GraphQL.
   */
  rest?: {
    basePath: string;
    operations: {
      list: boolean;
      get: boolean;
      create: boolean;
      update: boolean;
      delete: boolean;
    };
  };
  /**
   * Opt-in generated MCP exposure for this table (entity YAML `mcp:` block).
   * Present only when the entity declared one AND the table is generated-CRUD
   * enabled — the backend manifest fails compilation on the mismatch, exactly
   * as it does for `rest`.
   *
   * This block says only WHICH tools exist. Their input schemas live in the
   * separate `mcp/tools.json` artifact, which is generated from the compiled
   * contracts because the authored labels, validation, and enumerations that
   * make those schemas useful are not carried in this manifest.
   */
  mcp?: {
    toolPrefix: string;
    tools: "dedicated" | "generic";
    operations: {
      list: boolean;
      get: boolean;
      create: boolean;
      update: boolean;
      delete: boolean;
    };
  };
  /**
   * Per-operation entity role allow-lists, bridged from the authored
   * `authorization.roles` block. Each list is the deduplicated, sorted union
   * of the authored names and their Keycloak-normalized forms (Dutch →
   * English, e.g. `Relaties.All.Read` + `Relations.All.Read`), so the API
   * runtime can enforce with a plain case-sensitive set intersection against
   * session roles from either a bearer token (normalized names) or
   * trusted-context headers (authored names).
   *
   * Enforced fail-closed BEFORE the DB call (issue #94): a session whose roles
   * do not intersect the required set for an operation is rejected with a
   * FORBIDDEN error. The gate lives in the generated CRUD layer, so both the
   * GraphQL resolvers and the REST routes are covered.
   */
  authorization?: {
    roles: {
      read: string[];
      create: string[];
      update: string[];
      delete: string[];
    };
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
  /**
   * The worker role permitted to reach this table ACROSS tenants — rendered as
   * an extra `app.current_worker_role() = '<role>'` disjunct in the emitted
   * policy, next to the existing `app.bypass_rls()` short-circuit.
   *
   * This axis WIDENS, unlike every other one here: `rowScope`'s group and user
   * axes narrow within a tenant, and the tenant predicate is always required
   * alongside them. This admits a session that has no tenant at all.
   *
   * It exists so a queue-draining worker reads the queue BECAUSE A POLICY SAYS
   * SO rather than by setting `app.bypass_rls`, which is all-or-nothing across
   * every tenant-scoped table in the manifest. Declare it only on queue-shaped
   * tables a worker claims from — never on a table holding tenant business
   * data, where the correct grant is a tenant-scoped session and not this.
   *
   * Requires `tenantScoped: true`: on a global table there is no tenant
   * boundary to widen, so accepting it would imply a guarantee that is not
   * there.
   *
   * What this is NOT: authentication. `app.worker_role` is a GUC, so anything
   * that can set a GUC can claim to be a worker — exactly as true of
   * `app.bypass_rls`. The boundary is that the API's request path never sets it
   * and a worker's boot path does; that is a code boundary, not a database one.
   * Making it a database boundary means a separate Postgres role with its own
   * grants.
   */
  workerAccess?: string;
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
