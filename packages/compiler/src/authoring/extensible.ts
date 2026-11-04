// SPDX-License-Identifier: BUSL-1.1
/**
 * Extensible entities: an authored entity whose tenants may add fields of
 * their own at runtime (docs/authoring.md, "Extensible entities").
 *
 * The authored `extensible:` block is resolved here against the osfType
 * catalog (compileExtensible) and lowered into storage beside the entity
 * table (compileExtensionStorage):
 *
 *   - `extension_values jsonb not null default '{}'` on the entity table, the
 *     source of every tenant value, keyed by field id;
 *   - `<table>_field_values`, one typed index row per record, field and
 *     collection element, which filters and sorting read;
 *   - `<table>_field_unique_values`, the claimed values of `unique` fields.
 *
 * Both side tables reference the entity row through the composite tenant key
 * and cascade with it. They carry the entity's own tenant policy and, beside
 * it, a restrictive policy that admits an index row or claim only while the
 * session may see the entity row it describes (`recordAccessFrom`), so every
 * row policy of the entity — authorization profiles included — holds for its
 * index too. An extensible entity still may not declare a
 * row-scope axis, owner axis or record ACL: the inherited policy
 * covers reads of the index, but that alone has not been shown to cover every
 * path of such entities. Nor may an entity that is an owned child be
 * extensible: the snapshot of its owner would freeze its raw source. Every
 * change here is additive, so a built database rolls forward without a
 * versioned migration.
 */
import { BASE_TYPES } from "./entity-fields.js";
import type { ExtensionReadAccess, ExtensionRegistry, ExtensionRegistryEntity, ExtensionRegistryRelation } from "./extension-registry-types.js";
import type { CoreEntity, ExtensionIndexColumn, OsfTypeDefinition, OsfTypeIndexProjection } from "./types.js";
import type { CompiledEntityContract, CompiledExtensible } from "./types/compiled.js";
import { hasTenantIdentityCheck } from "../tenant-bound-references.js";
import { isGeneratedCrudEligible, type IndexDefinition, type ReferenceDefinition, type StatisticsDefinition, type TableDefinition } from "../schema.js";

/** The source column on the entity table. */
export const EXTENSION_VALUES_COLUMN = "extension_values";
/** Record-level properties that carry tenant values and their state on every transport. */
export const EXTENSIONS_RECORD_FIELD = "extensions";
export const EXTENSIONS_META_RECORD_FIELD = "extensionsMeta";
/** May always manage tenant fields, whatever the entity authors (the organization administrator). */
export const EXTENSION_ADMINISTRATOR_ROLE = "Organization.All.ReadWrite";

export const EXTENSIBLE_LIMIT_DEFAULTS: CompiledExtensible["limits"] = {
  fields: 100,
  filtersPerQuery: 5,
  formulaDepth: 5,
  syncFanOut: 100,
};

/**
 * Catalog types no tenant field may use: definitions of other values
 * (typedValue, fieldDefinition, entityValue), structure without one value
 * (keyValueMap, variableTemplate, labelSet) and `condition`, which exists only
 * inside `appliesWhen` and `where`. An object type without an index
 * projection is excluded as well, by rule rather than by name.
 */
export const EXTENSION_TYPE_DENYLIST: readonly string[] = [
  "condition",
  "entityValue",
  "fieldDefinition",
  "keyValueMap",
  "labelSet",
  "typedValue",
  "variableTemplate",
];

/** Index column of each projection slot, and the base types whose values land in it. */
export const EXTENSION_INDEX_COLUMNS: Record<ExtensionIndexColumn, { column: string; baseTypes: readonly string[] }> = {
  text: { column: "value_text", baseTypes: ["string"] },
  number: { column: "value_number", baseTypes: ["integer", "number"] },
  boolean: { column: "value_boolean", baseTypes: ["boolean"] },
  date: { column: "value_date", baseTypes: ["date"] },
  timestamp: { column: "value_timestamp", baseTypes: ["datetime"] },
};

