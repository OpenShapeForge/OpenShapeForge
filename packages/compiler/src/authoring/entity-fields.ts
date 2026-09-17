// SPDX-License-Identifier: BUSL-1.1
import type { CoreEntity, Field, SemanticTypeDefinition } from "./types.js";
import { deriveTableName, fieldCardinality } from "./compiler/helpers.js";

const snake = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const slug = (value: string) => snake(value).replaceAll("_", "-");

/** Embedded values need a policy adapter before any protected leaf may be used. */
export function assertEntityValueFieldPolicies(field: object, path: string, semantic?: object): void {
  for (const key of ["classification", "authorization", "permissions", "writtenBy", "secureInput", "immutable"]) {
    const authored = Reflect.get(field, key);
    const inherited = semantic ? Reflect.get(semantic, key) : undefined;
    if (key === "immutable" ? authored === true || inherited === true : authored !== undefined || inherited !== undefined) {
      throw new Error(`${path}: entityValue definition field policy ${key} requires a canonical embedded-field policy adapter; not supported yet.`);
    }
  }
}

/** Entity types are projections of the loaded entity corpus, never catalog copies. */
export function deriveEntitySemanticTypes(
  entities: readonly CoreEntity[],
  catalog: Record<string, SemanticTypeDefinition>,
): Record<string, SemanticTypeDefinition> {
  const result = { ...catalog };
  for (const entity of entities) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(entity.entity)) throw new Error(`Invalid entity semantic type name: ${entity.entity}.`);
    if (result[entity.entity]) throw new Error(`Semantic type ${entity.entity} duplicates a loaded entity.`);
    result[entity.entity] = {
      kind: "entity",
      entity: entity.entity,
      entityIdentity: entity.baseEntity !== false || entity.fields.some((field) => field.key === "id"),
      valueType: "string",
      validation: { format: "uuid" },
      label: entity.labels ?? { en: entity.title ?? entity.entity },
      shape: entity.fields,
      render: { input: "EntityReferenceSelect", display: "EntityReferenceDisplay" },
    };
    const identityKey = `${entity.entity[0]!.toLowerCase()}${entity.entity.slice(1)}Id`;
    if (result[entity.entity]!.entityIdentity === false) continue;
    const route = entity.interfaces?.web?.views?.collection?.route;
    // The identity alias is distinct from a relationship to that entity: an
    // entity's own primary key must never acquire a self-referencing FK.
    result[identityKey] ??= {
      kind: "entityId", entity: slug(entity.entity), valueType: "string",
      label: entity.labels ?? { en: entity.title ?? entity.entity },
      validation: { format: "uuid" },
      listUrl: (typeof route === "string" ? route : route?.en ?? route?.nl) ?? `/${deriveTableName(entity.entity).replaceAll("_", "-")}`,
      displayTemplate: entity.displayTemplate ?? "{{id}}",
      filterField: entity.filterField ?? "id",
      icon: "file",
      render: { input: "EntityReferenceSelect", display: "EntityReferenceDisplay" },
    };
  }
  return result;
}

