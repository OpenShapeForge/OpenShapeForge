// SPDX-License-Identifier: BUSL-1.1
import { join, relative } from "node:path";
import { compile } from "./compiler/index.js";
import type { CompiledEntityContract } from "./types/compiled.js";
import {
  listEntityFiles,
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
  ColumnSensitivity,
  OwnerAxisPolicy,
  PlatformSchemaManifest,
  ReferenceDefinition,
  VersioningOwnedChild,
  RelationshipRegisterEntry,
  RetentionAction,
  RetentionDefinition,
  RetentionDuration,
  RowScopePolicy,
  TableDefinition,
} from "../schema.js";
import { isGeneratedCrudEligible } from "../schema.js";
import type { CompiledAuthorization, CompiledField } from "./types/compiled.js";
import { normalizeKeycloakRoleName } from "./role-names.js";
import { resolveModelFields } from "./compiler/model.js";
import { normalizeEntityFields } from "./entity-fields.js";
import { assertEntityValueDefinition, compileEntityValueStorage, entityValueDefinitionNames } from "./entity-values.js";
import type { EntityValueRegistry } from "./entity-value-types.js";
import { resolveDerivedOnCreateBindings } from "./compiler/derive-on-create.js";
import { assertDefaultSatisfiesContract, fieldValueCheckConstraints } from "./field-value-checks.js";
import { TENANT_IDENTITY_CHECK_EXPRESSION, hasTenantIdentityCheck, tenantIdentityCheckName } from "../tenant-bound-references.js";

/**
 * Bridges the compiled per-operation role lists into the manifest as the
 * deduplicated, sorted union of the authored names and their
 * Keycloak-normalized forms. Bearer tokens carry the normalized (English)
 * names from the generated realm; in-repo trusted-context signers send the
 * authored (Dutch) names — emitting both lets the API enforce with a plain
 * case-sensitive set intersection and no runtime rename table.
 */
function bridgeAuthorizationRoles(
  roles: CompiledAuthorization["roles"],
): NonNullable<NonNullable<TableDefinition["source"]>["authorization"]>["roles"] {
  const union = (authored: string[]) =>
    [...new Set([...authored, ...authored.map(normalizeKeycloakRoleName)])].sort();
  return {
    read: union(roles.read),
    create: union(roles.create),
    update: union(roles.update),
    delete: union(roles.delete),
  };
}

export type AuthoringBackendMode = "report" | "promote";

