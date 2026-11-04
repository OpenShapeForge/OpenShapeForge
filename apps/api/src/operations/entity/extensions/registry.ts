// SPDX-License-Identifier: BUSL-1.1
/**
 * The manifest's `extensionRegistry`: which entities are
 * `extensible`, where their tenant field values live, who may design them and
 * which types and reference targets a tenant may choose. Read once from the
 * compiled manifest and validated by hand, like `entityValues`
 * (modules/entity-value-registry.ts): a malformed registry stops the process
 * rather than widening what a tenant may define.
 */
import { readFileSync } from "node:fs";
import type {
  RuntimeExtensibleEntity,
  RuntimeExtensionIndexColumn,
  RuntimeExtensionReadAccess,
  RuntimeExtensionRegistry,
  RuntimeExtensionRegistryManifest,
  RuntimeExtensionRelation,
} from "@openshapeforge/plugin-runtime";

const qualified = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const entityName = /^[A-Z][A-Za-z0-9]*$/;
const osfTypeName = /^[A-Za-z][A-Za-z0-9]*$/;
const fieldKey = /^[a-z][A-Za-z0-9]*$/;
const columnName = /^[a-z_][a-z0-9_]*$/;
const ROW_POLICIES = ["rowScope", "ownerAxis", "recordPermissions", "rowAccess", "profileAuthorizations"];
const INDEX_COLUMNS: readonly RuntimeExtensionIndexColumn[] = ["text", "number", "boolean", "date", "timestamp"];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
const strings = (value: unknown, pattern: RegExp): value is string[] =>
  Array.isArray(value) && value.every((item) => matches(item, pattern)) && new Set(value).size === value.length;
const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const invalid = (detail: string): never => { throw new Error(`The generated extension registry is invalid: ${detail}.`); };

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function entityEntry(name: string, value: unknown): RuntimeExtensibleEntity {
  if (!record(value)) invalid(`${name} is not an object`);
  const entry = value as Record<string, unknown>;
  for (const key of ["table", "valuesTable", "uniqueTable"]) {
    if (!matches(entry[key], qualified)) invalid(`${name}.${key} is not a qualified table`);
  }
  const [schema, table] = (entry.table as string).split(".");
  if (entry.valuesTable !== `${schema}.${table}_field_values` || entry.uniqueTable !== `${schema}.${table}_field_unique_values`) {
    invalid(`${name} side tables do not follow the entity table`);
  }
  if (!Array.isArray(entry.manageRoles) || entry.manageRoles.length === 0 ||
      !entry.manageRoles.every((role) => typeof role === "string" && role.length > 0)) invalid(`${name}.manageRoles is empty`);
  if (!(entry.manageRoles as string[]).includes("Organization.All.ReadWrite")) invalid(`${name}.manageRoles lacks Organization.All.ReadWrite`);
  const limits = entry.limits;
  if (!record(limits) || !["fields", "filtersPerQuery", "formulaDepth", "syncFanOut"].every((key) => positive(limits[key]))) {
    invalid(`${name}.limits is incomplete`);
  }
  if (!strings(entry.allowedOsfTypes, osfTypeName)) invalid(`${name}.allowedOsfTypes is invalid`);
  if (!Array.isArray(entry.targets) || !entry.targets.every((target) =>
    record(target) && matches(target.entity, entityName) && matches(target.table, qualified))) invalid(`${name}.targets is invalid`);
  if (!Array.isArray(entry.ownedSingleChildren) || !entry.ownedSingleChildren.every((child) =>
    record(child) && matches(child.relation, fieldKey) && matches(child.entity, entityName) &&
    matches(child.table, qualified) && matches(child.foreignKey, columnName))) invalid(`${name}.ownedSingleChildren is invalid`);
  if (!Array.isArray(entry.relations) || !entry.relations.every((relation) =>
    record(relation) && matches(relation.key, fieldKey) && (relation.kind === "belongsTo" || relation.kind === "hasMany") &&
    matches(relation.entity, entityName) && matches(relation.table, qualified) && matches(relation.foreignKey, columnName) &&
    (relation.ownership === undefined || relation.ownership === "owned" || relation.ownership === "reference") &&
    (relation.childAuthorization === undefined || relation.childAuthorization === "owner")) ||
    new Set(entry.relations.map((relation) => (relation as Record<string, unknown>).key)).size !== entry.relations.length) {
    invalid(`${name}.relations is invalid`);
  }
  return structuredClone(entry) as unknown as RuntimeExtensibleEntity;
}

const singleRelation = (relation: unknown): boolean => record(relation) && matches(relation.key, fieldKey) && relation.kind === "belongsTo" &&
  matches(relation.entity, entityName) && matches(relation.table, qualified) && matches(relation.foreignKey, columnName);

function readAccessEntry(name: string, value: unknown): RuntimeExtensionReadAccess {
  if (!record(value) || !matches(value.table, qualified) || !strings(value.roles, /^\S+$/) ||
      (value.principalClasses !== undefined && !strings(value.principalClasses, /^[a-z]+$/)) ||
      (value.rowPolicy !== undefined && !ROW_POLICIES.includes(String(value.rowPolicy))) ||
      (value.fieldReadRoles !== undefined && (!record(value.fieldReadRoles) ||
        !Object.entries(value.fieldReadRoles).every(([field, roles]) => fieldKey.test(field) && strings(roles, /^\S+$/))))) {
    invalid(`readAccess.${name} is invalid`);
  }
  return structuredClone(value) as unknown as RuntimeExtensionReadAccess;
}

