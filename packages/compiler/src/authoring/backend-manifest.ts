// SPDX-License-Identifier: BUSL-1.1
import { join, relative } from "node:path";
import { compile } from "./compiler/index.js";
import type { CompiledEntityContract } from "./types/compiled.js";
import { isCollectionField } from "./compiler/helpers.js";
import {
  discoverContextEntities,
  listEntityFiles,
  loadContextEntity,
  loadEntity,
  resolveEntityFilePath,
} from "./loader.js";
import type {
  CompiledListView,
  CompiledNamedPresentation,
  CompiledViewContext,
  Field,
  RetentionPolicy,
} from "./types/index.js";
import type {
  ColumnDefinition,
  PlatformSchemaManifest,
  ReferenceDefinition,
  RelationshipRegisterEntry,
  RetentionAction,
  RetentionDefinition,
  RowScopePolicy,
  ScalarType,
  TableDefinition,
} from "../schema.js";
import type { CompiledAuthorization } from "./types/compiled.js";

export type AuthoringBackendMode = "report" | "promote";

export type ContextEntitySpec = {
  context: string;
  name: string;
};

export type CompileAuthoringBackendManifestOptions = {
  /**
   * Repo-root-relative prefix recorded as each table's provenance path.
   * Defaults to the in-repo authoring location; layered hosts pass the
   * resolved directory (e.g. ".authoring-build") so provenance stays honest.
   */
  sourcePathPrefix?: string;
  mode: AuthoringBackendMode;
  entityAllowlist: string[];
  contextEntityAllowlist?: ContextEntitySpec[];
  schemaByModule?: Record<string, string>;
  relationshipRegister?: RelationshipRegisterEntry[];
  generatedCrudAllowlist?: string[];
  contextEntityGeneratedCrudAllowlist?: ContextEntitySpec[];
  domainInternalEntities?: string[];
  /** Observe each compiled candidate (slug, provenance, contract) — used to
      build the plugin context without recompiling entities. */
  onCandidate?: (candidate: {
    slug: string;
    path: string;
    origin: "core" | "contextFull";
    contract: CompiledEntityContract;
  }) => void;
};

export type ColumnDiff = {
  column: string;
  current?: Partial<ColumnDefinition>;
  candidate?: Partial<ColumnDefinition>;
};

export type TableDiff = {
  table: string;
  authoringEntity: string;
  missingInCandidate: string[];
  addedByCandidate: string[];
  changedColumns: ColumnDiff[];
  changedMetadata: string[];
  emittedReferences: string[];
  skippedReferences: string[];
  matches: boolean;
};

export type AuthoringBackendReport = {
  generatedAt: string;
  mode: AuthoringBackendMode;
  coverage: {
    authoringEntityCount: number;
    uiEntityManifestCount?: number;
    candidateBackendEntityCount: number;
    candidateBackendEntities: string[];
  };
  tables: TableDiff[];
  hasDifferences: boolean;
};

type CandidateOrigin =
  | { kind: "core"; slug: string }
  | { kind: "contextFull"; context: string; name: string };

