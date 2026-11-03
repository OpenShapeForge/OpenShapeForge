// SPDX-License-Identifier: BUSL-1.1
/**
 * The manifest's `extensionRegistry` (contract fase 1a): which entities are
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
  RuntimeExtensionRegistry,
  RuntimeExtensionRegistryManifest,
} from "@openshapeforge/plugin-runtime";

const qualified = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const entityName = /^[A-Z][A-Za-z0-9]*$/;
const osfTypeName = /^[A-Za-z][A-Za-z0-9]*$/;
const fieldKey = /^[a-z][A-Za-z0-9]*$/;
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
    matches(child.table, qualified) && matches(child.foreignKey, /^[a-z_][a-z0-9_]*$/))) invalid(`${name}.ownedSingleChildren is invalid`);
  return structuredClone(entry) as unknown as RuntimeExtensibleEntity;
}

/** Accepts generated metadata only, never tenant-authored definitions. */
export function createExtensionRegistry(value: unknown): RuntimeExtensionRegistry {
  if (value === undefined) value = { entities: {}, indexProjections: {}, referencedBy: {} };
  if (!record(value) || !record(value.entities) || !record(value.indexProjections) || !record(value.referencedBy)) {
    invalid("entities, indexProjections and referencedBy are required");
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
  return Object.freeze({
    entity: (name: string) => entities.get(name),
    entityNames: () => [...entities.keys()].sort(),
    indexProjection: (type: string) => projections.get(type),
    referencedBy: (name: string) => referencedBy.get(name) ?? [],
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