/**
 * The partial indexes of every `<table>_field_values` table, in one list so
 * the measured index shape can change in one place. Each is narrowed to the
 * rows that hold a value in its column; without that, the indexes are mostly
 * NULL, and every query on them states the matching `IS NOT NULL` (a
 * comparison implies it).
 *
 * The shape is the one a measurement of 200k records × 30 fields under RLS chose: `record_id` last
 * in every value index, so a filter's semi-join and a sort page are read from
 * the index alone, in `(value, record_id)` order with the tiebreaker included;
 * the reference index leads with the referenced id, so "referenced by" and the
 * fan-out walk find a target's referrers without a heap visit.
 *
 * Renaming or reshaping an entry is not additive: an index under an existing
 * name needs a versioned migration. A reshaped entry therefore gets a new
 * name, and the roll-forward adds it. The first shape, `(tenant_id, field_id,
 * <column>)` and `(tenant_id, value_ref_id)` as `<table>_<column>_idx`, is no
 * longer declared; a database built with it keeps those indexes (a prefix of
 * the new ones, so harmless and unused) until it is rebuilt or they are
 * dropped by hand. No persistent database carries them: they never left an
 * unreleased branch.
 */
export const EXTENSION_VALUE_INDEXES: ReadonlyArray<{ suffix: string; columns: readonly string[]; where: string }> = [
  ...Object.values(EXTENSION_INDEX_COLUMNS).map(({ column }) => ({
    suffix: `${column}_record`,
    columns: ["tenant_id", "field_id", column, "record_id"],
    where: `${column} IS NOT NULL`,
  })),
  {
    suffix: "value_ref_id_record",
    columns: ["tenant_id", "value_ref_id", "field_id", "record_id"],
    where: "value_ref_id IS NOT NULL",
  },
];

/**
 * Planner statistics of every `<table>_field_values` table: a most-common-
 * values list over `(field_id, <column>)` per index column, at a high target.
 * All fields of all tenants share one value column, so without the pair the
 * planner multiplies two independent estimates and misjudges a field plus
 * value by an order of magnitude (617 estimated against 17,935 rows in the
 * the measurement above). A backfill that rewrites many rows does not
 * run ANALYZE afterwards: the worker holds no MAINTAIN on the table, and
 * autovacuum's ANALYZE refreshes these statistics once enough rows changed.
 */
export const EXTENSION_VALUE_STATISTICS_TARGET = 1000;

const POSTGRES_IDENTIFIER_BYTES = 63;

function fail(entity: string, message: string): never {
  throw new Error(`[${entity}] extensible ${message}`);
}

function baseTypeOf(osfType: string, osfTypes: Record<string, OsfTypeDefinition>): string | undefined {
  return (BASE_TYPES as readonly string[]).includes(osfType) ? osfType : osfTypes[osfType]?.baseType;
}

/**
 * An index projection names, per index column, the child of an object type
 * that fills it; the child's base type must be one that column stores.
 */
export function assertIndexProjection(
  name: string,
  definition: OsfTypeDefinition,
  osfTypes: Record<string, OsfTypeDefinition>,
): void {
  const projection = definition.indexProjection;
  if (!projection) return;
  if (definition.baseType !== "object") {
    throw new Error(`osfType ${name} declares indexProjection, but only an object type has components to project.`);
  }
  const entries = Object.entries(projection);
  if (entries.length === 0) throw new Error(`osfType ${name} declares an empty indexProjection.`);
  const seen = new Set<string>();
  for (const [slot, childKey] of entries) {
    const target = EXTENSION_INDEX_COLUMNS[slot as ExtensionIndexColumn];
    if (!target) throw new Error(`osfType ${name} indexProjection has unknown index column ${slot}.`);
    if (seen.has(childKey)) throw new Error(`osfType ${name} indexProjection projects ${childKey} twice.`);
    seen.add(childKey);
    const child = definition.children?.find((candidate) => candidate.key === childKey);
    if (!child) throw new Error(`osfType ${name} indexProjection.${slot} names ${childKey}, which is not a child of ${name}.`);
    const childBase = child.osfType ? baseTypeOf(child.osfType, osfTypes) : undefined;
    if (child.cardinality === "collection" || !childBase || !target.baseTypes.includes(childBase)) {
      throw new Error(
        `osfType ${name} indexProjection.${slot} names ${childKey}, whose type ${child.osfType ?? "(none)"} ` +
          `does not land in ${target.column} (expects ${target.baseTypes.join(" or ")}).`,
      );
    }
  }
}

