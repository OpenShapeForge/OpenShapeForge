// SPDX-License-Identifier: BUSL-1.1
import { readFileSync } from "node:fs";
import type { RuntimeEntityValueCarrier, RuntimeEntityValueRegistry } from "@openshapeforge/plugin-runtime";

const identifier = /^[a-z_][a-z0-9_]*$/;
const entityName = /^[A-Z][A-Za-z0-9]*$/;
const fieldKey = /^[a-z][A-Za-z0-9]*$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const matches = (value: unknown, pattern: RegExp): boolean => typeof value === "string" && pattern.test(value);
const invalid = (): never => { throw new Error("The generated entity-value registry is invalid."); };

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

/** Accepts generated metadata only, never tenant-authored field definitions. */
export function createEntityValueRegistry(value: unknown): RuntimeEntityValueRegistry {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.carriers)) invalid();
  const carriers = new Map<string, RuntimeEntityValueCarrier>();
  for (const item of (value as { carriers: unknown[] }).carriers) {
    if (!record(item) || !matches(item.entityName, entityName) || !matches(item.fieldKey, fieldKey) ||
        !matches(item.definitionField, fieldKey) || !record(item.definitions) ||
        ![item.schema, item.table, item.valuesColumn, item.definitionColumn].every((name) => matches(name, identifier))) invalid();
    const carrier = item as Record<string, unknown>;
    const columns = new Set([carrier.valuesColumn, carrier.definitionColumn, "id", "tenant_id", "created_at", "updated_at"]);
    for (const [name, definition] of Object.entries(carrier.definitions as Record<string, unknown>)) {
      if (!record(definition) || !entityName.test(name) || definition.entityName !== name ||
          definition.schemaVersion !== 1 || !matches(definition.definitionHash, /^[a-f0-9]{64}$/) ||
          !Array.isArray(definition.fields) || !definition.fields.every(record) ||
          !record(definition.valueSchema) || !Array.isArray(definition.references)) invalid();
      const keys = new Set<string>();
      for (const reference of (definition as Record<string, unknown>).references as unknown[]) {
        if (!record(reference) || !matches(reference.fieldKey, fieldKey) || !matches(reference.targetEntity, entityName) ||
            typeof reference.required !== "boolean" ||
            (reference.parameterColumn !== undefined && !matches(reference.parameterColumn, identifier)) ||
            ![reference.schema, reference.table, reference.column].every((name) => matches(name, identifier)) ||
            keys.has(reference.fieldKey as string)) invalid();
        keys.add((reference as Record<string, unknown>).fieldKey as string);
        for (const column of [(reference as Record<string, unknown>).column, (reference as Record<string, unknown>).parameterColumn].filter(value => value !== undefined)) {
          if (columns.has(column)) invalid();
          columns.add(column);
        }
      }
    }
    const key = `${carrier.entityName}.${carrier.fieldKey}`;
    if (carriers.has(key)) invalid();
    const cloned = structuredClone(carrier) as unknown as RuntimeEntityValueCarrier;
    freeze(cloned);
    carriers.set(key, cloned);
  }
  const collections = new Map<string, { targetEntity: string; allowedDefinitions: string[] }>();
  const sourceCollections = (value as Record<string, unknown>).collections;
  if (!Array.isArray(sourceCollections)) invalid();
  for (const item of sourceCollections as unknown[]) {
    if (!record(item) || !matches(item.entityName, entityName) || !matches(item.fieldKey, fieldKey) ||
        !matches(item.targetEntity, entityName) || !Array.isArray(item.allowedDefinitions) ||
        !item.allowedDefinitions.length || item.allowedDefinitions.some((name) => !matches(name, entityName))) invalid();
    const entry = item as { entityName: string; fieldKey: string; targetEntity: string; allowedDefinitions: string[] };
    const key = `${entry.entityName}.${entry.fieldKey}`;
    const targetCarriers = [...carriers.values()].filter((carrier) => carrier.entityName === entry.targetEntity);
    if (collections.has(key) || targetCarriers.length !== 1 || new Set(entry.allowedDefinitions).size !== entry.allowedDefinitions.length ||
        entry.allowedDefinitions.some((name) => !Object.hasOwn(targetCarriers[0]!.definitions, name))) invalid();
    const projected = { targetEntity: entry.targetEntity, allowedDefinitions: [...entry.allowedDefinitions] };
    freeze(projected);
    collections.set(key, projected);
  }
  return Object.freeze({
    get: (entity: string, field: string) => carriers.get(`${entity}.${field}`),
    collection: (entity: string, field: string) => collections.get(`${entity}.${field}`),
  });
}

let generated: RuntimeEntityValueRegistry | undefined;
function readGenerated(): RuntimeEntityValueRegistry {
  if (!generated) {
    const manifest = JSON.parse(readFileSync(new URL("../generated/db/manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
    generated = createEntityValueRegistry(manifest.entityValues ?? { version: 1, carriers: [], collections: [] });
  }
  return generated;
}
export const generatedEntityValues: RuntimeEntityValueRegistry = Object.freeze({
  get: (entity, field) => readGenerated().get(entity, field),
  collection: (entity, field) => readGenerated().collection(entity, field),
});
