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
 * and cascade with it. They carry the entity's own tenant policy, which is the
 * entity's whole row policy only because an extensible entity may not declare
 * a row-scope axis, owner axis or record ACL: the side tables have none of the
 * columns such a policy reads. Every change here is additive, so a built
 * database rolls forward without a versioned migration.
 */
import { BASE_TYPES } from "./entity-fields.js";
import type { ExtensionRegistry, ExtensionRegistryEntity } from "./extension-registry-types.js";
import type { CoreEntity, ExtensionIndexColumn, OsfTypeDefinition, OsfTypeIndexProjection } from "./types.js";
import type { CompiledEntityContract, CompiledExtensible } from "./types/compiled.js";
import { isGeneratedCrudEligible, type IndexDefinition, type ReferenceDefinition, type TableDefinition } from "../schema.js";

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
 * NULL. Renaming or reshaping an entry is not additive: an index under an
 * existing name needs a versioned migration.
 */
export const EXTENSION_VALUE_INDEXES: ReadonlyArray<{ suffix: string; columns: readonly string[]; where: string }> = [
  ...Object.values(EXTENSION_INDEX_COLUMNS).map(({ column }) => ({
    suffix: column,
    columns: ["tenant_id", "field_id", column],
    where: `${column} IS NOT NULL`,
  })),
  { suffix: "value_ref_id", columns: ["tenant_id", "value_ref_id"], where: "value_ref_id IS NOT NULL" },
];

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
  const scopeReason = "the tenant-field tables carry only the tenant policy, so they would show values of rows the entity hides";
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
 * Whether a tenant reference field may point at this entity at all: a stored,
 * tenant-scoped record a reader can resolve through its own `get`, outside
 * the platform schema. A host narrows the set per entity with
 * `excludedTargets`.
 */
export function isExtensionTargetCandidate(
  contract: CompiledEntityContract,
  table?: Pick<TableDefinition, "schema" | "tenantScoped" | "domainInternal" | "generatedCrudEligible">,
): boolean {
  if (!contract.authorization || contract.source || contract.subtype || contract.entity.valueDefinition) return false;
  if (!contract.entityOperations.get) return false;
  if (!table) return true;
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

function valuesTable(entity: string, table: TableDefinition): TableDefinition {
  const name = sideTableName(entity, table, "field_values");
  const indexes: IndexDefinition[] = EXTENSION_VALUE_INDEXES.map((index) => ({
    name: `${name}_${index.suffix}_idx`,
    columns: [...index.columns],
    where: index.where,
  }));
  return {
    schema: table.schema,
    name,
    tenantScoped: true,
    domainInternal: true,
    generatedCrudEligible: false,
    ...workerSurface(table),
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
 */
function ownedSingleChildren(
  contract: CompiledEntityContract,
  byEntity: ReadonlyMap<string, { contract: CompiledEntityContract; table: TableDefinition }>,
): ExtensionRegistryEntity["ownedSingleChildren"] {
  const children: ExtensionRegistryEntity["ownedSingleChildren"] = [];
  for (const relationship of contract.model.relationships) {
    if (relationship.kind !== "hasMany" || relationship.ownership !== "owned") continue;
    if (relationship.through || relationship.provider || relationship.via || !relationship.foreignKey) continue;
    const child = byEntity.get(relationship.target);
    if (!child) continue;
    const foreignKey = relationship.foreignKey;
    const keyed = (child.table.indexes ?? []).some((index) => index.unique && !index.where &&
      [`tenant_id,${foreignKey}`, foreignKey].includes(index.columns.join(",")));
    const bounded = typeof relationship.cardinality === "object" && relationship.cardinality.max === 1;
    if (!keyed && !bounded) continue;
    children.push({ relation: relationship.key, entity: relationship.target, table: qualified(child.table), foreignKey });
  }
  return children.sort((left, right) => left.relation.localeCompare(right.relation));
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
  const candidates = entries.filter((entry) => isExtensionTargetCandidate(entry.contract, entry.table));
  const registry: ExtensionRegistry = { entities: {}, indexProjections: {}, referencedBy: {} };

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
      ownedSingleChildren: ownedSingleChildren(contract, byEntity),
    };
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
  registry.indexProjections = Object.fromEntries(Object.entries(registry.indexProjections).sort(([left], [right]) => left.localeCompare(right)));
  registry.referencedBy = Object.fromEntries(Object.entries(registry.referencedBy)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([target, sources]) => [target, sources.sort((left, right) => left.sourceEntity.localeCompare(right.sourceEntity))]));
  return registry;
}