/** The osfType names an extensible entity offers its tenants, and the projections of its object types. */
function allowedOsfTypes(
  osfTypes: Record<string, OsfTypeDefinition>,
  excluded: ReadonlySet<string>,
): { allowed: string[]; indexProjections: Record<string, OsfTypeIndexProjection> } {
  const allowed = new Set<string>(BASE_TYPES.filter((type) => type !== "object" && !excluded.has(type)));
  const indexProjections: Record<string, OsfTypeIndexProjection> = {};
  for (const [name, definition] of Object.entries(osfTypes)) {
    // Entity, identity and provider types are references: a tenant reference
    // field names its target entity, which `targets` governs.
    if (definition.kind === "entity" || definition.kind === "entityId" || definition.kind === "provider" || definition.entityIdentity) continue;
    if (EXTENSION_TYPE_DENYLIST.includes(name) || excluded.has(name)) continue;
    if (definition.baseType === "object") {
      if (!definition.indexProjection) continue;
      assertIndexProjection(name, definition, osfTypes);
      indexProjections[name] = { ...definition.indexProjection };
    } else if (definition.indexProjection) {
      assertIndexProjection(name, definition, osfTypes);
    }
    allowed.add(name);
  }
  return {
    allowed: [...allowed].sort(),
    indexProjections: Object.fromEntries(Object.entries(indexProjections).sort(([left], [right]) => left.localeCompare(right))),
  };
}

/**
 * Resolve and check an entity's `extensible:` block. Refuses, with the reason,
 * every entity whose rows the side tables could not protect exactly as the
 * entity table does (decision 15 of the design): no row-scope axis, no owner
 * axis and no record ACL, because the side tables carry none of the columns
 * those policies read.
 */
export function compileExtensible(
  entity: CoreEntity,
  osfTypes: Record<string, OsfTypeDefinition>,
): CompiledExtensible | undefined {
  const extensible = entity.extensible;
  if (!extensible) return undefined;
  const name = entity.entity;
  if (entity.subtype) fail(name, "is not inherited by a subtype and cannot be declared on one; declare it on the base entity.");
  if (entity.source) fail(name, "requires a stored entity; an Operation-backed entity has no table to hold tenant values.");
  if (entity.baseEntity === false && !entity.fields.some((field) => field.key === "id")) {
    fail(name, "requires record identity; a value definition has no record to hold tenant values.");
  }
  const authorization = entity.authorization;
  if (!authorization) fail(name, "requires a tenant-scoped entity with authorization roles.");
  const rowAccess = authorization.rowAccess?.enabled ? authorization.rowAccess : undefined;
  // The index tables inherit the entity's row policies (recordAccessFrom),
  // but the rest of the tenant field paths has not been proven against
  // these axes; refused until it is (decision 15, kept after review).
  const scopeReason = "tenant fields are not yet proven for entities whose rows are visible to fewer than all tenant readers";
  if (rowAccess?.owner || rowAccess?.group) {
    fail(name, `is not available on an entity with a row-scope axis (authorization.rowAccess.${rowAccess.owner ? "owner" : "group"}): ${scopeReason}.`);
  }
  if (rowAccess?.recordPermissions) {
    fail(name, `is not available on an entity with a record ACL (authorization.rowAccess.recordPermissions): ${scopeReason}.`);
  }
  if (authorization.ownerAxis) {
    fail(name, `is not available on an entity with an owner axis (authorization.ownerAxis): ${scopeReason}.`);
  }
  const manage = extensible.authorization?.manage ?? [];
  if (manage.length === 0 || manage.some((role) => typeof role !== "string" || !role.trim())) {
    fail(name, "requires authorization.manage with at least one role.");
  }
  for (const field of entity.fields) {
    if (field.key === EXTENSIONS_RECORD_FIELD || field.key === EXTENSIONS_META_RECORD_FIELD) {
      fail(name, `reserves the record property "${field.key}" for tenant values; rename the authored field.`);
    }
    if (field.persisted?.column === EXTENSION_VALUES_COLUMN) {
      fail(name, `reserves the column ${EXTENSION_VALUES_COLUMN} for tenant values; rename the column of field "${field.key}".`);
    }
  }
  const excludedTypes = [...new Set(extensible.excludedTypes ?? [])].sort();
  for (const type of excludedTypes) {
    if (!baseTypeOf(type, osfTypes)) fail(name, `excludedTypes names ${type}, which is not an osfType of the catalog.`);
  }
  const limits = { ...EXTENSIBLE_LIMIT_DEFAULTS, ...(extensible.limits ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) fail(name, `limits.${key} must be a positive integer.`);
  }
  const { allowed, indexProjections } = allowedOsfTypes(osfTypes, new Set(excludedTypes));
  return {
    manageRoles: [...new Set([...manage, EXTENSION_ADMINISTRATOR_ROLE])].sort(),
    limits,
    allowedOsfTypes: allowed,
    indexProjections,
    excludedTypes,
    excludedTargets: [...new Set(extensible.excludedTargets ?? [])].sort(),
  };
}

