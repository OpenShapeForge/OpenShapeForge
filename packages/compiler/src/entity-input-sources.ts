// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityContract, CompiledField } from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import { compiledObjectSchema, splitBundledDefinitions } from "./field-json-schema.js";
import { entityRelationshipKeys, withEntityRelationshipKeys, writableEntityFields } from "./entity-operation-json-schema.js";

type ObjectSchema = Record<string, unknown>;
const KEY = "x-osf-entityInput";

/** Resolve selected canonical entity fields instead of repeating their rules. */
export function resolveEntityInputSources(
  input: ObjectSchema,
  contracts: readonly CompiledEntityContract[],
  referentiedata: CoreReferentiedataSnapshot,
): ObjectSchema {
  const definitions: ObjectSchema = { ...(input.$defs as ObjectSchema | undefined) };
  const targets = new Map(contracts.map(contract => [contract.entity.name, { label: contract.entity.title ?? contract.entity.name, labels: contract.entity.labels }]));
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const object = value as ObjectSchema;
    if ("x-osf-collection" in object) {
      const source = object["x-osf-collection"] as { entity?: unknown; field?: unknown } | null;
      const items = object.items as ObjectSchema | undefined;
      const itemSource = items?.[KEY] as { entity?: unknown } | undefined;
      if (object.type !== "array" || !source || typeof source !== "object" || Array.isArray(source) ||
        Object.keys(source).some(key => !["entity", "field"].includes(key)) || typeof source.entity !== "string" ||
        typeof source.field !== "string" || !items || typeof items !== "object" || Array.isArray(items)) {
        throw new Error("Collection input requires an array, an owner and field, and canonical entity input items.");
      }
      const owners = contracts.filter(contract => contract.entity.name === source.entity);
      const relations = owners.length === 1 ? owners[0]!.model.relationships.filter(relation =>
        (relation.fieldKey ?? relation.key) === source.field && relation.kind === "hasMany" && relation.ownership === "owned") : [];
      if (relations.length !== 1 || (itemSource && relations[0]!.target !== itemSource.entity)) {
        throw new Error(`Collection input must name an owned collection with matching canonical items: ${source.entity}.${source.field}.`);
      }
      if (!itemSource) {
        const properties = items.properties;
        if (items.type !== "object" || !properties || typeof properties !== "object" || Array.isArray(properties)) {
          throw new Error("Collection input requires canonical entity input items.");
        }
        const canonical = visit({ [KEY]: { entity: relations[0]!.target, fields: Object.keys(properties) },
          ...(items.title !== undefined ? { title: items.title } : {}),
          ...(items.description !== undefined ? { description: items.description } : {}),
          ...(items["x-osf-i18n"] !== undefined ? { "x-osf-i18n": items["x-osf-i18n"] } : {}) });
        if (JSON.stringify(canonical) !== JSON.stringify(items)) throw new Error("Collection input items must match the canonical entity input.");
      }
    }
    if (!(KEY in object)) return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child)]));
    if (Object.keys(object).some(key => ![KEY, "title", "description", "x-osf-i18n"].includes(key))) {
      throw new Error("Entity input sources cannot override canonical field validation.");
    }
    const source = object[KEY] as { entity?: unknown; fields?: unknown } | null;
    if (!source || typeof source !== "object" || Array.isArray(source) ||
      Object.keys(source).some(key => !["entity", "fields"].includes(key)) ||
      typeof source.entity !== "string" || !Array.isArray(source.fields) ||
      !source.fields.length || source.fields.some(key => typeof key !== "string") ||
      new Set(source.fields).size !== source.fields.length) {
      throw new Error("Entity input sources require one entity and unique field keys.");
    }
    const matches = contracts.filter(contract => contract.entity.name === source.entity);
    if (matches.length !== 1) throw new Error(`Unknown or ambiguous entity input source ${source.entity}.`);
    const contract = matches[0]!;
    const selected = new Set(source.fields as string[]);
    const fields = writableEntityFields(contract.model.fields, "create").filter(field => selected.has(field.key));
    const relationships = entityRelationshipKeys(contract, targets).filter(field => selected.has(field.key))
      .map(field => ({ ...field, schema: { ...field.schema,
        title: targets.get(field.target)?.label ?? field.target,
        "x-osf-reference": { entity: field.target },
        ...(targets.get(field.target)?.labels ? { "x-osf-i18n": { title: targets.get(field.target)!.labels } } : {}),
      } }));
    const available = new Set([...fields.map(field => field.key), ...relationships.map(field => field.key)]);
    for (const key of selected) if (!available.has(key)) throw new Error(`Unavailable entity input field ${source.entity}.${key}.`);
    const projected = withEntityRelationshipKeys(compiledObjectSchema(fields, referentiedata, {
      requireRequired: true, defaultsAreMaterialized: true,
    }), relationships, true);
    const bundled = splitBundledDefinitions(projected);
    for (const [key, definition] of Object.entries(bundled.definitions)) {
      if (key in definitions && JSON.stringify(definitions[key]) !== JSON.stringify(definition)) {
        throw new Error(`Conflicting entity input schema definition ${key}.`);
      }
      definitions[key] = definition;
    }
    return { ...bundled.schema,
      ...(object["x-osf-i18n"] !== undefined ? { "x-osf-i18n": object["x-osf-i18n"] } : {}),
      ...(object.title !== undefined ? { title: object.title } : {}),
      ...(object.description !== undefined ? { description: object.description } : {}),
    };
  }
  const result = visit(input) as ObjectSchema;
  return { ...result, ...(Object.keys(definitions).length ? { $defs: definitions } : {}) };
}