/** Accepts generated metadata only, never tenant-authored definitions. */
export function createExtensionRegistry(value: unknown): RuntimeExtensionRegistry {
  if (value === undefined) value = { entities: {}, indexProjections: {}, referencedBy: {}, childRelations: {}, readAccess: {} };
  if (!record(value) || !record(value.entities) || !record(value.indexProjections) || !record(value.referencedBy) ||
      !record(value.childRelations) || !record(value.readAccess)) {
    invalid("entities, indexProjections, referencedBy, childRelations and readAccess are required");
  }
  const source = value as unknown as RuntimeExtensionRegistryManifest;
  const entities = new Map<string, RuntimeExtensibleEntity>();
  for (const [name, entry] of Object.entries(source.entities)) {
    if (!entityName.test(name)) invalid(`${name} is not an entity name`);
    entities.set(name, freeze(entityEntry(name, entry)));
  }
  const projections = new Map<string, Partial<Record<RuntimeExtensionIndexColumn, string>>>();
  for (const [type, projection] of Object.entries(source.indexProjections)) {
    if (!osfTypeName.test(type) || !record(projection) || Object.keys(projection).length === 0 ||
        !Object.entries(projection).every(([column, component]) =>
          INDEX_COLUMNS.includes(column as RuntimeExtensionIndexColumn) && matches(component, fieldKey))) {
      invalid(`indexProjections.${type} is invalid`);
    }
    projections.set(type, freeze({ ...projection }));
  }
  const referencedBy = new Map<string, readonly { sourceEntity: string; valuesTable: string }[]>();
  for (const [target, sources] of Object.entries(source.referencedBy)) {
    if (!entityName.test(target) || !Array.isArray(sources) || !sources.every((item) =>
      record(item) && matches(item.sourceEntity, entityName) && entities.has(item.sourceEntity) &&
      item.valuesTable === entities.get(item.sourceEntity)!.valuesTable)) invalid(`referencedBy.${target} is invalid`);
    referencedBy.set(target, freeze(sources.map((item) => ({ sourceEntity: item.sourceEntity, valuesTable: item.valuesTable }))));
  }
  const childRelations = new Map<string, readonly RuntimeExtensionRelation[]>();
  for (const [child, relations] of Object.entries(source.childRelations)) {
    if (!entityName.test(child) || !Array.isArray(relations) || !relations.every(singleRelation)) invalid(`childRelations.${child} is invalid`);
    childRelations.set(child, freeze(structuredClone(relations)));
  }
  const readAccess = new Map<string, RuntimeExtensionReadAccess>();
  for (const [entity, access] of Object.entries(source.readAccess)) {
    if (!entityName.test(entity)) invalid(`readAccess.${entity} is not an entity name`);
    readAccess.set(entity, freeze(readAccessEntry(entity, access)));
  }
  // Every entity a lookup or rollup can reach is in readAccess: a missing one
  // would be unprovable, and the registry says so here rather than per request.
  for (const [name, entry] of entities) {
    for (const reached of [name, ...entry.targets.map((target) => target.entity), ...entry.relations.map((relation) => relation.entity)]) {
      if (!readAccess.has(reached)) invalid(`readAccess lacks ${reached}, which ${name} can reach`);
    }
  }
  for (const [child, relations] of childRelations) {
    for (const relation of relations) {
      if (!readAccess.has(relation.entity)) invalid(`readAccess lacks ${relation.entity}, which ${child} can reach`);
    }
  }
  return Object.freeze({
    entity: (name: string) => entities.get(name),
    entityNames: () => [...entities.keys()].sort(),
    indexProjection: (type: string) => projections.get(type),
    referencedBy: (name: string) => referencedBy.get(name) ?? [],
    childRelations: (name: string) => childRelations.get(name) ?? [],
    readAccess: (name: string) => readAccess.get(name),
  });
}

let generated: RuntimeExtensionRegistry | undefined;
let override: RuntimeExtensionRegistry | undefined;

function readGenerated(): RuntimeExtensionRegistry {
  if (!generated) {
    const manifest = JSON.parse(readFileSync(new URL("../../../generated/db/manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
    generated = createExtensionRegistry(manifest.extensionRegistry);
  }
  return generated;
}

function active(): RuntimeExtensionRegistry {
  return override ?? readGenerated();
}

/** The process-wide registry every extension path reads. */
export const extensionRegistry: RuntimeExtensionRegistry = Object.freeze({
  entity: (name: string) => active().entity(name),
  entityNames: () => active().entityNames(),
  indexProjection: (type: string) => active().indexProjection(type),
  referencedBy: (name: string) => active().referencedBy(name),
  childRelations: (name: string) => active().childRelations(name),
  readAccess: (name: string) => active().readAccess(name),
});

/**
 * Replace the registry for the duration of a test; the returned function
 * restores the generated one. A manifest entry, not a shortcut past one:
 * every path downstream reads it exactly as it reads the compiled registry.
 */
export function __setExtensionRegistryForTests(value: RuntimeExtensionRegistryManifest): () => void {
  const previous = override;
  override = createExtensionRegistry(value);
  return () => { override = previous; };
}