/** Normalize once, before storage, Operations and interface projections diverge. */
export function normalizeEntityFields(
  entity: CoreEntity,
  catalog: Record<string, SemanticTypeDefinition>,
): CoreEntity {
  if (entity.schemaVersion === 3 && entity.relationships !== undefined) {
    throw new Error(`${entity.entity}: relationships belong on fields in schemaVersion 3.`);
  }
  const normalize = (field: Field, nested = false, ancestry: readonly string[] = []): Field => {
    const semantic = field.semanticType && Object.hasOwn(catalog, field.semanticType) ? catalog[field.semanticType] : undefined;
    if (entity.baseEntity === false && !entity.fields.some((field) => field.key === "id")) {
      assertEntityValueFieldPolicies(field, `${entity.entity}.${field.key}`, semantic);
    }
    if (entity.schemaVersion === 3 && field.semanticType && !semantic) {
      throw new Error(`${entity.entity}.${field.key}: unknown semanticType ${field.semanticType}.`);
    }
    // Inline identifier values (for example arguments in a stored template)
    // are not entity relationships. Preserve their scalar semantic type;
    // only an EntityName semantic type requests relational storage. A nested
    // value cannot claim its own persisted column or relationship metadata.
    if (entity.schemaVersion === 3 && nested && semantic?.kind === "entityId" && (field.persisted || field.relationship)) {
      throw new Error(`${entity.entity}.${field.key}: inline identifier values cannot declare relational storage.`);
    }
    if (entity.schemaVersion === 3 && !nested && semantic?.kind === "entityId" &&
      (field.key !== "id" || field.semanticType !== `${entity.entity[0]!.toLowerCase()}${entity.entity.slice(1)}Id`)) {
      throw new Error(`${entity.entity}.${field.key}: identity aliases identify primary keys; use the entity semanticType for a relationship.`);
    }
    const valueType = field.valueType ?? semantic?.valueType;
    if (!valueType) throw new Error(`${entity.entity}.${field.key}: valueType cannot be inferred from semanticType.`);
    if (entity.schemaVersion === 3 && semantic && field.valueType && field.valueType !== semantic.valueType) {
      throw new Error(`${entity.entity}.${field.key}: valueType conflicts with its semanticType ${field.semanticType}.`);
    }
    const result: Field = { ...field, valueType };
    if (semantic?.validation || field.validation) result.validation = { ...semantic?.validation, ...field.validation };
    const inlineShape = field.shape ?? field.children ?? (semantic?.kind !== "entity" ? semantic?.shape ?? semantic?.children : undefined);
    const item = field.item ?? semantic?.item;
    if (inlineShape || item) {
      if (field.semanticType && ancestry.includes(field.semanticType)) throw new Error(`${entity.entity}.${field.key}: cyclic inline semantic type ${field.semanticType}.`);
      const nextAncestry = field.semanticType ? [...ancestry, field.semanticType] : ancestry;
      if (inlineShape) result.children = inlineShape.map((child) => normalize(child, true, nextAncestry));
      if (field.shape && result.children) result.shape = result.children;
      if (item) result.item = normalize(item, true, nextAncestry);
    }
    const cardinality = field.cardinality ?? semantic?.cardinality;
    if (cardinality) result.cardinality = cardinality;
    if (typeof cardinality === "object") {
      const min = cardinality.min ?? 0;
      const max = cardinality.max ?? 1;
      if (!Number.isInteger(min) || min < 0 || (max !== "unbounded" && (!Number.isInteger(max) || max < min))) {
        throw new Error(`${entity.entity}.${field.key}: invalid cardinality bounds.`);
      }
      if (min > 0) result.required = true;
    }
    const collection = fieldCardinality(result) === "collection";
    if (field.entityValue || field.allowedDefinitions) {
      if (entity.schemaVersion !== 3 || nested) throw new Error(`${entity.entity}.${field.key}: entityValue and allowedDefinitions require a top-level schemaVersion 3 field.`);
    }
    if (field.entityValue) {
      if (field.semanticType !== "entityValue" || valueType !== "object" || collection || field.relationship || inlineShape || item) {
        throw new Error(`${entity.entity}.${field.key}: entityValue requires a single entityValue object without inline fields or a relationship.`);
      }
      const discriminator = entity.fields.find((candidate) => candidate.key === field.entityValue!.definitionField);
      const discriminatorSemantic = discriminator?.semanticType ? catalog[discriminator.semanticType] : undefined;
      const discriminatorType = discriminator?.valueType ?? discriminatorSemantic?.valueType;
      if (!discriminator || discriminator === field || discriminatorType !== "string" || !discriminator.required || !discriminator.persisted || fieldCardinality({ cardinality: discriminator.cardinality ?? discriminatorSemantic?.cardinality ?? "single" }) !== "single" || discriminator.relationship || ["entity", "entityId"].includes(discriminatorSemantic?.kind ?? "")) {
        throw new Error(`${entity.entity}.${field.key}: definitionField must name a required persisted scalar string field.`);
      }
      if (!field.persisted) throw new Error(`${entity.entity}.${field.key}: entityValue requires a persisted values column.`);
    } else if (field.semanticType === "entityValue") {
      throw new Error(`${entity.entity}.${field.key}: entityValue requires definitionField metadata.`);
    }
    if (field.allowedDefinitions) {
      if (!collection || semantic?.kind !== "entity" || !Array.isArray(field.allowedDefinitions) || !field.allowedDefinitions.length || new Set(field.allowedDefinitions).size !== field.allowedDefinitions.length) {
        throw new Error(`${entity.entity}.${field.key}: allowedDefinitions requires a nonempty unique definition list on an entity collection.`);
      }
      for (const definition of field.allowedDefinitions) {
        if (!Object.hasOwn(catalog, definition) || catalog[definition]?.kind !== "entity") throw new Error(`${entity.entity}.${field.key}: unknown allowed definition ${definition}.`);
      }
    }
    if (field.sortable && !collection) throw new Error(`${entity.entity}.${field.key}: sortable requires a collection.`);
    if (field.childAuthorization && (!collection || field.relationship?.ownership !== "owned")) throw new Error(`${entity.entity}.${field.key}: childAuthorization requires an owned collection.`);
    if (semantic?.kind !== "entity") {
      if (field.relationship) {
        throw new Error(`${entity.entity}.${field.key}: relationship requires a loaded entity semanticType.`);
      }
      return result;
    }
    if (entity.schemaVersion === 1) {
      throw new Error(`${entity.entity}.${field.key}: entity relationship fields require schemaVersion 2 or 3.`);
    }
    if (semantic.entityIdentity === false) throw new Error(`${entity.entity}.${field.key}: identity-less entity ${semantic.entity} is a value definition, not a relationship target.`);
    if (nested) throw new Error(`${entity.entity}.${field.key}: entity references must be relational fields, not IDs inside JSON values.`);
    const target = semantic.entity!;
    const metadata = field.relationship ?? {};
    if (!collection && metadata.ownership === "owned") {
      throw new Error(`${entity.entity}.${field.key}: single owned references require a single-storage ownership contract; use an owned inverse collection until supported.`);
    }
    const inverse = metadata.inverse;
    let inverseTarget = entity.entity;
    let through: { field: string; column: string; target: string } | undefined;
    if (metadata.via) {
      const via = entity.fields.find(candidate => candidate.key === metadata.via);
      const viaType = via?.semanticType ? catalog[via.semanticType] : undefined;
      if (!collection || !inverse || metadata.ownership === "owned" || field.sortable || field.persisted ||
        !via || via === field || viaType?.kind !== "entity" || viaType.entityIdentity === false ||
        fieldCardinality(via) !== "single" || via.relationship?.via) {
        throw new Error(`${entity.entity}.${field.key}: via requires a read-only inverse collection through a direct, single entity reference.`);
      }
      inverseTarget = viaType.entity!;
      through = { field: via.key, column: via.persisted?.column ?? `${snake(via.key)}_id`, target: inverseTarget };
      result.readOnly = true;
    }
    let foreignKey: string | undefined;
    let unique = false;
    if (inverse) {
      const inverseField = semantic.shape?.find((candidate) => candidate.key === inverse);
      if (!inverseField || inverseField.semanticType !== inverseTarget) {
        throw new Error(`${entity.entity}.${field.key}: inverse ${target}.${inverse} must refer to ${inverseTarget}.`);
      }
      const opposite = inverseField.relationship?.inverse;
      if (!through && opposite && opposite !== field.key) {
        throw new Error(`${entity.entity}.${field.key}: inverse ${target}.${inverse} points to ${opposite}.`);
      }
      if (collection) {
        if (fieldCardinality(inverseField) === "collection") {
          throw new Error(`${entity.entity}.${field.key}: bidirectional collections require an explicit association entity.`);
        }
        foreignKey = inverseField.persisted?.column ?? `${snake(inverse)}_id`;
      } else {
        unique = fieldCardinality(inverseField) === "single";
        if (unique) throw new Error(`${entity.entity}.${field.key}: bidirectional one-to-one fields require a single foreign-key owner; use an explicit association until supported.`);
      }
    }
    if (collection && field.persisted) {
      throw new Error(`${entity.entity}.${field.key}: entity collections use a relation, never a JSON column.`);
    }
    if (!collection) {
      foreignKey = field.persisted?.column ?? `${snake(field.key)}_id`;
      result.persisted = field.persisted ?? { column: foreignKey, storageClass: "core" };
      if (entity.authorization && result.persisted.column === "tenant_id") result.readOnly = true;
      result.validation = { ...semantic.validation, ...field.validation, format: "uuid" };
    }
    result.relationship = {
      kind: collection ? (inverse ? "hasMany" : "manyToMany") : "belongsTo",
      entity: slug(target),
      target,
      fieldKey: field.key,
      ownership: metadata.ownership ?? "reference",
      ...(inverse ? { inverse } : {}),
      ...(through ? { via: metadata.via!, through } : {}),
      ...(foreignKey ? { foreignKey } : {}),
      ...(unique ? { unique: true } : {}),
      ...(metadata.displayField ? { displayField: metadata.displayField } : {}),
      ...(metadata.constraints ? { constraints: structuredClone(metadata.constraints) } : {}),
    };
    return result;
  };
  return { ...entity, fields: entity.fields.map((field) => normalize(field)) };
}