/** Update every canonical projection before the interface generators run. */
export function materializeEntityInputSources(
  contracts: readonly CompiledEntityContract[],
  referentiedata: CoreReferentiedataSnapshot,
): void {
  const byName = new Map(contracts.map(contract => [contract.entity.name, contract]));
  for (const contract of contracts) for (const field of contract.model.fields) {
    if (!field.valueFieldsFrom) continue;
    const reference = contract.model.fields.find(item => item.key === field.valueFieldsFrom!.reference);
    const heads = contracts.filter(item => item.versioning?.versionEntity === reference?.relationship?.target);
    const source = heads.length === 1 ? heads[0]!.model.fields.find(item => item.key === field.valueFieldsFrom!.field) : undefined;
    const column = heads.length === 1 ? heads[0]!.storage.columns.find(item => item.field === field.valueFieldsFrom!.field) : undefined;
    if (field.baseType !== "object" || field.cardinality !== "single" || !reference?.relationship?.target || reference.cardinality !== "single" ||
      heads.length !== 1 || source?.osfType !== "fieldDefinition" || source.cardinality !== "collection" || !column || column.type !== "jsonb") {
      throw new Error(`${contract.entity.name}.${field.key}: valueFieldsFrom requires a version reference and stored FieldDefinition collection.`);
    }
    field.valueFieldsFrom = { ...field.valueFieldsFrom, snapshotColumn: column.column, headEntity: heads[0]!.entity.name };
  }
  function validateEntityOptions(fields: readonly CompiledField[]): void {
    for (const field of fields) {
      if (field.options?.type === "entity") {
        const target = byName.get(field.options.source ?? "");
        const valueField = field.options.valueField ?? "id";
        const targetField = target?.model.fields.find(candidate => candidate.key === valueField);
        const targetType = valueField === "id" ? "string" : targetField?.baseType;
        if (!target || !targetType || targetType !== field.baseType ||
          !["string", "integer", "number"].includes(targetType) || targetField?.cardinality === "collection") {
          throw new Error(`Invalid entity option source for ${field.key}: ${field.options.source}.${valueField}.`);
        }
      }
      if (field.children) validateEntityOptions(field.children);
      if (field.item) validateEntityOptions([field.item]);
    }
  }
  for (const contract of contracts) validateEntityOptions(contract.model.fields);
  for (const contract of contracts) {
    for (const operation of Object.values(contract.entityOperations)) {
      if (operation?.input.kind === "json-schema") operation.input.schema = resolveEntityInputSources(operation.input.schema, contracts, referentiedata);
      if (operation?.output.kind === "json-schema") operation.output.schema = resolveEntityInputSources(operation.output.schema, contracts, referentiedata);
    }
    for (const operation of contract.pluginOperations ?? []) {
      if (operation.definition.input) operation.definition.input.schema = resolveEntityInputSources(operation.definition.input.schema, contracts, referentiedata);
      if (operation.definition.output) operation.definition.output.schema = resolveEntityInputSources(operation.definition.output.schema, contracts, referentiedata);
    }
  }
}
