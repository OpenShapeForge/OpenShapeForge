// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { compiledObjectSchema } from "../field-json-schema.js";
import type { ColumnDefinition, TableDefinition } from "../schema.js";
import type { EntityValueCandidate, EntityValueRegistry } from "./entity-value-types.js";
import type { CompiledField } from "./types/compiled.js";
import type { FieldDefinition } from "./types/field-definition.js";
import { assertEntityValueFieldPolicies } from "./entity-fields.js";

const snake = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const serializable = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function canonicalField(field: CompiledField): FieldDefinition {
  const { cardinalityBounds, children, item, ...rest } = field;
  return serializable({ ...rest,
    cardinality: cardinalityBounds ?? field.cardinality,
    ...(children ? { children: children.map(canonicalField) } : {}),
    ...(item ? { item: canonicalField(item) } : {}),
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
}

/** Stable bounded identifiers, including a digest to distinguish long or acronym-heavy names. */
export function entityValueStorageName(...parts: string[]): string {
  const readable = parts.map(snake).join("_");
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
  return `${readable.slice(0, 49)}_${digest}`;
}

export function entityValueDefinitionNames(candidates: readonly EntityValueCandidate[]): Set<string> {
  return new Set(candidates.flatMap((candidate) => candidate.effectiveFields.flatMap((field) => field.allowedDefinitions ?? [])));
}

/** Pure definitions still have normal plugin Operations, but never standalone entity CRUD. */
export function assertEntityValueDefinition(candidate: EntityValueCandidate): void {
  const contract = candidate.contract;
  if (!contract.entity.valueDefinition) throw new Error(`${contract.entity.name}: an entityValue definition must declare baseEntity:false without an id.`);
  if (Object.values(contract.entityOperations).length > 0) throw new Error(`${contract.entity.name}: identity-less definitions cannot expose standalone entity CRUD.`);
  const inspect = (field: CompiledField, parent: string) => {
    const path = `${parent}.${field.key}`;
    assertEntityValueFieldPolicies(field, path);
    for (const child of field.children ?? []) inspect(child, path);
    if (field.item) inspect(field.item, path);
  };
  for (const field of candidate.effectiveFields) inspect(field, contract.entity.name);
  for (const operation of contract.pluginOperations ?? []) {
    if (operation.definition.target?.scope === "record") throw new Error(`${contract.entity.name}.${operation.key}: identity-less definitions cannot use a record target.`);
  }
  const materialize = contract.pluginOperations?.find((operation) => operation.key === "materialize");
  if (materialize && (materialize.definition.effects.data !== "read" || materialize.definition.effects.external !== "none")) {
    throw new Error(`${contract.entity.name}.materialize must have read-only data effects and no external effects.`);
  }
}

export type EntityValueReferenceAttacher = (source: TableDefinition, column: ColumnDefinition, target: TableDefinition) => void;

/** Lower resolved entity fields through the same FK/index planner as ordinary relationships. */
export function compileEntityValueStorage(
  candidates: readonly EntityValueCandidate[],
  tables: TableDefinition[],
  attachReference: EntityValueReferenceAttacher,
): EntityValueRegistry | undefined {
  const registry: EntityValueRegistry = { version: 1, carriers: [], collections: [] };
  const byEntity = new Map(candidates.map((candidate) => [candidate.contract.entity.name, candidate]));
  const tableFor = (name: string): TableDefinition => {
    const table = tables.find((table) => table.source?.authoringEntityName === name);
    if (!table) throw new Error(`Entity value storage requires an identity-bearing table for ${name}.`);
    return table;
  };
  const addCheck = (table: TableDefinition, tag: string[], expression: string) => {
    const name = entityValueStorageName(table.schema, table.name, ...tag, "check");
    const digest = createHash("sha256").update(expression).digest("hex").slice(0, 12);
    const constraints = table.constraints ??= [];
    if (constraints.some((constraint) => constraint.name === name)) throw new Error(`Entity value constraint collision: ${name}.`);
    constraints.push({
      compilerOwned: true,
      replaceExisting: true,
      version: `0001_entity-value-${name.replaceAll("_", "-")}-${digest}`,
      name,
      kind: "check",
      expression,
    });
  };
  const columnFor = (table: TableDefinition, key: string): ColumnDefinition => {
    const column = table.columns.find((column) => column.sourceField === key);
    if (!column) throw new Error(`${table.schema}.${table.name}: no persisted column for ${key}.`);
    return column;
  };
  const collections = candidates.flatMap((owner) => owner.effectiveFields.filter((field) => field.allowedDefinitions).map((field) => ({ owner, field })));
  const usedDefinitions = entityValueDefinitionNames(candidates);
  for (const name of usedDefinitions) {
    const candidate = byEntity.get(name);
    if (!candidate) throw new Error(`Allowed entity-value definition ${name} is absent from the compiled entity corpus.`);
    assertEntityValueDefinition(candidate);
  }

  for (const carrier of candidates) {
    const carrierFields = carrier.effectiveFields.filter((field) => field.entityValue);
    if (!carrierFields.length) continue;
    if (carrierFields.length !== 1) throw new Error(`${carrier.contract.entity.name}: multiple entityValue fields require an explicit collection-to-value binding and are not supported yet.`);
    const field = carrierFields[0]!;
    const table = tableFor(carrier.contract.entity.name);
    const owners = collections.filter(({ field: collection }) => collection.relationship?.target === carrier.contract.entity.name);
    if (!owners.length) throw new Error(`${carrier.contract.entity.name}.${field.key}: entityValue requires an owning collection with allowedDefinitions.`);
    for (const candidate of candidates) {
      for (const collection of candidate.effectiveFields) {
        if (collection.cardinality === "collection" && collection.relationship?.target === carrier.contract.entity.name && !collection.allowedDefinitions) {
          throw new Error(`${candidate.contract.entity.name}.${collection.key}: collections of an entityValue carrier require allowedDefinitions.`);
        }
      }
    }
    const definitionNames = [...new Set(owners.flatMap(({ field }) => field.allowedDefinitions!))].sort();
    const valuesColumn = columnFor(table, field.key);
    const discriminator = columnFor(table, field.entityValue!.definitionField);
    if (valuesColumn.type !== "jsonb" || discriminator.type !== "text" || !discriminator.required) throw new Error(`${carrier.contract.entity.name}: entityValue needs JSONB values and a required text discriminator.`);
    const descriptor: EntityValueRegistry["carriers"][number] = {
      entityName: carrier.contract.entity.name, fieldKey: field.key,
      definitionField: field.entityValue!.definitionField,
      schema: table.schema, table: table.name,
      valuesColumn: valuesColumn.name, definitionColumn: discriminator.name,
      definitions: {},
    };
    addCheck(table, [field.key, "discriminator"], `${ident(discriminator.name)} IN (${definitionNames.map(literal).join(", ")})`);
    addCheck(table, [field.key, "object"], `${ident(valuesColumn.name)} IS NOT NULL AND jsonb_typeof(${ident(valuesColumn.name)}) = 'object'`);

    for (const name of definitionNames) {
      const definition = byEntity.get(name)!;
      const fields = definition.effectiveFields;
      if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new Error(`${name}: duplicate effective value fields across core and profiles.`);
      if (fields.some((field) => field.entityValue || field.allowedDefinitions)) throw new Error(`${name}: nested entityValue definitions are not supported.`);
      const references = fields.filter((field) => field.relationship?.target);
      const values = fields.filter((field) => !field.relationship?.target);
      const materialize = definition.contract.pluginOperations?.find((operation) => operation.key === "materialize");
      const entry = descriptor.definitions[name] = {
        entityName: name, schemaVersion: 1, definitionHash: "",
        fields: fields.map(canonicalField),
        valueSchema: compiledObjectSchema(values, {}, { requireRequired: true, includeDefault: true }),
        references: [],
        ...(materialize ? { materializeOperationId: materialize.id } : {}),
      } as EntityValueRegistry["carriers"][number]["definitions"][string];
      const allowedKeys = values.length ? `ARRAY[${values.map((value) => literal(value.key)).join(", ")}]::text[]` : "ARRAY[]::text[]";
      addCheck(table, [field.key, name, "values"], `${ident(discriminator.name)} <> ${literal(name)} OR (${ident(valuesColumn.name)} - ${allowedKeys}) = '{}'::jsonb`);
      for (const reference of references) {
        if (reference.cardinality === "collection" || reference.relationship!.kind !== "belongsTo" || reference.relationship!.ownership === "owned" || reference.relationship!.inverse) {
          throw new Error(`${name}.${reference.key}: entityValue currently supports only single, non-owned, unidirectional references; collections require relational lowering, never JSON.`);
        }
        const targetName = reference.relationship!.target!;
        const target = tableFor(targetName);
        const columnName = entityValueStorageName("ev", field.key, name, reference.key, "id");
        if (table.columns.some((column) => column.name === columnName)) throw new Error(`Entity value reference column collision: ${columnName}.`);
        const column: ColumnDefinition = {
          name: columnName, type: "uuid",
          ...(["pii", "bsn", "confidential"].includes(reference.classification?.sensitivity ?? "") ? { classification: reference.classification!.sensitivity as NonNullable<ColumnDefinition["classification"]> } : {}),
        };
        table.columns.push(column);
        attachReference(table, column, target);
        addCheck(table, [field.key, name, reference.key], reference.required
          ? `CASE WHEN ${ident(discriminator.name)} = ${literal(name)} THEN ${ident(columnName)} IS NOT NULL ELSE ${ident(columnName)} IS NULL END`
          : `${ident(discriminator.name)} = ${literal(name)} OR ${ident(columnName)} IS NULL`);
        entry.references.push({ fieldKey: reference.key, targetEntity: targetName, schema: target.schema, table: target.name, column: columnName, required: reference.required, cardinality: "single" });
      }
      entry.definitionHash = createHash("sha256").update(stableJson({
        ...entry, definitionHash: undefined,
        operations: definition.contract.pluginOperations,
        storage: { schema: table.schema, table: table.name, valuesColumn: valuesColumn.name, definitionColumn: discriminator.name },
      })).digest("hex");
    }
    const ownerColumns = new Set<string>();
    for (const { owner, field: collection } of owners) {
      const relation = owner.contract.model.relationships.find((relation) => relation.key === collection.key);
      if (!relation || relation.kind !== "hasMany" || relation.ownership !== "owned" || !relation.foreignKey) {
        throw new Error(`${owner.contract.entity.name}.${collection.key}: allowedDefinitions currently requires an owned inverse collection.`);
      }
      const foreignKey = table.columns.find((column) => column.name === relation.foreignKey);
      if (!foreignKey) throw new Error(`${owner.contract.entity.name}.${collection.key}: owning collection has no carrier FK.`);
      if (ownerColumns.has(foreignKey.name)) throw new Error(`${owner.contract.entity.name}.${collection.key}: owning collections cannot share an indistinguishable carrier FK.`);
      ownerColumns.add(foreignKey.name);
      addCheck(table, [field.key, owner.contract.entity.name, collection.key, "allowed"], `${ident(foreignKey.name)} IS NULL OR ${ident(discriminator.name)} IN (${collection.allowedDefinitions!.slice().sort().map(literal).join(", ")})`);
      registry.collections.push({ entityName: owner.contract.entity.name, fieldKey: collection.key, targetEntity: carrier.contract.entity.name, allowedDefinitions: [...collection.allowedDefinitions!].sort() });
    }
    // A placement cannot evade collection-specific restrictions by having no
    // owner, or be owned by multiple aggregate collections simultaneously.
    addCheck(table, [field.key, "owner"], `num_nonnulls(${[...ownerColumns].sort().map(ident).join(", ")}) = 1`);
    registry.carriers.push(descriptor);
  }
  for (const { owner, field } of collections) {
    if (!registry.collections.some((collection) => collection.entityName === owner.contract.entity.name && collection.fieldKey === field.key)) throw new Error(`${owner.contract.entity.name}.${field.key}: allowedDefinitions must target an entityValue carrier.`);
  }
  registry.carriers.sort((a, b) => a.entityName.localeCompare(b.entityName));
  registry.collections.sort((a, b) => `${a.entityName}.${a.fieldKey}`.localeCompare(`${b.entityName}.${b.fieldKey}`));
  return registry.carriers.length ? serializable(registry) : undefined;
}