/**
 * The platform's access-control model: who may do what in a tenant. A tenant
 * reference to one of these rows would let any writer of the extensible
 * entity hold a grant or policy in place (`onDelete: restrict` refuses its
 * revocation) and count who points at it, so none of them is ever a target,
 * whatever a host composes. Named, because nothing in their contract sets
 * them apart from business records.
 */
export const EXTENSION_TARGET_DENYLIST: readonly string[] = [
  "AuthorizationOperationPolicy",
  "AuthorizationProfile",
  "AuthorizationProfileAssignment",
  "AuthorizationProfilePolicy",
  "AuthorizationProfileVersion",
  "OrganizationPermission",
  "UserOrganizationPermission",
];

/**
 * Whether a tenant reference field may point at this entity at all, and so
 * whether it carries `referencedBy`: a stored, tenant-scoped record a reader
 * can resolve through its own `get`. Never, by rule:
 *
 *   - a table in the `platform` schema;
 *   - a tenant registry, whose row IS its tenant (`CHECK (id = tenant_id)`,
 *     or a global registry's `tenantIdentityColumn`): `Tenant`. A field
 *     pointing at it says nothing, and the registry stays read-only;
 *   - an entity with no generated create, update or delete of its own. Its
 *     rows are kept by the platform, a plugin Operation or the parent that
 *     owns them (`Tenant`, version snapshots, runs, sequences, renditions,
 *     owned children), and the deletion guard of a tenant reference runs only
 *     on the entity's own delete, so a reference could not hold or follow
 *     them;
 *   - the access-control model (EXTENSION_TARGET_DENYLIST).
 *
 * A host narrows the set further per entity with `excludedTargets`.
 */
export function isExtensionTargetCandidate(
  contract: CompiledEntityContract,
  table?: Pick<TableDefinition, "schema" | "tenantScoped" | "domainInternal" | "generatedCrudEligible" | "constraints" | "tenantIdentityColumn">,
): boolean {
  if (!contract.authorization || contract.source || contract.subtype || contract.entity.valueDefinition) return false;
  if (!contract.entityOperations.get) return false;
  if (EXTENSION_TARGET_DENYLIST.includes(contract.entity.name)) return false;
  const operations = contract.entityOperations;
  if (!operations.create && !operations.update && !operations.delete) return false;
  if (!table) return true;
  if (table.tenantIdentityColumn || hasTenantIdentityCheck(table)) return false;
  return table.tenantScoped && table.schema !== "platform" && isGeneratedCrudEligible(table);
}

const qualified = (table: Pick<TableDefinition, "schema" | "name">) => `${table.schema}.${table.name}`;

function sideTableName(entity: string, table: TableDefinition, suffix: string): string {
  const name = `${table.name}_${suffix}`;
  if (Buffer.byteLength(name) > POSTGRES_IDENTIFIER_BYTES) {
    fail(entity, `needs table ${table.schema}.${name}, which exceeds PostgreSQL's ${POSTGRES_IDENTIFIER_BYTES}-byte identifier limit; shorten the entity's table name.`);
  }
  return name;
}