export type CompileAuthoringBackendManifestOptions = {
  /**
   * Repo-root-relative prefix recorded as each table's provenance path.
   * Defaults to the in-repo authoring location; layered hosts pass the
   * resolved directory (e.g. ".authoring-build") so provenance stays honest.
   */
  sourcePathPrefix?: string;
  mode: AuthoringBackendMode;
  entityAllowlist: string[];
  schemaByModule?: Record<string, string>;
  relationshipRegister?: RelationshipRegisterEntry[];
  generatedCrudAllowlist?: string[];
  domainInternalEntities?: string[];
  /** Observe each compiled candidate (slug, provenance, contract) — used to
      build the plugin context without recompiling entities. */
  onCandidate?: (candidate: {
    slug: string;
    path: string;
    origin: "core";
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

type CandidateOrigin = { kind: "core"; slug: string };

type CompiledCandidate = {
  /**
   * Stable, human-friendly identifier used for the manifest `source` block and
   * collision/CRUD allowlists: the kebab-case file stem (e.g. `case`).
   * Uniqueness of the compiled identities is enforced by the pre-emission
   * collision audit, not by the slug.
   */
  slug: string;
  origin: CandidateOrigin;
  path: string;
  contract: ReturnType<typeof compile>;
  fieldsByKey: Map<string, Field>;
  effectiveFields: CompiledField[];
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
    (column.type === "integer" || column.type === "bigint" || column.type === "numeric") &&
    typeof field.defaultValue === "number" &&
    Number.isFinite(field.defaultValue) &&
    (column.type === "numeric" || Number.isInteger(field.defaultValue))
  ) {
    return String(field.defaultValue);
  }
  if (column.type === "jsonb") {
    return `${quoteSqlString(JSON.stringify(field.defaultValue))}::jsonb`;
  }
  if (typeof field.defaultValue === "string" && column.type !== "boolean" &&
    column.type !== "integer" && column.type !== "bigint" && column.type !== "numeric") {
    return quoteSqlString(field.defaultValue);
  }
  // An authored default the column cannot carry is a contract the database
  // would silently drop: a required numeric with `defaultValue: 1` compiled to
  // NOT NULL with no default, and every insert that relied on it failed.
  throw new Error(
    `Field ${field.key} declares defaultValue ${JSON.stringify(field.defaultValue)}, ` +
      `which cannot be rendered as a SQL default for ${column.type} column ${column.name}.`,
  );
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
 * Returns undefined when there is no restriction axis (owner, group and
 * record permissions all absent) — today's `empty: public` entities without
 * any such axis are
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
  let recordPermissions: RowScopePolicy["recordPermissions"] | undefined;

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

  if (rowAccess.recordPermissions) {
    const column = columnsByName.get(rowAccess.recordPermissions.column);
    if (!column) {
      throw new Error(
        `[${entityName}] authorization.rowAccess.recordPermissions field "${rowAccess.recordPermissions.field}" references column "${rowAccess.recordPermissions.column}", but that column was not emitted.`,
      );
    }
    if (column.type !== "jsonb") {
      throw new Error(
        `[${entityName}] authorization.rowAccess.recordPermissions field "${rowAccess.recordPermissions.field}" must persist as jsonb, found ${column.type}.`,
      );
    }
    recordPermissions = {
      column: rowAccess.recordPermissions.column,
      empty: rowAccess.recordPermissions.empty,
    };
  }

  // No restriction axis declared → plain tenant scoping (documented no-op).
  if (userColumns.length === 0 && !group && !recordPermissions) return undefined;

  return {
    ...(group ? { group } : {}),
    ...(userColumns.length > 0 ? { userColumns } : {}),
    ...(nullVisibleColumns.length > 0 ? { nullVisibleColumns } : {}),
    ...(recordPermissions ? { recordPermissions } : {}),
    // bypassRoles wired in a later phase (see §E.3 note); omitted for now.
  };
}

/**
 * Restricting data-classification tiers. `public`/`internal` impose no
 * field-level access restriction, so they are dropped — only the tiers that
 * gate reads propagate into the manifest (issues #96/#101).
 */
const RESTRICTING_SENSITIVITIES: ReadonlySet<string> = new Set([
  "confidential",
  "pii",
  "bsn",
]);

/**
 * Flatten compiled fields (including nested `children`/`item`) into a
 * field-key → restricting-sensitivity map. Used to stamp each storage column
 * with the classification of the authoring field that backs it.
 */
function collectFieldSensitivities(
  fields: CompiledField[] | undefined,
  result = new Map<string, ColumnSensitivity>(),
): Map<string, ColumnSensitivity> {
  for (const field of fields ?? []) {
    const sensitivity = field.classification?.sensitivity;
    if (sensitivity && RESTRICTING_SENSITIVITIES.has(sensitivity) && !result.has(field.key)) {
      result.set(field.key, sensitivity as ColumnSensitivity);
    }
    collectFieldSensitivities(field.children, result);
    if (field.item) {
      collectFieldSensitivities([field.item], result);
    }
  }
  return result;
}

/**
 * Flatten compiled fields into the set of keys authored `immutable: true`.
 * Used to stamp each backing column so the runtime's writability rule can
 * refuse the field on update (#177) — the same route `classification` takes,
 * for the same reason: an authored flag is worth nothing until the manifest
 * carries it to the transports.
 */
function collectImmutableFieldKeys(
  fields: CompiledField[] | undefined,
  result = new Set<string>(),
): Set<string> {
  for (const field of fields ?? []) {
    if (field.immutable) result.add(field.key);
    collectImmutableFieldKeys(field.children, result);
    if (field.item) {
      collectImmutableFieldKeys([field.item], result);
    }
  }
  return result;
}

/**
 * Flatten compiled fields into field key → the operation keys authored in
 * `writtenBy`. Stamped onto the backing column so the transports can leave the
 * field out of their create/update schemas and refuse it when a caller sends
 * it anyway. Same route as `immutable`, for the same reason: an authored flag
 * is worth nothing until the manifest carries it to the transports.
 */
function collectFieldWriters(
  fields: CompiledField[] | undefined,
  result = new Map<string, string[]>(),
): Map<string, string[]> {
  for (const field of fields ?? []) {
    if (field.writtenBy && field.writtenBy.length > 0 && !result.has(field.key)) {
      result.set(field.key, [...field.writtenBy]);
    }
    collectFieldWriters(field.children, result);
    if (field.item) {
      collectFieldWriters([field.item], result);
    }
  }
  return result;
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

function retentionDurationParts(duration: RetentionDuration): { months: number; days: number } {
  return { months: (duration.years ?? 0) * 12 + (duration.months ?? 0), days: duration.days ?? 0 };
}

function assertRetentionDurationOrder(
  entityName: string,
  shorterName: string,
  shorter: RetentionDuration,
  longerName: string,
  longer: RetentionDuration,
): void {
  const left = retentionDurationParts(shorter);
  const right = retentionDurationParts(longer);
  if (left.months <= right.months && left.days <= right.days) return;
  throw new Error(
    `Entity "${entityName}" retention ${shorterName} duration must not exceed ${longerName}. ` +
      "Calendar months and fixed days may only be combined when their ordering is unambiguous.",
  );
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
    // preserved separately on the compiled rule.
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
 * Normalise the authored `disposition.review` (which may be a boolean or an
 * object) into the compiled review gate, or `undefined` when review is not
 * required. Carried through so an executor can honor a mandatory review queue
 * before acting on a record (see #100).
 */
function retentionReview(
  policy: RetentionPolicy | undefined,
): { required: boolean; queue?: string } | undefined {
  const review = policy?.disposition?.review;
  if (review === undefined || review === false) {
    return undefined;
  }
  if (review === true) {
    return { required: true };
  }
  if (!review.required) {
    return undefined;
  }
  return {
    required: true,
    ...(typeof review.queue === "string" ? { queue: review.queue } : {}),
  };
}

/**
 * Resolve authored entity-level indexes (field keys) into TableDefinition
 * indexes (column names). `tenantId` is accepted directly for tenant-scoped
 * tables since the compiler auto-attaches a `tenant_id` column.
 *
 * A unique index on a tenant-scoped table is unique per tenant: `tenant_id`
 * leads it whether or not the author wrote `tenantId`, so `unique: [code]`
 * never makes one tenant's code block another's, and the index doubles as
 * the tenant-leading lookup the row-level policy wants.
 */
function compileEntityIndexes(
  candidate: CompiledCandidate,
  tenantScoped: boolean,
  columnsByField: Map<string, ColumnDefinition>,
): Array<{ name: string; columns: string[]; unique?: boolean; where?: string }> {
  const authored = candidate.contract.entity.indexes ?? [];
  const compiled: Array<{ name: string; columns: string[]; unique?: boolean; where?: string }> = [];
  const literal = (value: boolean | string | number): string => {
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`Entity "${candidate.contract.entity.name}" index predicate value must be finite.`);
      return String(value);
    }
    return `'${value.replace(/'/g, "''")}'`;
  };
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
    if (index.unique && tenantScoped && !resolvedColumns.includes("tenant_id")) {
      resolvedColumns.unshift("tenant_id");
    }
    let where: string | undefined;
    if (index.where) {
      const column = columnsByField.get(index.where.field);
      if (!column) {
        throw new Error(
          `Entity "${candidate.contract.entity.name}" index "${index.name}" predicate references unknown field "${index.where.field}".`,
        );
      }
      if ("present" in index.where) {
        where = `"${column.name}" IS ${index.where.present ? "NOT NULL" : "NULL"}`;
      } else {
        const expected = column.type === "boolean" ? "boolean" : ["integer", "bigint", "numeric"].includes(column.type) ? "number" : "string";
        if (typeof index.where.equals !== expected) {
          throw new Error(
            `Entity "${candidate.contract.entity.name}" index "${index.name}" predicate value must be a ${expected} for field "${index.where.field}".`,
          );
        }
        where = `"${column.name}" = ${literal(index.where.equals)}`;
      }
    }
    compiled.push({
      name: index.name,
      columns: resolvedColumns,
      ...(index.unique ? { unique: true } : {}),
      ...(where ? { where } : {}),
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

  const authoredDurations = typeof policy?.duration === "string"
    ? { default: policy.duration }
    : policy?.duration ?? {};
  const duration = Object.fromEntries(
    Object.entries(authoredDurations).map(([bound, raw]) => {
      const parsed = parseIsoDuration(raw);
      if (!parsed) {
        throw new Error(
          `Entity "${entityName}" retention has an unparseable ISO-8601 ${bound} duration ` +
            `${JSON.stringify(raw)}. Use P<n>Y<n>M<n>D (e.g. P7Y).`,
        );
      }
      return [bound, parsed];
    }),
  ) as { minimum?: RetentionDuration; default?: RetentionDuration; maximum?: RetentionDuration };
  if (Object.keys(duration).length === 0) {
    throw new Error(`Entity "${entityName}" retention must declare minimum, default, or maximum duration.`);
  }
  if (duration.minimum && duration.default) {
    assertRetentionDurationOrder(entityName, "minimum", duration.minimum, "default", duration.default);
  }
  if (duration.default && duration.maximum) {
    assertRetentionDurationOrder(entityName, "default", duration.default, "maximum", duration.maximum);
  }
  if (duration.minimum && duration.maximum) {
    assertRetentionDurationOrder(entityName, "minimum", duration.minimum, "maximum", duration.maximum);
  }

  const strategy = entityRetention.startsFrom?.strategy;
  const startFields = [
    ...(entityRetention.startsFrom?.fields ?? []),
    ...(entityRetention.startsFrom?.field ? [entityRetention.startsFrom.field] : []),
  ];
  const strategyField =
    startFields.length > 0
      ? undefined
      : strategy === "createdAt"
        ? "createdAt"
        : strategy === "updatedAt"
          ? "updatedAt"
          : undefined;
  const clockFields = strategyField === undefined ? startFields : [strategyField];

  // #97: resolve the retention clock deterministically. A retention policy is
  // a statutory/GDPR erasure control — silently dropping a start field or
  // emitting no clock at all would let an entity advertise a retention window
  // that compiles to nothing. So every declared start field must resolve to a
  // usable timestamp anchor (`timestamptz` or `date`); anything else is a hard
  // build error rather than a silent filter.
  const clockColumns = clockFields.map((fieldKey) => {
    const column = columnsByField.get(fieldKey);
    if (!column) {
      throw new Error(
        `[${entityName}] retention.startsFrom references unknown field "${fieldKey}".`,
      );
    }
    const columnType = columnsByName.get(column.name)?.type;
    if (columnType !== "timestamptz" && columnType !== "date") {
      throw new Error(
        `[${entityName}] retention.startsFrom field "${fieldKey}" resolves to column ` +
          `"${column.name}" of type "${columnType ?? "unknown"}", which cannot serve as a ` +
          `retention clock. Anchor retention on a timestamptz or date field.`,
      );
    }
    return { column, type: columnType as "timestamptz" | "date" };
  });

  const [clock, ...fallbacks] = clockColumns;
  if (!clock) {
    // A start field is only meaningful with an explicit-field strategy. If a
    // policy declares no usable anchor at all, refuse to emit a clockless (and
    // therefore unenforceable) retention rule.
    if (strategy === "field" || strategy === "firstNonNull") {
      throw new Error(
        `[${entityName}] retention.startsFrom.strategy is "${strategy}" but no start field was ` +
          `declared — cannot resolve a retention clock.`,
      );
    }
    throw new Error(
      `[${entityName}] declares a retention policy but no retention clock column could be ` +
        `resolved. Declare startsFrom.field (or .fields) pointing at a timestamptz/date column.`,
    );
  }

  const disposition = policy?.disposition?.action;
  const review = retentionReview(policy);
  const legalHold = policy?.holds?.suspendDestruction === true;
  const activeHoldField = entityRetention.holds?.activeField ?? policy?.holds?.activeField;
  const activeHoldColumn = activeHoldField ? columnsByField.get(activeHoldField) : undefined;
  if (activeHoldField && (!activeHoldColumn || activeHoldColumn.type !== "boolean")) {
    throw new Error(
      `[${entityName}] retention.holds.activeField "${activeHoldField}" must resolve to a boolean field.`,
    );
  }
  if (activeHoldField && !legalHold) {
    throw new Error(
      `[${entityName}] retention.holds.activeField requires suspendDestruction: true.`,
    );
  }
  const cryptoDeleteKey = policy?.disposition?.cryptoDelete?.keyReference;
  if (disposition === "cryptoDelete" && (!cryptoDeleteKey || cryptoDeleteKey.trim().length === 0)) {
    throw new Error(
      `[${entityName}] retention.disposition.cryptoDelete.keyReference is required when ` +
        `disposition.action is "cryptoDelete".`,
    );
  }

  return {
    clock: {
      column: clock.column.name,
      type: clock.type,
      ...(fallbacks.length === 0
        ? {}
        : { fallbackColumns: fallbacks.map((entry) => entry.column.name) }),
    },
    rules: [
      {
        id: `${snakeCase(candidate.slug)}_retention`,
        duration,
        action: retentionAction(policy),
        // #100: preserve the authored disposition, review gate, and crypto-delete
        // key so a future executor can honor them instead of the coarse action.
        ...(disposition === undefined ? {} : { disposition }),
        reason:
          typeof policy?.legalBasis?.reference === "string"
            ? policy.legalBasis.reference
            : "Authoring catalog retention policy.",
        ...(review === undefined ? {} : { review }),
        ...(disposition === "cryptoDelete"
          ? {
              cryptoDelete: { keyReference: cryptoDeleteKey as string },
            }
          : {}),
      },
    ],
    // #100: a legal hold must suspend all destructive dispositions; carry it so
    // an executor never deletes a record under litigation hold.
    ...(legalHold
      ? {
          legalHold: {
            suspendDestruction: true,
            ...(activeHoldColumn ? { activeColumn: activeHoldColumn.name } : {}),
          },
        }
      : {}),
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
    effectiveFields: resolveModelFields(normalizeEntityFields({
      ...artifacts.coreEntity,
      fields: [...artifacts.coreEntity.fields, ...artifacts.profiles.flatMap((profile) => profile.fields ?? [])],
    }, artifacts.osfTypes).fields, artifacts.componentCatalog, artifacts.osfTypes),
    // The compiled model also contains compiler-owned fields, such as the
    // lifecycle default added by published-snapshot versioning. SQL defaults
    // must follow that effective contract rather than only the authored YAML.
    fieldsByKey: new Map(contract.model.fields.map((field) => [field.key, field as Field])),
  };
}

function describeCandidateOrigin(candidate: CompiledCandidate): string {
  return `entities/${candidate.origin.slug}`;
}

/**
 * Pre-emission collision audit. Every candidate lands in the same generated
 * GraphQL graph and the same physical schema, so any
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
    "REST base path": new Map(),
    "MCP tool prefix": new Map(),
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

    const slugKey = `core:${candidate.origin.slug}`;
    record("candidate slug", slugKey, candidate);

    if (candidate.contract.rest) {
      record("REST base path", candidate.contract.rest.basePath, candidate);
    }
    // Two entities sharing a prefix would generate the same tool names, and the
    // runtime dispatches on those names — the second registration would shadow
    // the first and silently route an agent's writes at the wrong table.
    if (candidate.contract.mcp) {
      record("MCP tool prefix", candidate.contract.mcp.toolPrefix, candidate);
    }
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

/**
 * Bind the exact storage of every published-snapshot pair onto the head
 * table's source. The versioning runtime reads schema, table and the head
 * foreign key from here and derives nothing from entity names, so a plugin
 * entity in its own schema publishes exactly like a core one. Runs after
 * field relations are lowered, so the head column is already a reference to
 * the head and the binding cannot name a column that does not point there.
 */
function bindVersioningStorage(candidates: CompiledCandidate[], tables: TableDefinition[]): void {
  const byEntity = new Map(candidates.map((candidate, index) => [candidate.contract.entity.name, { candidate, table: tables[index]! }]));
  for (const { candidate, table } of byEntity.values()) {
    const versioning = candidate.contract.versioning;
    if (!versioning) continue;
    const head = candidate.contract.entity.name;
    const version = byEntity.get(versioning.versionEntity);
    if (!version) throw new Error(`${head}: versioning.versionEntity ${versioning.versionEntity} has no storage in this manifest.`);
    const inverse = candidate.contract.model.relationships.find((relationship) =>
      relationship.kind === "hasMany" && relationship.key === versioning.versionsField && relationship.target === versioning.versionEntity);
    if (!inverse?.foreignKey) throw new Error(`${head}: versioning.versionsField ${versioning.versionsField} is not an owned collection of ${versioning.versionEntity}.`);
    const column = version.table.columns.find((column) => column.name === inverse.foreignKey);
    const reference = column?.references;
    if (!reference || reference.schema !== table.schema || reference.table !== table.name) {
      throw new Error(`${head}: ${versioning.versionEntity}.${inverse.foreignKey} must reference ${table.schema}.${table.name}.`);
    }
    table.source!.versioning = {
      ...versioning,
      storage: {
        head: { schema: table.schema, table: table.name },
        version: { schema: version.table.schema, table: version.table.name, headColumn: column.name },
        owned: ownedChildren(byEntity, head, version.table, [head]),
      },
    };
  }
}

/**
 * Lower `authorization.ownerAxis` once every reference is a column: each
 * owning reference becomes an axis of the referenced entity's read roles, as
 * that entity authors them, so a host renaming a role renames the policy.
 */
function bindOwnerAxes(candidates: CompiledCandidate[], tables: TableDefinition[]): void {
  const byEntity = new Map(candidates.map((candidate, index) => [candidate.contract.entity.name, { candidate, table: tables[index]! }]));
  for (const { candidate, table } of byEntity.values()) {
    const ownerAxis = candidate.contract.authorization?.ownerAxis;
    if (!ownerAxis) continue;
    const entity = candidate.contract.entity.name;
    if (!table.tenantScoped) throw new Error(`${entity}: authorization.ownerAxis requires a tenant-scoped entity.`);
    const axes: OwnerAxisPolicy["axes"] = [];
    for (const key of ownerAxis.fields) {
      const relationship = candidate.contract.model.relationships.find((relationship) => relationship.kind === "belongsTo" && (relationship.fieldKey ?? relationship.key) === key);
      const column = relationship?.foreignKey ? table.columns.find((column) => column.name === relationship.foreignKey) : undefined;
      if (!relationship || !column?.references) throw new Error(`${entity}: authorization.ownerAxis.fields "${key}" has no lowered owner foreign key.`);
      if (column.required) throw new Error(`${entity}: authorization.ownerAxis.fields "${key}" must be optional; a row has exactly one of several owners.`);
      const owner = byEntity.get(relationship.target);
      const roles = owner?.candidate.contract.authorization?.roles.read ?? [];
      if (!owner || !roles.length) throw new Error(`${entity}: authorization.ownerAxis.fields "${key}" references ${relationship.target}, which has no read roles in this manifest.`);
      const owned = owner.candidate.contract.model.relationships.some((inverse) =>
        inverse.kind === "hasMany" && inverse.target === entity && inverse.foreignKey === column.name && inverse.ownership === "owned");
      if (!owned) throw new Error(`${entity}: authorization.ownerAxis.fields "${key}" must be an owning reference (relationship.inverse.ownership: owned).`);
      axes.push({ column: column.name, roles: [...new Set(roles)].sort() });
    }
    table.ownerAxis = { axes, ...(ownerAxis.command ? { command: { setting: ownerAxis.command.setting, values: [...ownerAxis.command.values] } } : {}) };
    // Exactly one owner: the policy above admits a row through the one owner
    // column that is set, so a row with none or two would slip between axes.
    const expression = `num_nonnulls(${axes.map((axis) => `"${axis.column}"`).sort().join(", ")}) = 1`;
    const constraints = table.constraints ??= [];
    if (!constraints.some((constraint) => constraint.kind === "check" && constraint.expression === expression)) {
      const name = `${table.name}_owner_axis_check`;
      if (constraints.some((constraint) => constraint.name === name)) throw new Error(`${entity}: owner axis constraint collides with ${name}.`);
      constraints.push({ compilerOwned: true, version: `0001_owner-axis-${table.name.replaceAll("_", "-")}`, name, kind: "check", expression });
    }
  }
}

/**
 * The owned collections under one entity, as authored (`ownership: owned` on
 * the inverse), lowered to the child table's foreign-key columns. Recursive
 * because `snapshot.ownedRelationships: recursive` is; the version table is
 * left out at every level (a snapshot is content, never publication history)
 * and a cycle through ownership is refused rather than walked.
 */
function ownedChildren(
  byEntity: Map<string, { candidate: CompiledCandidate; table: TableDefinition }>,
  entityName: string,
  versionTable: TableDefinition,
  path: string[],
): VersioningOwnedChild[] {
  const { candidate } = byEntity.get(entityName)!;
  const owned: VersioningOwnedChild[] = [];
  for (const relationship of candidate.contract.model.relationships) {
    if (relationship.kind !== "hasMany" || relationship.ownership !== "owned" || relationship.through || relationship.provider) continue;
    const child = byEntity.get(relationship.target);
    if (!child) continue;
    if (child.table.schema === versionTable.schema && child.table.name === versionTable.name) continue;
    if (path.includes(relationship.target)) {
      throw new Error(`${path[0]}: versioning snapshot ownership cycles through ${[...path, relationship.target].join(" -> ")}.`);
    }
    const column = child.table.columns.find((column) => column.name === relationship.foreignKey);
    const reference = column?.references;
    const parent = byEntity.get(entityName)!.table;
    if (!column || !reference || reference.schema !== parent.schema || reference.table !== parent.name) {
      throw new Error(`${entityName}.${relationship.key}: owned collection has no lowered foreign key on ${relationship.target}.`);
    }
    owned.push({
      schema: child.table.schema,
      table: child.table.name,
      childColumns: reference.localColumns ?? [column.name],
      parentColumns: reference.targetColumns ?? [reference.column],
      children: ownedChildren(byEntity, relationship.target, versionTable, [...path, relationship.target]),
    });
  }
  return owned.sort((left, right) => `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`));
}

/** Resolve field relations only after all tables exist, including cyclic references. */
function compileFieldRelationStorage(
  candidates: CompiledCandidate[],
  tables: TableDefinition[],
  register: RelationshipRegisterEntry[],
  valueCandidates: CompiledCandidate[],
): EntityValueRegistry | undefined {
  const byEntity = new Map(candidates.map((candidate, index) => [
    candidate.contract.entity.name, { candidate, table: tables[index]! },
  ]));
  const addIndex = (table: TableDefinition, columns: string[], unique = false) => {
    const indexes = table.indexes ??= [];
    if (indexes.some((index) => !index.where &&
      (!unique || index.unique) && index.columns.length === columns.length &&
      index.columns.every((column, index) => column === columns[index]))) return;
    const name = `${table.name}_${columns.join("_")}_${unique ? "key" : "idx"}`;
    if (indexes.some((index) => index.name === name)) {
      throw new Error(`Field relationship index collides with ${table.schema}.${name}.`);
    }
    indexes.push({
      name,
      columns,
      ...(unique ? { unique: true } : {}),
    });
  };
  const attachReference = (
    source: TableDefinition,
    column: ColumnDefinition,
    target: TableDefinition,
    unique = false,
    onDelete?: ReferenceDefinition["onDelete"],
  ) => {
    const targetId = target.columns.find((candidate) => candidate.name === "id");
    if (!targetId || targetId.type !== "uuid" || !targetId.primaryKey) {
      throw new Error(`Field relationship target ${tableKey(target)} requires a UUID id primary key.`);
    }
    if (!source.tenantScoped && target.tenantScoped) {
      throw new Error(`Global table ${tableKey(source)} cannot reference tenant-scoped ${tableKey(target)} without a tenant identity.`);
    }
    const previous = column.references;
    if (previous && (previous.schema !== target.schema || previous.table !== target.name || previous.column !== "id")) {
      throw new Error(`Conflicting field relationships for ${tableKey(source)}.${column.name}.`);
    }
    column.type = "uuid";
    // This column already IS the caller's authoritative tenant identity and
    // is set exclusively by the verified session. Preserve its ordinary FK
    // and authored nullability; prepending it again would change the target
    // constraint to (tenant_id, tenant_id) rather than scope another value.
    const tenancyIdentity = source.tenantScoped && column.name === "tenant_id";
    if (tenancyIdentity && (unique || onDelete)) {
      throw new Error(`Server-managed tenant identity ${tableKey(source)}.${column.name} cannot be owned or unique through a relationship.`);
    }
    // A tenant column pointing at a tenant-scoped registry is bound only if
    // that registry's rows ARE their tenant: the compiler stamps
    // CHECK (id = tenant_id) on the target, which the emitter requires
    // before it accepts the single-column key (tenant-bound-references.ts).
    if (tenancyIdentity && target.tenantScoped && !hasTenantIdentityCheck(target)) {
      const constraints = target.constraints ??= [];
      const name = tenantIdentityCheckName(target);
      if (constraints.some((constraint) => constraint.name === name)) {
        throw new Error(`Tenant identity check collides with ${tableKey(target)}.${name}.`);
      }
      constraints.push({
        compilerOwned: true,
        version: `0001_tenant-identity-${target.name.replaceAll("_", "-")}`,
        name,
        kind: "check",
        expression: TENANT_IDENTITY_CHECK_EXPRESSION,
      });
      // A registry row's id IS its tenant, so it comes from the verified
      // session rather than a random default: a generic create that supplies
      // only tenant_id then satisfies the check without knowing about it.
      const identity = target.columns.find((candidate) => candidate.name === "id")!;
      identity.default = "app.current_tenant()";
    }
    const composite = source.tenantScoped && target.tenantScoped && !tenancyIdentity;
    const deleteAction = onDelete ?? previous?.onDelete;
    column.references = {
      schema: target.schema, table: target.name, column: "id",
      ...(composite ? { localColumns: ["tenant_id", column.name], targetColumns: ["tenant_id", "id"] } : {}),
      ...(deleteAction ? { onDelete: deleteAction } : {}),
    };
    if (composite) {
      for (const table of [source, target]) {
        const tenant = table.columns.find((candidate) => candidate.name === "tenant_id");
        if (!tenant || tenant.type !== "uuid" || !tenant.required) {
          throw new Error(`Field relationships require a non-null UUID tenant_id on ${tableKey(table)}.`);
        }
      }
      addIndex(target, ["tenant_id", "id"], true);
    }
    addIndex(source, source.tenantScoped && !tenancyIdentity ? ["tenant_id", column.name] : [column.name], unique);
    if (source.schema !== target.schema && !isRelationshipRegistered(register,
      { schema: source.schema, table: source.name, column: column.name }, column.references)) {
      register.push({
        from: { schema: source.schema, table: source.name, column: column.name },
        to: { schema: target.schema, table: target.name, column: "id" },
      });
    }
    const emitted = source.source?.relationshipStatus?.emittedReferences;
    const description = `${column.name}->${tableKey(target)}.id`;
    if (emitted && !emitted.includes(description)) emitted.push(description);
  };

  for (const { candidate, table } of byEntity.values()) {
    for (const relationship of candidate.contract.model.relationships) {
      // Provider-backed: no storage on either side, nothing to reference.
      if (relationship.provider) continue;
      const target = byEntity.get(relationship.target);
      if (!target) {
        // A derived inverse collection has no storage of its own: when the
        // referencing entity is outside this manifest, the collection simply
        // is not lowered. An authored single reference without its target is
        // still a modelling error.
        if (relationship.kind === "hasMany") {
          const skipped = table.source?.relationshipStatus?.skippedReferences;
          if (skipped) skipped.push(`${relationship.key}<-${relationship.target} (referencing entity not allowlisted)`);
          continue;
        }
        throw new Error(`Field relationship ${candidate.contract.entity.name}.${relationship.key} targets missing entity ${relationship.target}. Include its storage in the backend manifest.`);
      }
      if (relationship.kind === "belongsTo") {
        const column = table.columns.find((column) => column.name === relationship.foreignKey);
        if (!column) throw new Error(`Field relationship ${candidate.contract.entity.name}.${relationship.key} has no persisted foreign-key column.`);
        attachReference(table, column, target.table, relationship.unique);
      } else if (relationship.kind === "hasMany") {
        const column = target.table.columns.find((column) => column.name === relationship.foreignKey);
        if (!column) throw new Error(`Field relationship ${candidate.contract.entity.name}.${relationship.key} has no inverse foreign-key column on ${relationship.target}.`);
        if (relationship.through) {
          const intermediate = byEntity.get(relationship.through.target);
          const local = table.columns.find(column => column.name === relationship.through!.column);
          if (!intermediate || !local || local.type !== "uuid" || column.type !== "uuid") {
            throw new Error(`Invalid inverse traversal storage for ${candidate.contract.entity.name}.${relationship.key}.`);
          }
          // Both references point at the intermediate identity, never at the
          // outer entity. No extra column, junction or ownership is introduced.
          attachReference(table, local, intermediate.table);
          attachReference(target.table, column, intermediate.table);
          continue;
        }
        attachReference(target.table, column, table, false, relationship.ownership === "owned" ? "CASCADE" : undefined);
        if (relationship.sortable) {
          const positionName = `${column.name}_position`;
          if (Buffer.byteLength(positionName) > 63) throw new Error(`Sortable relationship column exceeds PostgreSQL's identifier limit: ${positionName}.`);
          const existingPosition = target.table.columns.find((column) => column.name === positionName);
          if (existingPosition) throw new Error(`Sortable relationship storage collides with ${tableKey(target.table)}.${positionName}.`);
          target.table.columns.push({ name: positionName, type: "integer", required: true, default: "0" });
          addIndex(target.table, [...(target.table.tenantScoped ? ["tenant_id"] : []), column.name, positionName]);
        }
      }
    }
  }
  return compileEntityValueStorage(valueCandidates, tables, attachReference);
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
  const generatedCrudAllowlist = new Set(
    (options.generatedCrudAllowlist ?? []).map(kebabCase),
  );
  const domainInternalEntities = new Set((options.domainInternalEntities ?? []).map(kebabCase));
  const relationshipRegister = [...(options.relationshipRegister ?? [])];
  const schemaByModule = options.schemaByModule ?? { core: "erp" };
  const candidates: CompiledCandidate[] = allowlist.map((slug) =>
    compileCoreCandidate(authoringDir, slug, sourcePathPrefix),
  );

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

  const definitionNames = entityValueDefinitionNames(candidates);
  for (const name of definitionNames) {
    const definition = candidates.find((candidate) => candidate.contract.entity.name === name);
    if (!definition) throw new Error(`Allowed entity-value definition ${name} is absent from the compiled entity corpus.`);
    assertEntityValueDefinition(definition);
  }
  const physicalCandidates = candidates.filter((candidate) => {
    if (!candidate.contract.entity.valueDefinition) return true;
    if (!definitionNames.has(candidate.contract.entity.name)) {
      throw new Error(`${candidate.contract.entity.name}: identity-less entities must be used as entityValue definitions.`);
    }
    assertEntityValueDefinition(candidate);
    return false;
  });

  const byEntityName = new Map(
    candidates.map((candidate) => [candidate.contract.entity.name, candidate]),
  );

  const tables: TableDefinition[] = physicalCandidates.map((candidate) => {
    const schema = schemaByModule[candidate.contract.entity.module] ?? snakeCase(candidate.contract.entity.module);
    const name = candidate.contract.storage.table;
    const candidateCrudKey = candidate.origin.slug;
    const domainInternal = domainInternalEntities.has(candidate.slug);
    const crudOperations = candidate.contract.crud?.operations ?? {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
    };
    const generatedCrudEligible =
      generatedCrudAllowlist.has(candidateCrudKey) &&
      Object.values(crudOperations).some(Boolean) &&
      !domainInternal;
    // Fail closed: an authored `rest:` block on an entity that is not
    // generated-CRUD enabled (not allowlisted, or domain-internal) is a
    // misconfiguration — REST routes delegate to the generated CRUD layer,
    // so silently dropping the block would hide the authoring intent.
    if (candidate.contract.rest && !generatedCrudEligible) {
      throw new Error(
        `Entity ${describeCandidateOrigin(candidate)} declares a rest: block but is not ` +
          `generated-CRUD enabled${domainInternal ? " (domain-internal)" : ""}. ` +
          `Add it to the generated CRUD allowlist or remove the rest: block.`,
      );
    }
    // Same fail-closed reasoning as rest: MCP tools delegate to the generated
    // CRUD layer, so interfaces.mcp on an entity that has none is authoring
    // intent that would silently evaporate.
    if (candidate.contract.mcp && !generatedCrudEligible) {
      throw new Error(
        `Entity ${describeCandidateOrigin(candidate)} declares interfaces.mcp but is not ` +
          `generated-CRUD enabled${domainInternal ? " (domain-internal)" : ""}. ` +
          `Add it to the generated CRUD allowlist or remove interfaces.mcp.`,
      );
    }
    const tenantScoped = candidate.contract.authorization !== undefined;
    const emittedReferences: string[] = [];
    const skippedReferences: string[] = [];
    const columnsByField = new Map<string, ColumnDefinition>();
    const columns: ColumnDefinition[] = [];
    // Field-key → restricting data-classification (pii/bsn/confidential), used
    // to stamp each backing column so the runtime can redact it (#96/#101).
    const fieldSensitivities = collectFieldSensitivities(candidate.contract.model.fields);
    // Field keys authored `immutable: true`, stamped onto their backing column
    // so the transports can refuse them on update (#177).
    const immutableFields = collectImmutableFieldKeys(candidate.contract.model.fields);
    // Field keys authored `writtenBy: [...]`, stamped onto their backing column
    // so no transport offers them on create/update and the CRUD layer can name
    // the operation that may set them.
    const fieldWriters = collectFieldWriters(candidate.contract.model.fields);

    for (const storageColumn of candidate.contract.storage.columns) {
      const field = candidate.fieldsByKey.get(storageColumn.field);
      const primaryKey = storageColumn.column === "id";
      const sensitivity = fieldSensitivities.get(storageColumn.field);
      const column: ColumnDefinition = {
        name: storageColumn.column,
        // Storage compilation is the single field-to-SQL type authority. Do
        // not reconstruct it here: doing so silently collapsed bounded wide
        // integers back to int4 after the entity contract already chose int8.
        type: storageColumn.type as ColumnDefinition["type"],
        ...(primaryKey ? { primaryKey: true } : {}),
        ...(primaryKey || !storageColumn.nullable ? { required: true } : {}),
        sourceField: storageColumn.field,
        ...(sensitivity ? { classification: sensitivity } : {}),
        ...(immutableFields.has(storageColumn.field) ? { immutable: true as const } : {}),
        ...(fieldWriters.has(storageColumn.field)
          ? { writtenBy: fieldWriters.get(storageColumn.field)! }
          : {}),
      };
      if (field) assertDefaultSatisfiesContract(field);
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
      // The tenant column is the row's identity under row-level security and
      // the leading half of every key into this table; an authored
      // `required: false` on it would leave those keys unchecked (a NULL
      // half passes MATCH SIMPLE). Required, whatever the field says.
      existingTenantColumn.type = "uuid";
      existingTenantColumn.required = true;
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

    // Relationships are lowered once every table exists, in
    // compileFieldRelationStorage, for every authoring version alike.
    const columnsByNameWithOperational = new Map(columns.map((column) => [column.name, column]));
    const retention = compileRetention(candidate, columnsByField, columnsByNameWithOperational);

    const compiledIndexes = compileEntityIndexes(candidate, tenantScoped, columnsByField);
    for (const binding of resolveDerivedOnCreateBindings({
      entityName: candidate.contract.entity.name,
      fields: candidate.contract.model.fields,
      columns: candidate.contract.storage.columns,
      ...(candidate.contract.entity.indexes
        ? { indexes: candidate.contract.entity.indexes }
        : {}),
      tenantScoped,
    })) {
      const target = columnsByField.get(binding.targetField)!;
      target.deriveOnCreate = {
        sourceField: binding.sourceField,
        sourceColumn: binding.sourceColumn,
        transform: binding.transform,
        onConflict: binding.onConflict,
        conflictColumns: binding.conflictColumns,
        ...(binding.maxLength === undefined ? {} : { maxLength: binding.maxLength }),
      };
    }

    // Row-level access → rowScope translation (§B.3) + fail-closed guards (§C).
    const rowAccess = candidate.contract.authorization?.rowAccess;
    // §C.2 fail-closed: `empty: restricted` only makes sense when there is an
    // owner/group column that can be NULL or an action-specific record ACL.
    // Without any axis, "restricted" would
    // hide every row or silently degrade to tenant scoping — a declared-but-
    // unemitted confidentiality. Convert to a hard build failure.
    if (
      rowAccess?.enabled &&
      rowAccess.empty === "restricted" &&
      !rowAccess.owner &&
      !rowAccess.group &&
      !rowAccess.recordPermissions
    ) {
      throw new Error(
        `[${candidate.contract.entity.name}] authorization.rowAccess.empty: restricted requires an owner, group or record-permissions axis — ` +
          `otherwise the entity has no confidentiality predicate and "restricted" would hide every row ` +
          `or silently degrade to tenant scoping. Add a restriction axis or set empty: public.`,
      );
    }
    if (candidate.contract.blueprint && !tenantScoped) {
      throw new Error(`[${candidate.contract.entity.name}] blueprint copying requires a tenant-scoped entity.`);
    }
    const rowScope = deriveRowScope(
      rowAccess,
      candidate.contract.entity.name,
      columnsByNameWithOperational,
    );
    const valueChecks = fieldValueCheckConstraints(schema, name, candidate.contract.storage.columns.map((storageColumn) => ({
      field: candidate.fieldsByKey.get(storageColumn.field),
      column: columnsByField.get(storageColumn.field)!,
    })));

    return {
      schema,
      name,
      tenantScoped,
      domainInternal,
      ...(candidate.contract.workerAccess ? { workerAccess: candidate.contract.workerAccess } : {}),
      generatedCrudEligible,
      columns,
      ...(rowScope ? { rowScope } : {}),
      ...(compiledIndexes.length > 0 ? { indexes: compiledIndexes } : {}),
      ...(valueChecks.length > 0 ? { constraints: valueChecks } : {}),
      ...(retention === undefined ? {} : { retention }),
      source: {
        path: candidate.path,
        ...(candidate.contract.blueprint ? { blueprint: candidate.contract.blueprint } : {}),
        ...(candidate.contract.transitions ? { transitions: candidate.contract.transitions } : {}),
        authoringEntityName: candidate.contract.entity.name,
        authoringEntitySlug: candidate.slug,
        generatedCrudEligibility: generatedCrudEligible ? "explicitly_enabled" : "explicitly_disabled",
        ...(candidate.contract.hardDelete
          ? { hardDelete: candidate.contract.hardDelete }
          : {}),
        crud: { operations: crudOperations },
        ...(() => {
          const secureInput = candidate.contract.entityOperations.create
            ?.interaction.secureInput;
          if (!secureInput) return {};
          const { type: _type, ...secureInputOnCreate } = secureInput;
          return { secureInputOnCreate };
        })(),
        ...(candidate.contract.entity.labels
          ? { labels: candidate.contract.entity.labels }
          : {}),
        ...(candidate.contract.entity.displayTemplate
          ? { displayTemplate: candidate.contract.entity.displayTemplate }
          : {}),
        ...(() => {
          const computedFields = candidate.contract.model.fields
            .filter((field) => field.osfType === "labelSet")
            .map((field) => ({ field: field.key, resolver: "labelRules" as const }));
          return computedFields.length > 0 ? { computedFields } : {};
        })(),
        graphql: {
          typeName: candidate.contract.graphql.typeName,
          singleQueryName: candidate.contract.graphql.queries.single.name,
          listQueryName: candidate.contract.graphql.queries.list.name,
          createMutationName: candidate.contract.graphql.mutations.create.name,
          updateMutationName: candidate.contract.graphql.mutations.update.name,
          deleteMutationName: candidate.contract.graphql.mutations.delete.name,
          ...(candidate.contract.graphql.operations
            ? { operations: candidate.contract.graphql.operations }
            : {}),
          relationships: candidate.contract.graphql.relationships
            .filter((relationship) => relationship.resolve !== "hasMany" || byEntityName.has(relationship.target))
            .map((relationship) => ({
              name: relationship.name,
              target: relationship.target,
              type: relationship.type,
              resolve: relationship.resolve === "belongsTo" ? "belongsTo" as const : "hasMany" as const,
              ...(relationship.foreignKey ? { foreignKey: relationship.foreignKey } : {}),
              ...(() => {
                const normalized = candidate.contract.model.relationships.find((entry) => entry.key === relationship.name);
                if (!normalized?.fieldKey) return {};
                return {
                  fieldKey: normalized.fieldKey, kind: normalized.kind,
                  ...(normalized.inverse ? { inverse: normalized.inverse } : {}),
                  ...(normalized.through ? { through: normalized.through } : {}),
                  ...(normalized.ownership ? { ownership: normalized.ownership } : {}),
                  ...(normalized.cardinality ? { cardinality: normalized.cardinality } : {}),
                  ...(normalized.sortable ? { sortable: true, positionColumn: `${normalized.foreignKey}_position` } : {}),
                  ...(normalized.childAuthorization ? { childAuthorization: normalized.childAuthorization } : {}),
                  ...(normalized.childLock ? { childLock: normalized.childLock } : {}),
                  ...(normalized.version ? { version: normalized.version } : {}),
                  ...(normalized.via ? { via: normalized.via, viaSchema: schema } : {}),
                  ...(normalized.constraints ? { constraints: structuredClone(normalized.constraints) } : {}),
                  ...(normalized.kind !== "belongsTo" ? { mutationSupport: "unsupported" as const } : {}),
                };
              })(),
            })),
          ...(() => {
            const defaultSort = pickEmbeddedDefaultSort(candidate.contract.views);
            return defaultSort ? { defaultSort } : {};
          })(),
        },
        ...(candidate.contract.rest ? { rest: candidate.contract.rest } : {}),
        ...(candidate.contract.mcp ? { mcp: candidate.contract.mcp } : {}),
        // Compiled per-operation role lists → runtime enforcement (#94). Emitted
        // as the authored ∪ Keycloak-normalized union so a session authenticated
        // either way (bearer token or trusted context) matches by plain set
        // intersection.
        ...(candidate.contract.authorization
          ? {
              authorization: {
                roles: bridgeAuthorizationRoles(candidate.contract.authorization.roles),
                ...(candidate.contract.authorization.rowAccess?.recordPermissions
                  ? {
                      recordPermissions: {
                        ...candidate.contract.authorization.rowAccess.recordPermissions,
                      },
                    }
                  : {}),
              },
            }
          : {}),
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

  const entityValues = compileFieldRelationStorage(physicalCandidates, tables, relationshipRegister, candidates);
  bindVersioningStorage(physicalCandidates, tables);
  bindOwnerAxes(physicalCandidates, tables);

  return {
    version: 1,
    description: "Candidate backend manifest compiled from restored authoring catalog.",
    relationshipRegister: filterRelationshipRegisterForTables(tables, relationshipRegister),
    tables: sortTablesByDependencies(tables),
    ...(entityValues ? { entityValues } : {}),
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
      const currentGeneratedCrud = isGeneratedCrudEligible(currentTable);
      const candidateGeneratedCrud = isGeneratedCrudEligible(candidateTable);
      if (currentGeneratedCrud !== candidateGeneratedCrud) {
        changedMetadata.push(
          `generatedCrudEligible current=${currentGeneratedCrud} candidate=${candidateGeneratedCrud}`,
        );
      }
      const currentCrudOperations = JSON.stringify(
        currentTable.source?.crud?.operations ?? null,
      );
      const candidateCrudOperations = JSON.stringify(
        candidateTable.source?.crud?.operations ?? null,
      );
      if (currentCrudOperations !== candidateCrudOperations) {
        changedMetadata.push("crud.operations differ");
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