type CompiledCandidate = {
  /**
   * Stable, human-friendly identifier used for the manifest `source` block and
   * collision/CRUD allowlists. For core entities this is the kebab-case file
   * stem (e.g. `case`); for context-full entities this is the file stem too
   * (e.g. `eenheid`) — uniqueness across both kinds is enforced by the
   * pre-emission collision audit, not by the slug.
   */
  slug: string;
  origin: CandidateOrigin;
  path: string;
  contract: ReturnType<typeof compile>;
  fieldsByKey: Map<string, Field>;
};

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function snakeCase(value: string): string {
  return kebabCase(value).replace(/-/g, "_");
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function listAuthoringEntitySlugs(authoringDir: string): string[] {
  return listEntityFiles(authoringDir).map((file) => file.slug);
}

/**
 * Sorted catalog of every standalone context-full entity discovered under
 * `authoring/contexts/<context>/full/`. The order matches what the UI compiler
 * uses so candidate compilation is deterministic across both pipelines.
 */
export function listAuthoringContextEntitySpecs(authoringDir: string): ContextEntitySpec[] {
  return discoverContextEntities(authoringDir).sort((left, right) =>
    `${left.context}/${left.name}`.localeCompare(`${right.context}/${right.name}`),
  );
}

function flattenFields(fields: Field[] | undefined, result = new Map<string, Field>()) {
  for (const field of fields ?? []) {
    if (!result.has(field.key)) {
      result.set(field.key, field);
    }
    flattenFields(field.children, result);
    if (field.item) {
      flattenFields([field.item], result);
    }
  }
  return result;
}

function serviceScalarForField(field: Field): ScalarType {
  if (isCollectionField(field)) {
    return "jsonb";
  }
  if (field.valueType === "string" && field.validation?.format === "uuid") {
    return "uuid";
  }
  switch (field.valueType) {
    case "string":
      return "text";
    case "integer":
      return "integer";
    case "number":
      return "numeric";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "datetime":
      return "timestamptz";
    case "object":
      return "jsonb";
    default:
      throw new Error(`Unsupported authoring field valueType "${field.valueType}".`);
  }
}

function defaultSql(field: Field | undefined, column: ColumnDefinition): string | undefined {
  if (column.primaryKey && column.type === "uuid") {
    return "gen_random_uuid()";
  }
  if (
    column.type === "timestamptz" &&
    (column.name === "created_at" || column.name === "updated_at")
  ) {
    return "now()";
  }
  if (field?.defaultValue === undefined) {
    return undefined;
  }
  if (column.type === "boolean" && typeof field.defaultValue === "boolean") {
    return field.defaultValue ? "true" : "false";
  }
  if (
    (column.type === "integer" || column.type === "bigint") &&
    typeof field.defaultValue === "number" &&
    Number.isFinite(field.defaultValue)
  ) {
    return String(field.defaultValue);
  }
  if (column.type === "jsonb") {
    return `${quoteSqlString(JSON.stringify(field.defaultValue))}::jsonb`;
  }
  if (typeof field.defaultValue === "string") {
    return quoteSqlString(field.defaultValue);
  }
  return undefined;
}

function isRelationshipRegistered(
  register: RelationshipRegisterEntry[],
  from: { schema: string; table: string; column: string },
  to: { schema: string; table: string; column: string },
) {
  return register.some(
    (entry) =>
      entry.from.schema === from.schema &&
      entry.from.table === from.table &&
      entry.from.column === from.column &&
      entry.to.schema === to.schema &&
      entry.to.table === to.table &&
      entry.to.column === to.column,
  );
}

function tableKey(table: Pick<TableDefinition, "schema" | "name">): string {
  return `${table.schema}.${table.name}`;
}

function columnNames(table: TableDefinition): Set<string> {
  return new Set(table.columns.map((column) => column.name));
}

function filterRelationshipRegisterForTables(
  tables: TableDefinition[],
  register: RelationshipRegisterEntry[],
): RelationshipRegisterEntry[] {
  const tablesByKey = new Map(tables.map((table) => [tableKey(table), table]));
  return register.filter((entry) => {
    const from = tablesByKey.get(`${entry.from.schema}.${entry.from.table}`);
    const to = tablesByKey.get(`${entry.to.schema}.${entry.to.table}`);
    return (
      from !== undefined &&
      to !== undefined &&
      columnNames(from).has(entry.from.column) &&
      columnNames(to).has(entry.to.column)
    );
  });
}

/**
 * Translate compiled `authorization.rowAccess` into a `TableDefinition.rowScope`
 * policy. Emitted after every column (incl. auto tenant_id and FK-typed
 * owner/group columns) has materialized, so the belt-and-suspenders
 * column-presence check catches an FK that was skipped as cross-module
 * unregistered.
 *
 * Axes wired:
 *   - owner   → rowScope.userColumns = [owner.column]
 *   - group   → rowScope.group = { column, expand } (Phase 2). The emitter
 *     selects the session-groups reader by `expand`
 *     (descendants|ancestors|exact); expansion happens once per session.
 *   - empty:public → each axis column added to rowScope.nullVisibleColumns
 *     (NULL-column rows visible tenant-wide via the emitter's OR-NULL branch)
 *
 * Owner and group are independently combinable (both emit OR-branches).
 *
 * Fail-closed (§C.1): the owner/group column must exist and be uuid at emit
 * time. `empty: restricted` with no axis is guarded at the call site (§C.2),
 * not here.
 *
 * Returns undefined when there is no restriction axis (owner and group both
 * absent) — today's `empty: public` + no-owner + no-group entities are
 * explicitly NOT a restriction and compile to plain tenant scoping (documented
 * no-op), so the 3 shipped entities stay byte-identical.
 */
export function deriveRowScope(
  rowAccess: CompiledAuthorization["rowAccess"],
  entityName: string,
  columnsByName: Map<string, ColumnDefinition>,
): RowScopePolicy | undefined {
  if (!rowAccess?.enabled) return undefined;

  const userColumns: string[] = [];
  const nullVisibleColumns: string[] = [];
  let group: RowScopePolicy["group"] | undefined;

  const requireColumn = (col: string, axis: string) => {
    const c = columnsByName.get(col);
    if (!c) {
      throw new Error(
        `[${entityName}] authorization.rowAccess.${axis} column "${col}" is declared but ` +
          `no matching column was emitted (check the persisted field or belongsTo foreignKey).`,
      );
    }
    if (c.type !== "uuid") {
      throw new Error(
        `[${entityName}] authorization.rowAccess.${axis} column "${col}" must be uuid, found ${c.type}.`,
      );
    }
  };

  if (rowAccess.owner) {
    requireColumn(rowAccess.owner.column, "owner.column");
    userColumns.push(rowAccess.owner.column);
    if (rowAccess.empty === "public") nullVisibleColumns.push(rowAccess.owner.column);
  }
  if (rowAccess.group) {
    requireColumn(rowAccess.group.column, "group.column");
    group = {
      column: rowAccess.group.column,
      expand: rowAccess.group.expand ?? "descendants",
    };
    if (rowAccess.empty === "public") nullVisibleColumns.push(rowAccess.group.column);
  }

  // No restriction axis declared → plain tenant scoping (documented no-op).
  if (userColumns.length === 0 && !group) return undefined;

  return {
    ...(group ? { group } : {}),
    ...(userColumns.length > 0 ? { userColumns } : {}),
    ...(nullVisibleColumns.length > 0 ? { nullVisibleColumns } : {}),
    // bypassRoles wired in a later phase (see §E.3 note); omitted for now.
  };
}

function sortTablesByDependencies(tables: TableDefinition[]): TableDefinition[] {
  const pending = new Map(tables.map((table) => [tableKey(table), table]));
  const sorted: TableDefinition[] = [];
  const emitted = new Set<string>();

  while (pending.size > 0) {
    let progressed = false;
    for (const [key, table] of [...pending.entries()]) {
      const dependencies = table.columns
        .map((column) => column.references)
        .filter((reference): reference is NonNullable<ColumnDefinition["references"]> => {
          if (!reference) return false;
          const referenceKey = `${reference.schema}.${reference.table}`;
          return referenceKey !== key && pending.has(referenceKey);
        });
      if (dependencies.every((reference) => emitted.has(`${reference.schema}.${reference.table}`))) {
        sorted.push(table);
        emitted.add(key);
        pending.delete(key);
        progressed = true;
      }
    }
    if (!progressed) {
      for (const [key, table] of pending) {
        sorted.push(table);
        emitted.add(key);
      }
      pending.clear();
    }
  }

  return sorted;
}

function parseIsoDuration(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/.exec(value);
  if (!match) {
    return undefined;
  }
  const result: { years?: number; months?: number; days?: number } = {};
  if (match[1]) result.years = Number(match[1]);
  if (match[2]) result.months = Number(match[2]);
  if (match[3]) result.days = Number(match[3]);
  return Object.keys(result).length === 0 ? undefined : result;
}

function retentionAction(policy: RetentionPolicy | undefined): RetentionAction {
  const action = policy?.disposition?.action;
  switch (action) {
    // No disposition authored: fall back to the conservative, non-destructive
    // archive disposition.
    case undefined:
    // `review` (queue for a human decision) has no distinct runtime
    // RetentionAction; hold the data by archiving until the review resolves.
    case "review":
      return "archive";
    case "archive":
      return "archive";
    case "delete":
      return "delete";
    // anonymize / mask / cryptoDelete all reduce to the coarse "redact"
    // disposition the runtime manifest carries. The finer authored intent is
    // recorded on the source contract; it is intentionally not distinguished
    // here.
    case "anonymize":
    case "mask":
    case "cryptoDelete":
      return "redact";
    case "keep":
      return "retain";
    default:
      // An unrecognized action string is a misauthored policy. Fail the build
      // instead of silently reinterpreting it as archive.
      throw new Error(
        `Unknown retention disposition action ${JSON.stringify(action)}; ` +
          "expected one of keep, archive, delete, anonymize, mask, cryptoDelete, review.",
      );
  }
}

/**
 * Resolve authored entity-level indexes (field keys) into TableDefinition
 * indexes (column names). `tenantId` is accepted directly for tenant-scoped
 * tables since the compiler auto-attaches a `tenant_id` column.
 */
function compileEntityIndexes(
  candidate: CompiledCandidate,
  tenantScoped: boolean,
  columnsByField: Map<string, ColumnDefinition>,
): Array<{ name: string; columns: string[]; unique?: boolean }> {
  const authored = candidate.contract.entity.indexes ?? [];
  const compiled: Array<{ name: string; columns: string[]; unique?: boolean }> = [];
  for (const index of authored) {
    const resolvedColumns: string[] = [];
    for (const fieldKey of index.fields) {
      if (fieldKey === "tenantId" && tenantScoped) {
        resolvedColumns.push("tenant_id");
        continue;
      }
      const column = columnsByField.get(fieldKey);
      if (!column) {
        throw new Error(
          `Entity "${candidate.contract.entity.name}" index "${index.name}" references unknown field "${fieldKey}".`,
        );
      }
      resolvedColumns.push(column.name);
    }
    compiled.push({
      name: index.name,
      columns: resolvedColumns,
      ...(index.unique ? { unique: true } : {}),
    });
  }
  return compiled;
}

function compileRetention(
  candidate: CompiledCandidate,
  columnsByField: Map<string, ColumnDefinition>,
  columnsByName: Map<string, ColumnDefinition>,
): RetentionDefinition | undefined {
  const entityRetention = candidate.contract.retention?.entity;
  if (!entityRetention) {
    return undefined;
  }
  const entityName = candidate.contract.entity.name;
  let policy: RetentionPolicy | undefined;
  if (entityRetention.mode === "policyRef" && entityRetention.policy) {
    policy = candidate.contract.retention?.policies?.[entityRetention.policy];
    if (!policy) {
      // GDPR-relevant: a broken policyRef must fail the build, not silently
      // collapse to a default archive rule that masks the misconfiguration.
      throw new Error(
        `Entity "${entityName}" retention references unknown policy "${entityRetention.policy}". ` +
          `Add it to catalogs/retention-policies.yaml or fix the policyRef.`,
      );
    }
  } else {
    policy = entityRetention;
  }

  const rawDuration =
    typeof policy?.duration === "string"
      ? policy.duration
      : policy?.duration?.default ?? policy?.duration?.minimum ?? policy?.duration?.maximum;
  const parsedDuration = parseIsoDuration(rawDuration);
  if (typeof rawDuration === "string" && parsedDuration === undefined) {
    // An authored duration that fails the strict ISO-8601 parser must fail the
    // build rather than default to 7 years, which would mask the bad value.
    throw new Error(
      `Entity "${entityName}" retention has an unparseable ISO-8601 duration "${rawDuration}". ` +
        `Use a duration matching the pattern P<n>Y<n>M<n>D (e.g. P7Y).`,
    );
  }
  const duration = parsedDuration ?? { years: 7 };

  const startFields = [
    ...(entityRetention.startsFrom?.fields ?? []),
    ...(entityRetention.startsFrom?.field ? [entityRetention.startsFrom.field] : []),
  ];
  const clockColumns = startFields
    .map((fieldKey) => columnsByField.get(fieldKey))
    .filter((column): column is ColumnDefinition => column !== undefined)
    .filter((column) => columnsByName.get(column.name)?.type === "timestamptz");
  const [clock, ...fallbacks] = clockColumns;
  if (!clock) {
    return undefined;
  }

  return {
    clock: {
      column: clock.name,
      ...(fallbacks.length === 0 ? {} : { fallbackColumns: fallbacks.map((column) => column.name) }),
    },
    rules: [
      {
        id: `${snakeCase(candidate.slug)}_retention`,
        after: duration,
        action: retentionAction(policy),
        reason:
          typeof policy?.legalBasis?.reference === "string"
            ? policy.legalBasis.reference
            : "Authoring catalog retention policy.",
      },
    ],
    source: entityRetention.policy ?? "authoring-entity-retention",
  };
}

/**
 * Pick the effective embedded-list default sort for a single entity.
 *
 * Embedded list renderings (e.g. the `contactMoments` tab inside a relation
 * detail page) do not get to declare their own sort — they inherit it from
 * the target entity's compiled views. We pick `listCompact.defaultSort`
 * first (the explicit embedded variant), then fall back to the page-level
 * `list.defaultSort`. We scan all view contexts (e.g. core or a sector profile) and
 * prefer `core` when present.
 */
function pickEmbeddedDefaultSort(
  views: Record<string, CompiledViewContext>,
): { field: string; direction: "asc" | "desc" } | undefined {
  const orderedContexts = [
    views.core,
    ...Object.entries(views)
      .filter(([name]) => name !== "core")
      .map(([, value]) => value),
  ].filter((context): context is CompiledViewContext => Boolean(context));

  const isCompiledList = (
    presentation: CompiledNamedPresentation | undefined,
  ): presentation is CompiledListView =>
    Boolean(
      presentation &&
        (presentation as { type?: string }).type === "list" &&
        (presentation as { defaultSort?: unknown }).defaultSort,
    );

  for (const presentationName of ["listCompact", "list"]) {
    for (const context of orderedContexts) {
      const presentation = context.presentations?.[presentationName];
      if (isCompiledList(presentation) && presentation.defaultSort) {
        return {
          field: presentation.defaultSort.key,
          direction: presentation.defaultSort.direction,
        };
      }
    }
  }

  return undefined;
}

function compileCoreCandidate(
  authoringDir: string,
  slug: string,
  sourcePathPrefix: string,
): CompiledCandidate {
  const artifacts = loadEntity(authoringDir, slug);
  const contract = compile(artifacts);
  return {
    slug,
    origin: { kind: "core", slug },
    path: `${sourcePathPrefix}/${relative(
      authoringDir,
      resolveEntityFilePath(authoringDir, slug),
    )}`,
    contract,
    fieldsByKey: flattenFields([
      ...(artifacts.coreEntity.fields ?? []),
      ...artifacts.profiles.flatMap((profile) => profile.fields ?? []),
    ]),
  };
}

function compileContextCandidate(
  authoringDir: string,
  spec: ContextEntitySpec,
  sourcePathPrefix: string,
): CompiledCandidate {
  const artifacts = loadContextEntity(authoringDir, spec.context, spec.name);
  const contract = compile(artifacts);
  return {
    slug: spec.name,
    origin: { kind: "contextFull", context: spec.context, name: spec.name },
    path: `${sourcePathPrefix}/contexts/${spec.context}/full/${spec.name}.yaml`,
    contract,
    fieldsByKey: flattenFields(artifacts.coreEntity.fields ?? []),
  };
}

function describeCandidateOrigin(candidate: CompiledCandidate): string {
  return candidate.origin.kind === "core"
    ? `entities/${candidate.origin.slug}`
    : `contexts/${candidate.origin.context}/full/${candidate.origin.name}`;
}

/**
 * Pre-emission collision audit. Both core and context-full candidates land in
 * the same generated GraphQL graph and the same physical schema, so any
 * duplicate type/query/mutation/table identity would silently overwrite at
 * runtime. We fail loudly with the offending source files instead.
 */
function detectCandidateCollisions(candidates: CompiledCandidate[], schemaByModule: Record<string, string>) {
  const buckets: Record<string, Map<string, CompiledCandidate[]>> = {
    "GraphQL type name": new Map(),
    "GraphQL list query": new Map(),
    "GraphQL single query": new Map(),
    "GraphQL create mutation": new Map(),
    "GraphQL update mutation": new Map(),
    "GraphQL delete mutation": new Map(),
    "physical table": new Map(),
    "candidate slug": new Map(),
  };

  function record(bucket: string, key: string, candidate: CompiledCandidate) {
    const map = buckets[bucket]!;
    const existing = map.get(key);
    if (existing) {
      existing.push(candidate);
    } else {
      map.set(key, [candidate]);
    }
  }

  for (const candidate of candidates) {
    const gql = candidate.contract.graphql;
    record("GraphQL type name", gql.typeName, candidate);
    record("GraphQL list query", gql.queries.list.name, candidate);
    record("GraphQL single query", gql.queries.single.name, candidate);
    record("GraphQL create mutation", gql.mutations.create.name, candidate);
    record("GraphQL update mutation", gql.mutations.update.name, candidate);
    record("GraphQL delete mutation", gql.mutations.delete.name, candidate);

    const moduleName = candidate.contract.entity.module;
    const schema = schemaByModule[moduleName] ?? snakeCase(moduleName);
    record("physical table", `${schema}.${candidate.contract.storage.table}`, candidate);

    const slugKey = candidate.origin.kind === "core"
      ? `core:${candidate.origin.slug}`
      : `${candidate.origin.context}:${candidate.origin.name}`;
    record("candidate slug", slugKey, candidate);
  }

  const failures: string[] = [];
  for (const [bucket, map] of Object.entries(buckets)) {
    for (const [key, list] of map) {
      if (list.length > 1) {
        const sources = list.map(describeCandidateOrigin).join(", ");
        failures.push(`${bucket} "${key}" is produced by multiple candidates: ${sources}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Backend manifest collision audit failed:\n  - ${failures.join("\n  - ")}`,
    );
  }
}

export function compileAuthoringBackendManifest(
  authoringDir: string,
  options: CompileAuthoringBackendManifestOptions,
): PlatformSchemaManifest {
  if (options.entityAllowlist.length === 0) {
    throw new Error("compileAuthoringBackendManifest requires an explicit entityAllowlist.");
  }

  const sourcePathPrefix =
    options.sourcePathPrefix ?? "packages/compiler/config/authoring";
  const allowlist = [...new Set(options.entityAllowlist.map(kebabCase))].sort();
  const contextAllowlist = (options.contextEntityAllowlist ?? []).slice().sort((left, right) =>
    `${left.context}/${left.name}`.localeCompare(`${right.context}/${right.name}`),
  );
  const generatedCrudAllowlist = new Set(
    (options.generatedCrudAllowlist ?? []).map(kebabCase),
  );
  const contextGeneratedCrudAllowlist = new Set(
    (options.contextEntityGeneratedCrudAllowlist ?? []).map(
      (spec) => `${spec.context}:${spec.name}`,
    ),
  );
  const domainInternalEntities = new Set((options.domainInternalEntities ?? []).map(kebabCase));
  const relationshipRegister = options.relationshipRegister ?? [];
  const schemaByModule = options.schemaByModule ?? { core: "erp" };
  const candidates: CompiledCandidate[] = [
    ...allowlist.map((slug) => compileCoreCandidate(authoringDir, slug, sourcePathPrefix)),
    ...contextAllowlist.map((spec) =>
      compileContextCandidate(authoringDir, spec, sourcePathPrefix),
    ),
  ];

  if (options.onCandidate) {
    for (const candidate of candidates) {
      options.onCandidate({
        slug: candidate.slug,
        path: candidate.path,
        origin: candidate.origin.kind,
        contract: candidate.contract,
      });
    }
  }

  detectCandidateCollisions(candidates, schemaByModule);

  const byEntityName = new Map(
    candidates.map((candidate) => [candidate.contract.entity.name, candidate]),
  );

  const tables: TableDefinition[] = candidates.map((candidate) => {
    const schema = schemaByModule[candidate.contract.entity.module] ?? snakeCase(candidate.contract.entity.module);
    const name = candidate.contract.storage.table;
    const candidateCrudKey =
      candidate.origin.kind === "core"
        ? candidate.origin.slug
        : `${candidate.origin.context}:${candidate.origin.name}`;
    const domainInternal =
      candidate.origin.kind === "core" && domainInternalEntities.has(candidate.slug);
    const generatedCrud =
      (candidate.origin.kind === "core"
        ? generatedCrudAllowlist.has(candidateCrudKey)
        : contextGeneratedCrudAllowlist.has(candidateCrudKey)) && !domainInternal;
    const tenantScoped = candidate.contract.authorization !== undefined;
    const emittedReferences: string[] = [];
    const skippedReferences: string[] = [];
    const columnsByField = new Map<string, ColumnDefinition>();
    const columns: ColumnDefinition[] = [];

    for (const storageColumn of candidate.contract.storage.columns) {
      const field = candidate.fieldsByKey.get(storageColumn.field);
      const primaryKey = storageColumn.column === "id";
      const column: ColumnDefinition = {
        name: storageColumn.column,
        type: field ? serviceScalarForField(field) : storageColumn.type === "text" ? "text" : "uuid",
        ...(primaryKey ? { primaryKey: true } : {}),
        ...(primaryKey || !storageColumn.nullable ? { required: true } : {}),
        sourceField: storageColumn.field,
      };
      const defaultValue = defaultSql(field, column);
      if (defaultValue !== undefined) {
        column.default = defaultValue;
      }
      columns.push(column);
      columnsByField.set(storageColumn.field, column);
    }

    const idIndex = columns.findIndex((column) => column.name === "id");
    const existingTenantColumn = columns.find((column) => column.name === "tenant_id");
    if (tenantScoped && existingTenantColumn) {
      existingTenantColumn.type = "uuid";
    }
    if (tenantScoped && !columns.some((column) => column.name === "tenant_id")) {
      const tenantColumn: ColumnDefinition = { name: "tenant_id", type: "uuid", required: true };
      columns.splice(idIndex >= 0 ? idIndex + 1 : 0, 0, tenantColumn);
    }
    if (!columns.some((column) => column.name === "created_at")) {
      columns.push({
        name: "created_at",
        type: "timestamptz",
        required: true,
        default: "now()",
      });
    }
    if (!columns.some((column) => column.name === "updated_at")) {
      columns.push({
        name: "updated_at",
        type: "timestamptz",
        required: true,
        default: "now()",
      });
    }

    const columnsByName = new Map(columns.map((column) => [column.name, column]));
    for (const relationship of candidate.contract.model.relationships) {
      if (relationship.kind !== "belongsTo" || !relationship.foreignKey) {
        continue;
      }
      const column = columnsByName.get(relationship.foreignKey);
      if (!column) {
        continue;
      }
      const target = byEntityName.get(relationship.target);
      if (!target) {
        skippedReferences.push(`${relationship.foreignKey}->${relationship.target}.id (target not allowlisted)`);
        continue;
      }
      const targetSchema =
        schemaByModule[target.contract.entity.module] ?? snakeCase(target.contract.entity.module);
      const reference: ReferenceDefinition = {
        schema: targetSchema,
        table: target.contract.storage.table,
        column: "id",
      };
      const sameModule = target.contract.entity.module === candidate.contract.entity.module;
      const registered = isRelationshipRegistered(
        relationshipRegister,
        { schema, table: name, column: relationship.foreignKey },
        reference,
      );
      if (!sameModule && !registered) {
        skippedReferences.push(
          `${relationship.foreignKey}->${reference.schema}.${reference.table}.${reference.column} (cross-module unregistered)`,
        );
        continue;
      }
      column.type = "uuid";
      column.references = reference;
      emittedReferences.push(
        `${relationship.foreignKey}->${reference.schema}.${reference.table}.${reference.column}`,
      );
    }

    const columnsByNameWithOperational = new Map(columns.map((column) => [column.name, column]));
    const retention = compileRetention(candidate, columnsByField, columnsByNameWithOperational);

    const compiledIndexes = compileEntityIndexes(candidate, tenantScoped, columnsByField);

    // Row-level access → rowScope translation (§B.3) + fail-closed guards (§C).
    const rowAccess = candidate.contract.authorization?.rowAccess;
    // §C.2 fail-closed: `empty: restricted` only makes sense when there is an
    // owner/group column that can be NULL. Without any axis, "restricted" would
    // hide every row or silently degrade to tenant scoping — a declared-but-
    // unemitted confidentiality. Convert to a hard build failure.
    if (
      rowAccess?.enabled &&
      rowAccess.empty === "restricted" &&
      !rowAccess.owner &&
      !rowAccess.group
    ) {
      throw new Error(
        `[${candidate.contract.entity.name}] authorization.rowAccess.empty: restricted requires an owner or group axis — ` +
          `otherwise the entity has no confidentiality column and "restricted" would hide every row ` +
          `or silently degrade to tenant scoping. Add an owner/group axis or set empty: public.`,
      );
    }
    const rowScope = deriveRowScope(
      rowAccess,
      candidate.contract.entity.name,
      columnsByNameWithOperational,
    );

    return {
      schema,
      name,
      tenantScoped,
      domainInternal,
      generatedCrud,
      columns,
      ...(rowScope ? { rowScope } : {}),
      ...(compiledIndexes.length > 0 ? { indexes: compiledIndexes } : {}),
      ...(retention === undefined ? {} : { retention }),
      source: {
        path: candidate.path,
        authoringEntityName: candidate.contract.entity.name,
        authoringEntitySlug: candidate.slug,
        generatedCrudEligibility: generatedCrud ? "explicitly_enabled" : "explicitly_disabled",
        ...(candidate.contract.entity.labels
          ? { labels: candidate.contract.entity.labels }
          : {}),
        ...(candidate.contract.entity.displayTemplate
          ? { displayTemplate: candidate.contract.entity.displayTemplate }
          : {}),
        graphql: {
          typeName: candidate.contract.graphql.typeName,
          singleQueryName: candidate.contract.graphql.queries.single.name,
          listQueryName: candidate.contract.graphql.queries.list.name,
          createMutationName: candidate.contract.graphql.mutations.create.name,
          updateMutationName: candidate.contract.graphql.mutations.update.name,
          deleteMutationName: candidate.contract.graphql.mutations.delete.name,
          relationships: candidate.contract.graphql.relationships
            .filter((relationship): relationship is typeof relationship & { resolve: "belongsTo" | "hasMany" } =>
              relationship.resolve === "belongsTo" || relationship.resolve === "hasMany",
            )
            .map((relationship) => ({
              name: relationship.name,
              target: relationship.target,
              type: relationship.type,
              resolve: relationship.resolve,
              ...(relationship.foreignKey ? { foreignKey: relationship.foreignKey } : {}),
            })),
          ...(() => {
            const defaultSort = pickEmbeddedDefaultSort(candidate.contract.views);
            return defaultSort ? { defaultSort } : {};
          })(),
        },
        relationshipStatus: {
          emittedReferences,
          skippedReferences,
        },
        ...(candidate.contract.retention?.entity
          ? { retentionSource: candidate.contract.retention.entity.policy ?? "authoring-entity-retention" }
          : {}),
      },
    };
  });

  return {
    version: 1,
    description: "Candidate backend manifest compiled from restored authoring catalog.",
    relationshipRegister: filterRelationshipRegisterForTables(tables, relationshipRegister),
    tables: sortTablesByDependencies(tables),
  };
}

function comparableColumn(column: ColumnDefinition): Partial<ColumnDefinition> {
  return {
    name: column.name,
    type: column.type,
    primaryKey: column.primaryKey === true,
    required: column.required === true || column.primaryKey === true,
    ...(column.default === undefined ? {} : { default: column.default }),
    ...(column.generated === undefined ? {} : { generated: column.generated }),
    ...(column.references === undefined ? {} : { references: column.references }),
  };
}

function columnsEqual(left: ColumnDefinition, right: ColumnDefinition): boolean {
  return JSON.stringify(comparableColumn(left)) === JSON.stringify(comparableColumn(right));
}

export function buildAuthoringBackendReport(
  candidate: PlatformSchemaManifest,
  current: PlatformSchemaManifest,
  input: { mode: AuthoringBackendMode; authoringEntityCount: number; uiEntityManifestCount?: number },
): AuthoringBackendReport {
  const currentByTable = new Map(current.tables.map((table) => [`${table.schema}.${table.name}`, table]));
  const tables = candidate.tables.map((candidateTable) => {
    const tableKey = `${candidateTable.schema}.${candidateTable.name}`;
    const currentTable = currentByTable.get(tableKey);
    const currentColumns = new Map(currentTable?.columns.map((column) => [column.name, column]) ?? []);
    const candidateColumns = new Map(candidateTable.columns.map((column) => [column.name, column]));
    const missingInCandidate = [...currentColumns.keys()]
      .filter((column) => !candidateColumns.has(column))
      .sort();
    const addedByCandidate = [...candidateColumns.keys()]
      .filter((column) => !currentColumns.has(column))
      .sort();
    const changedColumns: ColumnDiff[] = [];
    for (const [name, currentColumn] of currentColumns) {
      const candidateColumn = candidateColumns.get(name);
      if (candidateColumn && !columnsEqual(currentColumn, candidateColumn)) {
        changedColumns.push({
          column: name,
          current: comparableColumn(currentColumn),
          candidate: comparableColumn(candidateColumn),
        });
      }
    }
    const emittedReferences = candidateTable.source?.relationshipStatus?.emittedReferences ?? [];
    const skippedReferences = candidateTable.source?.relationshipStatus?.skippedReferences ?? [];
    const changedMetadata: string[] = [];
    if (currentTable === undefined) {
      changedMetadata.push("table missing in current manifest");
    } else {
      if (currentTable.tenantScoped !== candidateTable.tenantScoped) {
        changedMetadata.push(
          `tenantScoped current=${currentTable.tenantScoped} candidate=${candidateTable.tenantScoped}`,
        );
      }
      const currentGeneratedCrud =
        currentTable.generatedCrud !== false && currentTable.domainInternal !== true;
      const candidateGeneratedCrud =
        candidateTable.generatedCrud !== false && candidateTable.domainInternal !== true;
      if (currentGeneratedCrud !== candidateGeneratedCrud) {
        changedMetadata.push(
          `generatedCrud current=${currentGeneratedCrud} candidate=${candidateGeneratedCrud}`,
        );
      }
      const currentDomainInternal = currentTable.domainInternal === true;
      const candidateDomainInternal = candidateTable.domainInternal === true;
      if (currentDomainInternal !== candidateDomainInternal) {
        changedMetadata.push(
          `domainInternal current=${currentDomainInternal} candidate=${candidateDomainInternal}`,
        );
      }
      const currentIndexes = JSON.stringify(currentTable.indexes ?? []);
      const candidateIndexes = JSON.stringify(candidateTable.indexes ?? []);
      if (currentIndexes !== candidateIndexes) {
        changedMetadata.push("indexes differ");
      }
      const currentRetention = JSON.stringify(currentTable.retention ?? null);
      const candidateRetention = JSON.stringify(candidateTable.retention ?? null);
      if (currentRetention !== candidateRetention) {
        changedMetadata.push("retention differs");
      }
    }
    const matches =
      currentTable !== undefined &&
      missingInCandidate.length === 0 &&
      addedByCandidate.length === 0 &&
      changedColumns.length === 0 &&
      changedMetadata.length === 0;

    return {
      table: tableKey,
      authoringEntity: candidateTable.source?.authoringEntitySlug ?? tableKey,
      missingInCandidate,
      addedByCandidate,
      changedColumns,
      changedMetadata,
      emittedReferences,
      skippedReferences,
      matches,
    };
  });

  return {
    generatedAt: new Date(0).toISOString(),
    mode: input.mode,
    coverage: {
      authoringEntityCount: input.authoringEntityCount,
      ...(input.uiEntityManifestCount === undefined
        ? {}
        : { uiEntityManifestCount: input.uiEntityManifestCount }),
      candidateBackendEntityCount: candidate.tables.length,
      candidateBackendEntities: candidate.tables.map((table) => table.source?.authoringEntitySlug ?? table.name),
    },
    tables,
    hasDifferences: tables.some((table) => !table.matches),
  };
}