/** The composite tenant reference from a side table to the entity row; deleting the row removes its index rows. */
function recordReference(table: TableDefinition): ReferenceDefinition {
  return {
    schema: table.schema, table: table.name, column: "id",
    localColumns: ["tenant_id", "record_id"], targetColumns: ["tenant_id", "id"],
    onDelete: "CASCADE",
  };
}

/** The unique `(tenant_id, id)` key the composite references need, named as every other one is. */
function ensureTenantRecordKey(table: TableDefinition): void {
  const indexes = table.indexes ??= [];
  if (indexes.some((index) => index.unique && !index.where && index.columns.join(",") === "tenant_id,id")) return;
  const name = `${table.name}_tenant_id_id_key`;
  if (indexes.some((index) => index.name === name)) throw new Error(`Composite reference key collides with ${qualified(table)}.${name}.`);
  indexes.push({ name, columns: ["tenant_id", "id"], unique: true });
}

/** What the worker may reach on the side tables: the entity's own surface, plus DML for the backfill. */
function workerSurface(table: TableDefinition): Pick<TableDefinition, "workerAccess" | "workerDml"> {
  return { ...(table.workerAccess ? { workerAccess: table.workerAccess } : {}), workerDml: true };
}

/** A side-table row is visible only while its entity row is (see the module comment). */
function recordAccess(table: TableDefinition): NonNullable<TableDefinition["recordAccessFrom"]> {
  return { schema: table.schema, table: table.name, column: "record_id" };
}

function valuesTable(entity: string, table: TableDefinition): TableDefinition {
  const name = sideTableName(entity, table, "field_values");
  const indexes: IndexDefinition[] = EXTENSION_VALUE_INDEXES.map((index) => ({
    name: `${name}_${index.suffix}_idx`,
    columns: [...index.columns],
    where: index.where,
  }));
  const statistics: StatisticsDefinition[] = Object.values(EXTENSION_INDEX_COLUMNS).map(({ column }) => ({
    name: `${name}_${column}_stats`,
    kinds: ["mcv"],
    columns: ["field_id", column],
    target: EXTENSION_VALUE_STATISTICS_TARGET,
  }));
  return {
    schema: table.schema,
    name,
    tenantScoped: true,
    domainInternal: true,
    generatedCrudEligible: false,
    ...workerSurface(table),
    recordAccessFrom: recordAccess(table),
    columns: [
      { name: "tenant_id", type: "uuid", required: true, primaryKey: true },
      { name: "record_id", type: "uuid", required: true, primaryKey: true, references: recordReference(table) },
      { name: "field_id", type: "uuid", required: true, primaryKey: true },
      { name: "ordinal", type: "integer", required: true, primaryKey: true, default: "0" },
      { name: "value_text", type: "text" },
      { name: "value_number", type: "numeric" },
      { name: "value_boolean", type: "boolean" },
      { name: "value_date", type: "date" },
      { name: "value_timestamp", type: "timestamptz" },
      { name: "value_ref_id", type: "uuid" },
    ],
    indexes,
    statistics,
  };
}

function uniqueValuesTable(entity: string, table: TableDefinition): TableDefinition {
  const name = sideTableName(entity, table, "field_unique_values");
  return {
    schema: table.schema,
    name,
    tenantScoped: true,
    domainInternal: true,
    generatedCrudEligible: false,
    ...workerSurface(table),
    recordAccessFrom: recordAccess(table),
    columns: [
      { name: "tenant_id", type: "uuid", required: true, primaryKey: true },
      { name: "field_id", type: "uuid", required: true, primaryKey: true },
      { name: "value_text", type: "text", required: true, primaryKey: true },
      { name: "record_id", type: "uuid", required: true, references: recordReference(table) },
    ],
    // The cascade from the entity row looks claims up by record.
    indexes: [{ name: `${name}_record_idx`, columns: ["tenant_id", "record_id"] }],
  };
}

/**
 * Owned children of which a record has at most one: an owned inverse
 * collection whose foreign key the child table holds unique per tenant (an
 * authored unique index, the shape a one-per-parent child takes today).
 *
 * This list is what a tenant formula may read beside its own record, and a
 * formula's result is read with the owner's rights. So a child is listed only
 * when it is provably authorized through its owner (childAuthorizedByOwner);
 * any other child stays out, and a formula naming it is refused as out of
 * scope.
 */
function ownedSingleChildren(
  owner: { contract: CompiledEntityContract; table: TableDefinition },
  byEntity: ReadonlyMap<string, { contract: CompiledEntityContract; table: TableDefinition }>,
): ExtensionRegistryEntity["ownedSingleChildren"] {
  const children: ExtensionRegistryEntity["ownedSingleChildren"] = [];
  for (const relationship of owner.contract.model.relationships) {
    if (relationship.kind !== "hasMany" || relationship.ownership !== "owned") continue;
    if (relationship.through || relationship.provider || relationship.via || !relationship.foreignKey) continue;
    const child = byEntity.get(relationship.target);
    if (!child) continue;
    const foreignKey = relationship.foreignKey;
    const keyed = (child.table.indexes ?? []).some((index) => index.unique && !index.where &&
      [`tenant_id,${foreignKey}`, foreignKey].includes(index.columns.join(",")));
    const bounded = typeof relationship.cardinality === "object" && relationship.cardinality.max === 1;
    if (!keyed && !bounded) continue;
    if (!childAuthorizedByOwner(owner, child, relationship.childAuthorization === "owner")) continue;
    children.push({ relation: relationship.key, entity: relationship.target, table: qualified(child.table), foreignKey });
  }
  return children.sort((left, right) => left.relation.localeCompare(right.relation));
}

const sameRoles = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n");

/**
 * Whether every reader of the owner may read the child's values that a formula
 * would show: the relation authorizes the child through its owner
 * (`childAuthorization: owner`), or the child has exactly the owner's read,
 * create, update and delete roles. Either way the child has no row policy of
 * its own (row scope, owner axis, record ACL), no per-profile or per-field
 * read roles, and no classified or field-policed column — rules the owner's
 * roles say nothing about, so a formula over the child could show a value to
 * an owner reader the child itself would hide.
 */
function childAuthorizedByOwner(
  owner: { contract: CompiledEntityContract },
  child: { contract: CompiledEntityContract; table: TableDefinition },
  throughOwner: boolean,
): boolean {
  const authorization = child.contract.authorization;
  if (child.table.rowScope || child.table.ownerAxis || child.table.source?.authorization?.recordPermissions) return false;
  if (authorization.rowAccess?.enabled || authorization.ownerAxis) return false;
  if (Object.keys(authorization.profileAuthorizations ?? {}).length || authorization.fieldAuthorizations.length) return false;
  if (child.table.columns.some((column) => column.classification || column.fieldPolicy)) return false;
  if (throughOwner) return true;
  const roles = owner.contract.authorization.roles;
  return (["read", "create", "update", "delete"] as const).every((action) => sameRoles(roles[action], authorization.roles[action]));
}

/**
 * The authored relations of an entity a tenant lookup may follow or a rollup
 * aggregate: a single reference the entity holds (`belongsTo`, its foreign key
 * on the entity's table) and an inverse collection (`hasMany`, the foreign key
 * on the related table), each to a stored, tenant-scoped entity with a uuid
 * id. Through-, via- and provider-backed relations have no foreign key to
 * follow and stay out. Of an extensible entity's collection the single
 * relations count too: `rollup.of` may follow one.
 */
function extensionRelations(
  owner: { contract: CompiledEntityContract; table: TableDefinition },
  byEntity: ReadonlyMap<string, { contract: CompiledEntityContract; table: TableDefinition }>,
): ExtensionRegistryRelation[] {
  const relations: ExtensionRegistryRelation[] = [];
  for (const relationship of owner.contract.model.relationships) {
    if (relationship.through || relationship.provider || relationship.via || !relationship.foreignKey) continue;
    const related = byEntity.get(relationship.target);
    if (!related || !related.table.tenantScoped || related.contract.source || related.contract.subtype) continue;
    const id = related.table.columns.find((column) => column.name === "id");
    if (!id || id.type !== "uuid" || !id.primaryKey) continue;
    const holder = relationship.kind === "belongsTo" ? owner.table : related.table;
    const foreignKey = holder.columns.find((column) => column.name === relationship.foreignKey);
    if (!foreignKey || foreignKey.type !== "uuid") continue;
    relations.push({
      key: relationship.kind === "belongsTo" ? relationship.fieldKey ?? relationship.key : relationship.key,
      kind: relationship.kind,
      entity: relationship.target,
      table: qualified(related.table),
      foreignKey: relationship.foreignKey,
      ...(relationship.ownership ? { ownership: relationship.ownership } : {}),
      ...(relationship.childAuthorization ? { childAuthorization: relationship.childAuthorization } : {}),
    });
  }
  return relations.sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Who may read an entity, from its compiled authorization contract: the read
 * roles, the principal classes, the axis that narrows its rows (if any) and
 * the fields with read roles of their own. A lookup or rollup is proven
 * against exactly this; anything that narrows rows is named, never folded
 * into the roles, so the runtime refuses it rather than guess.
 */
function readAccessOf(entry: { contract: CompiledEntityContract; table: TableDefinition }): ExtensionReadAccess {
  const authorization = entry.contract.authorization;
  const rowPolicy = entry.table.rowScope ? "rowScope"
    : entry.table.ownerAxis || authorization?.ownerAxis ? "ownerAxis"
    : entry.table.source?.authorization?.recordPermissions || authorization?.rowAccess?.recordPermissions ? "recordPermissions"
    // Plain `rowAccess: { enabled: true }` narrows nothing; only an owner or group axis does.
    : authorization?.rowAccess?.owner || authorization?.rowAccess?.group ? "rowAccess"
    : Object.keys(authorization?.profileAuthorizations ?? {}).length ? "profileAuthorizations"
    : undefined;
  const fieldReadRoles = Object.fromEntries((authorization?.fieldAuthorizations ?? [])
    .map((field) => [field.fieldKey, [...new Set(field.readRoles)].sort()] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
  return {
    table: qualified(entry.table),
    roles: [...new Set(authorization?.roles.read ?? [])].sort(),
    ...(authorization?.principalClasses ? { principalClasses: [...new Set(authorization.principalClasses)].sort() } : {}),
    ...(rowPolicy ? { rowPolicy } : {}),
    ...(Object.keys(fieldReadRoles).length ? { fieldReadRoles } : {}),
  };
}

/**
 * Lower every extensible entity into its storage and return the registry the
 * manifest publishes, or undefined when no entity is extensible (the manifest
 * then stays byte-identical to one compiled before extensible existed).
 */
export function compileExtensionStorage(
  entries: ReadonlyArray<{ contract: CompiledEntityContract; table: TableDefinition }>,
  tables: TableDefinition[],
): ExtensionRegistry | undefined {
  const extensible = entries.filter((entry) => entry.contract.extensible);
  if (extensible.length === 0) return undefined;
  const byEntity = new Map(entries.map((entry) => [entry.contract.entity.name, entry]));
  // Owned children by entity name: their owner's snapshot freezes their rows.
  const ownedBy = new Map<string, string>();
  for (const { contract } of entries) {
    for (const relationship of contract.model.relationships) {
      if (relationship.kind === "hasMany" && relationship.ownership === "owned") ownedBy.set(relationship.target, contract.entity.name);
    }
  }
  const candidates = entries.filter((entry) => isExtensionTargetCandidate(entry.contract, entry.table));
  const registry: ExtensionRegistry = { entities: {}, indexProjections: {}, referencedBy: {}, childRelations: {}, readAccess: {} };
  const reachable = new Set<string>();

  for (const { contract, table } of [...extensible].sort((left, right) => left.contract.entity.name.localeCompare(right.contract.entity.name))) {
    const name = contract.entity.name;
    const resolved = contract.extensible!;
    if (!table.tenantScoped || !table.columns.some((column) => column.name === "tenant_id" && column.type === "uuid" && column.required)) {
      fail(name, "requires a tenant-scoped table with a non-null uuid tenant_id.");
    }
    const id = table.columns.find((column) => column.name === "id");
    if (!id || id.type !== "uuid" || !id.primaryKey) fail(name, "requires a uuid id primary key on its table.");
    // compileExtensible refused these on the authored entity; the lowered
    // table is checked again because it is what the policy is emitted from.
    if (table.rowScope || table.ownerAxis || table.source?.authorization?.recordPermissions) {
      fail(name, "is not available on a table with a row scope, owner axis or record ACL.");
    }
    if (table.columns.some((column) => column.name === EXTENSION_VALUES_COLUMN)) {
      fail(name, `reserves the column ${EXTENSION_VALUES_COLUMN}; it is already present on ${qualified(table)}.`);
    }
    const owner = ownedBy.get(name);
    if (owner) {
      fail(name, `is not available on an owned child (owned by ${owner}): the published snapshot of ${owner} would freeze its raw tenant values.`);
    }
    table.columns.push({ name: EXTENSION_VALUES_COLUMN, type: "jsonb", required: true, default: "'{}'::jsonb" });
    ensureTenantRecordKey(table);
    const values = valuesTable(name, table);
    const unique = uniqueValuesTable(name, table);
    for (const side of [values, unique]) {
      if (tables.some((existing) => existing.schema === side.schema && existing.name === side.name)) {
        fail(name, `needs table ${qualified(side)}, which another entity already declares.`);
      }
      tables.push(side);
    }

    const excludedTargets = new Set(resolved.excludedTargets);
    for (const target of excludedTargets) {
      if (!byEntity.has(target)) fail(name, `excludedTargets names ${target}, which is not an entity of this manifest.`);
    }
    const targets = candidates
      .filter((candidate) => !excludedTargets.has(candidate.contract.entity.name))
      .map((candidate) => ({ entity: candidate.contract.entity.name, table: qualified(candidate.table) }))
      .sort((left, right) => left.entity.localeCompare(right.entity));
    registry.entities[name] = {
      table: qualified(table),
      valuesTable: qualified(values),
      uniqueTable: qualified(unique),
      manageRoles: [...resolved.manageRoles],
      limits: { ...resolved.limits },
      allowedOsfTypes: [...resolved.allowedOsfTypes],
      targets,
      ownedSingleChildren: ownedSingleChildren({ contract, table }, byEntity),
      relations: extensionRelations({ contract, table }, byEntity),
    };
    for (const reached of [name, ...targets.map((target) => target.entity), ...registry.entities[name]!.relations.map((relation) => relation.entity)]) {
      reachable.add(reached);
    }
    for (const [type, projection] of Object.entries(resolved.indexProjections)) {
      const previous = registry.indexProjections[type];
      if (previous && JSON.stringify(previous) !== JSON.stringify(projection)) {
        throw new Error(`osfType ${type} resolves to two different index projections.`);
      }
      registry.indexProjections[type] = { ...projection };
    }
    for (const target of targets) {
      (registry.referencedBy[target.entity] ??= []).push({ sourceEntity: name, valuesTable: qualified(values) });
    }
  }
  // A collection's child that is not extensible itself has its single
  // relations here: `rollup.of` may follow one, so what it leads to is in reach.
  for (const child of [...new Set(Object.values(registry.entities).flatMap((entry) =>
    entry.relations.filter((relation) => relation.kind === "hasMany").map((relation) => relation.entity)))].sort()) {
    if (registry.entities[child]) continue;
    const relations = extensionRelations(byEntity.get(child)!, byEntity).filter((relation) => relation.kind === "belongsTo");
    if (!relations.length) continue;
    registry.childRelations[child] = relations;
    for (const relation of relations) reachable.add(relation.entity);
  }
  registry.readAccess = Object.fromEntries([...reachable].sort().map((entity) => [entity, readAccessOf(byEntity.get(entity)!)]));
  registry.indexProjections = Object.fromEntries(Object.entries(registry.indexProjections).sort(([left], [right]) => left.localeCompare(right)));
  registry.referencedBy = Object.fromEntries(Object.entries(registry.referencedBy)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([target, sources]) => [target, sources.sort((left, right) => left.sourceEntity.localeCompare(right.sourceEntity))]));
  return registry;
}
