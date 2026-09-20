// SPDX-License-Identifier: BUSL-1.1
import type { CoreEntity, Field, OperationCatalogDefinition, OsfTypeDefinition } from "./types.js";
import type { FieldDefinitionValueType } from "./types/field-definition.js";
import { deriveTableName, fieldCardinality } from "./compiler/helpers.js";
import { cardinalityOf } from "@openshapeforge/operations";
import { type InverseCollectionSource, defaultInverseLabel, deriveInverseCollections, withInverseCollections } from "./inverse-collections.js";

const snake = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const slug = (value: string) => snake(value).replaceAll("_", "-");

/** The seven types every other osf type resolves to. */
export const BASE_TYPES: readonly FieldDefinitionValueType[] = ["string", "integer", "number", "boolean", "date", "datetime", "object"];

export function isBaseType(osfType: string | undefined): osfType is FieldDefinitionValueType {
  return (BASE_TYPES as readonly string[]).includes(osfType ?? "");
}

/** The catalog entry behind an osf type; base types have none. */
export function osfTypeDefinitionOf(
  osfType: string | undefined,
  catalog: Record<string, OsfTypeDefinition>,
): OsfTypeDefinition | undefined {
  return osfType && !isBaseType(osfType) && Object.hasOwn(catalog, osfType) ? catalog[osfType] : undefined;
}

export function resolveBaseType(
  osfType: string | undefined,
  catalog: Record<string, OsfTypeDefinition>,
): FieldDefinitionValueType | undefined {
  return isBaseType(osfType) ? osfType : osfTypeDefinitionOf(osfType, catalog)?.baseType;
}

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

function inverseSource(entity: Pick<CoreEntity, "entity" | "labels" | "pluralLabels" | "title" | "fields" | "baseEntity">): InverseCollectionSource {
  return {
    entity: entity.entity,
    labels: entity.labels,
    pluralLabels: entity.pluralLabels,
    title: entity.title,
    fields: entity.fields,
    valueDefinition: entity.baseEntity === false && !entity.fields.some((field) => field.key === "id"),
  };
}

/** Inverse collections are derived; an authored one is a modelling error, not a second way to say it. */
function assertNoAuthoredCollections(entity: Pick<CoreEntity, "entity" | "fields">, isEntityType: (osfType: string) => boolean): void {
  for (const field of entity.fields) {
    if (!isEntityType(field.osfType) || fieldCardinality(field) !== "collection" || field.relationship?.via) continue;
    throw new Error(
      `${entity.entity}.${field.key}: inverse collections are derived from the referencing field; ` +
      `declare relationship.inverse on the ${field.osfType} field that references ${entity.entity} (or via for a read-only traversal).`,
    );
  }
}

/** Entity types are projections of the loaded entity corpus, never catalog copies. */
export function deriveEntityOsfTypes(
  entities: readonly CoreEntity[],
  catalog: Record<string, OsfTypeDefinition>,
): Record<string, OsfTypeDefinition> {
  const result = { ...catalog };
  for (const key of Object.keys(catalog)) {
    if (isBaseType(key)) throw new Error(`Osf type ${key} shadows a base type.`);
    if (!/^[a-z][A-Za-z0-9]*$/.test(key)) throw new Error(`Osf type ${key} must be camelCase; PascalCase names are entities.`);
  }
  const names = new Set(entities.map((entity) => entity.entity));
  const isEntityType = (osfType: string) => names.has(osfType);
  const sources = entities.map(inverseSource);
  for (const entity of entities) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(entity.entity)) throw new Error(`Invalid entity osf type name: ${entity.entity}.`);
    if (result[entity.entity]) throw new Error(`Osf type ${entity.entity} duplicates a loaded entity.`);
    assertNoAuthoredCollections(entity, isEntityType);
    result[entity.entity] = {
      kind: "entity",
      entity: entity.entity,
      entityIdentity: entity.baseEntity !== false || entity.fields.some((field) => field.key === "id"),
      baseType: "string",
      validation: { format: "uuid" },
      label: entity.labels ?? { en: entity.title ?? entity.entity },
      pluralLabel: defaultInverseLabel(entity),
      shape: withInverseCollections(entity.entity, entity.fields, deriveInverseCollections(entity.entity, sources, isEntityType)),
      render: { input: "EntityReferenceSelect", display: "EntityReferenceDisplay" },
      ...(entity.versioning ? { versioned: true } : {}),
    };
    const identityKey = `${entity.entity[0]!.toLowerCase()}${entity.entity.slice(1)}Id`;
    if (result[entity.entity]!.entityIdentity === false) continue;
    if (Object.hasOwn(catalog, identityKey)) {
      throw new Error(`Osf type ${identityKey} is the identity alias of entity ${entity.entity}; it is derived, not authored.`);
    }
    if (result[identityKey]) throw new Error(`Osf type ${identityKey} duplicates the identity alias of entity ${entity.entity}.`);
    const route = entity.interfaces?.web?.views?.collection?.route;
    // Enumerating the records is the entity's own list Operation; there is no
    // separate options endpoint to point at, and the web route is navigation.
    const enumerable = Object.values(entity.operations ?? {}).some((operation) =>
      operation.implementation.type !== "collection" && operation.implementation.action === "list");
    // The identity alias is distinct from a relationship to that entity: an
    // entity's own primary key must never acquire a self-referencing FK. It
    // carries no classification: `internal` restricts nothing (only
    // confidential/pii/bsn do) and no consumer reads a category, so the
    // authored `{ sensitivity: internal, category: workflow }` was noise.
    result[identityKey] = {
      kind: "entityId", entity: entity.entity, baseType: "string",
      label: entity.labels ?? { en: entity.title ?? entity.entity },
      validation: { format: "uuid" },
      listUrl: (typeof route === "string" ? route : route?.en ?? route?.nl) ?? `/${deriveTableName(entity.entity).replaceAll("_", "-")}`,
      ...(enumerable ? { optionSource: { type: "entity", source: entity.entity, valueField: "id" } } : {}),
      displayTemplate: entity.displayTemplate ?? "{{id}}",
      filterField: entity.filterField ?? "id",
      icon: "file",
      render: { input: "EntityReferenceSelect", display: "EntityReferenceDisplay" },
    };
  }
  for (const entity of entities) {
    const versionEntity = entity.versioning?.versionEntity;
    if (!versionEntity) continue;
    const target = result[versionEntity];
    if (target?.kind !== "entity") throw new Error(`${entity.entity}: versioning.versionEntity ${versionEntity} is not a loaded entity.`);
    target.versionEntityOf = entity.entity;
  }
  return result;
}

/** The inverse collections `entity` receives, read from the entity projections in the catalog. */
export function inverseCollectionsFor(entity: string, catalog: Record<string, OsfTypeDefinition>): Field[] {
  const isEntityType = (osfType: string) => catalog[osfType]?.kind === "entity";
  const sources: InverseCollectionSource[] = Object.entries(catalog)
    .filter(([, definition]) => definition.kind === "entity" && definition.shape)
    .map(([name, definition]) => ({
      entity: name,
      labels: definition.label,
      pluralLabels: definition.pluralLabel,
      fields: definition.shape!,
      valueDefinition: definition.entityIdentity === false,
    }));
  return deriveInverseCollections(entity, sources, isEntityType);
}

/**
 * Provider-backed entities are projections of the loaded Operation catalogs:
 * relationship targets without storage, resolved by their own Operations.
 */
export function deriveProviderOsfTypes(
  catalogs: readonly OperationCatalogDefinition[],
  catalog: Record<string, OsfTypeDefinition>,
): Record<string, OsfTypeDefinition> {
  const result = { ...catalog };
  for (const definition of catalogs) {
    for (const [name, entity] of Object.entries(definition.interfaces?.web?.entities ?? {})) {
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`Invalid provider entity osf type name: ${name}.`);
      // A loaded entity of the same name owns the type, as it owns the route in
      // the web manifest; the provider projection stays reachable only there.
      if (result[name]?.kind === "entity") continue;
      if (result[name]) throw new Error(`Osf type ${name} duplicates a loaded entity or provider entity.`);
      result[name] = { kind: "provider", entity: name, baseType: "object", label: entity.title };
    }
  }
  return result;
}

/**
 * Profile (partial) fields extend an entity with columns on a profile table.
 * They resolve their base type, catalog validation and cardinality the way
 * entity fields do, but they never go through relationship normalization:
 * a profile table carries no foreign keys, so a field that names an entity
 * would silently compile to a bare text column. It is refused; the
 * relationship belongs on the entity, added with an entityPatch. The one
 * exception is an entity-value definition, whose profile fields are its own
 * fields and are normalized as such by the compiler.
 */
export function withBaseTypes(
  fields: readonly Field[],
  catalog: Record<string, OsfTypeDefinition>,
  path = "",
  options: { entityReferences?: "refuse" | "normalizedLater" } = {},
): Field[] {
  return fields.map((field) => {
    const origin = path ? `${path}.${field.key}` : field.key;
    const semantic = osfTypeDefinitionOf(field.osfType, catalog);
    const baseType = field.baseType ?? resolveBaseType(field.osfType, catalog);
    if (!baseType) throw new Error(`${origin}: unknown osfType ${field.osfType}.`);
    const references = semantic?.kind === "entity" || semantic?.kind === "entityId" || semantic?.kind === "provider";
    if (references && options.entityReferences !== "normalizedLater") {
      throw new Error(
        `${origin}: a profile field cannot reference entity ${semantic.entity ?? field.osfType}; ` +
          "profile tables carry no relationships. Add the field to the entity itself (kind: entityPatch).",
      );
    }
    const result: Field = { ...field, baseType };
    if (semantic?.validation || field.validation) result.validation = { ...semantic?.validation, ...field.validation };
    const cardinality = field.cardinality ?? semantic?.cardinality;
    if (cardinality) result.cardinality = cardinality;
    if (cardinalityOf(cardinality, origin).required) result.required = true;
    return result;
  });
}

/** Normalize once, before storage, Operations and interface projections diverge. */
export function normalizeEntityFields(
  entity: CoreEntity,
  catalog: Record<string, OsfTypeDefinition>,
): CoreEntity {
  const identityKey = `${entity.entity[0]!.toLowerCase()}${entity.entity.slice(1)}Id`;
  const normalize = (field: Field, nested = false, ancestry: readonly string[] = []): Field => {
    const path = `${entity.entity}.${field.key}`;
    if (!field.osfType) throw new Error(`${path}: osfType is required.`);
    const semantic = osfTypeDefinitionOf(field.osfType, catalog);
    if (entity.baseEntity === false && !entity.fields.some((field) => field.key === "id")) {
      assertEntityValueFieldPolicies(field, path, semantic);
    }
    const baseType = isBaseType(field.osfType) ? field.osfType : semantic?.baseType;
    if (!baseType) throw new Error(`${path}: unknown osfType ${field.osfType}.`);
    // Inline identifier values (for example arguments in a stored template)
    // are not entity relationships. Preserve their scalar semantic type;
    // only an EntityName osf type requests relational storage. A nested
    // value cannot claim its own persisted column or relationship metadata.
    if (nested && semantic?.kind === "entityId" && (field.persisted || field.relationship)) {
      throw new Error(`${path}: inline identifier values cannot declare relational storage.`);
    }
    if (!nested && semantic?.kind === "entityId" && (field.key !== "id" || field.osfType !== identityKey)) {
      throw new Error(`${path}: identity aliases identify primary keys; use the entity osfType for a relationship.`);
    }
    const result: Field = { ...field, baseType };
    if (semantic?.validation || field.validation) result.validation = { ...semantic?.validation, ...field.validation };
    const inlineShape = field.shape ?? field.children ?? (semantic?.kind !== "entity" ? semantic?.shape ?? semantic?.children : undefined);
    const item = field.item ?? semantic?.item;
    if (inlineShape || item) {
      if (semantic && ancestry.includes(field.osfType)) throw new Error(`${path}: cyclic inline osf type ${field.osfType}.`);
      const nextAncestry = semantic ? [...ancestry, field.osfType] : ancestry;
      if (inlineShape) result.children = inlineShape.map((child) => normalize(child, true, nextAncestry));
      if (field.shape && result.children) result.shape = result.children;
      if (item) result.item = normalize(item, true, nextAncestry);
    }
    const cardinality = field.cardinality ?? semantic?.cardinality;
    if (cardinality) result.cardinality = cardinality;
    if (cardinalityOf(cardinality, path).required) result.required = true;
    const collection = fieldCardinality(result) === "collection";
    if ((field.entityValue || field.allowedDefinitions) && nested) {
      throw new Error(`${path}: entityValue and allowedDefinitions require a top-level field.`);
    }
    if (field.entityValue) {
      if (field.osfType !== "entityValue" || baseType !== "object" || collection || field.relationship || inlineShape || item) {
        throw new Error(`${path}: entityValue requires a single entityValue object without inline fields or a relationship.`);
      }
      const discriminator = entity.fields.find((candidate) => candidate.key === field.entityValue!.definitionField);
      const discriminatorSemantic = osfTypeDefinitionOf(discriminator?.osfType, catalog);
      if (!discriminator || discriminator === field || resolveBaseType(discriminator.osfType, catalog) !== "string" || !discriminator.required || !discriminator.persisted || fieldCardinality({ cardinality: discriminator.cardinality ?? discriminatorSemantic?.cardinality ?? "single" }) !== "single" || discriminator.relationship || ["entity", "entityId"].includes(discriminatorSemantic?.kind ?? "")) {
        throw new Error(`${path}: definitionField must name a required persisted scalar string field.`);
      }
      if (!field.persisted) throw new Error(`${path}: entityValue requires a persisted values column.`);
    } else if (field.osfType === "entityValue") {
      throw new Error(`${path}: entityValue requires definitionField metadata.`);
    }
    if (field.allowedDefinitions) {
      if (!collection || semantic?.kind !== "entity" || !Array.isArray(field.allowedDefinitions) || !field.allowedDefinitions.length || new Set(field.allowedDefinitions).size !== field.allowedDefinitions.length) {
        throw new Error(`${path}: allowedDefinitions requires a nonempty unique definition list on an entity collection.`);
      }
      for (const definition of field.allowedDefinitions) {
        if (!Object.hasOwn(catalog, definition) || catalog[definition]?.kind !== "entity") throw new Error(`${path}: unknown allowed definition ${definition}.`);
      }
    }
    if (field.sortable && !collection) throw new Error(`${path}: sortable requires a collection.`);
    if (field.childAuthorization && (!collection || field.relationship?.ownership !== "owned")) throw new Error(`${path}: childAuthorization requires an owned collection.`);
    if (semantic?.kind === "provider") {
      result.relationship = providerRelationshipOf(entity, field, result, semantic, nested, collection);
      return result;
    }
    if (field.provider) throw new Error(`${path}: provider requires an osfType that names a provider-backed entity.`);
    if (field.childLock !== undefined) {
      if (!collection || field.relationship?.ownership !== "owned") throw new Error(`${path}: childLock requires an owned collection.`);
      const lock = semantic?.shape?.find((candidate) => candidate.key === field.childLock);
      if (!lock || resolveBaseType(lock.osfType, catalog) !== "boolean" || fieldCardinality(lock) !== "single") throw new Error(`${path}: childLock must name a single boolean field of ${semantic?.entity ?? field.osfType}.`);
    }
    if (field.relationship?.version) {
      if (collection || field.relationship.ownership === "owned") throw new Error(`${path}: version applies to a single reference only.`);
      if (!["pinned", "current"].includes(field.relationship.version)) throw new Error(`${path}: version must be pinned or current.`);
      if (field.relationship.version === "pinned" && !semantic?.versionEntityOf) throw new Error(`${path}: version: pinned requires a target that is the version entity of a versioned entity.`);
      if (field.relationship.version === "current" && !semantic?.versioned) throw new Error(`${path}: version: current requires a target that declares versioning.`);
    }
    if (semantic?.kind !== "entity") {
      if (field.relationship) throw new Error(`${path}: relationship requires a loaded entity osfType.`);
      return result;
    }
    if (semantic.entityIdentity === false) throw new Error(`${path}: identity-less entity ${semantic.entity} is a value definition, not a relationship target.`);
    if (nested) throw new Error(`${path}: entity references must be relational fields, not IDs inside JSON values.`);
    result.relationship = relationshipOf(entity, field, result, semantic, catalog, collection);
    return result;
  };
  const fields = withInverseCollections(entity.entity, entity.fields, inverseCollectionsFor(entity.entity, catalog));
  return { ...entity, fields: fields.map((field) => normalize(field)) };
}

/**
 * A reference to a provider-backed entity: nothing is stored on this entity,
 * the target's Operations resolve the records from the bound field values.
 * The field is read-only on every interface; only the relationship is projected.
 */
function providerRelationshipOf(
  entity: CoreEntity,
  field: Field,
  result: Field,
  semantic: OsfTypeDefinition,
  nested: boolean,
  collection: boolean,
): NonNullable<Field["relationship"]> {
  const path = `${entity.entity}.${field.key}`;
  const target = semantic.entity!;
  if (nested) throw new Error(`${path}: provider-backed references are top-level fields, not values inside JSON.`);
  if (field.persisted) throw new Error(`${path}: a provider-backed reference has no storage of its own; the ${target} Operations resolve it.`);
  // Normalization runs more than once (loader, then compile): a relationship
  // this function derived earlier is not authored metadata.
  if (field.relationship && !field.relationship.provider) {
    throw new Error(`${path}: a provider-backed reference declares provider.bindings, not relationship metadata.`);
  }
  const bindings = field.provider?.bindings ?? field.relationship?.provider?.bindings;
  if (!bindings || Object.keys(bindings).length === 0) {
    throw new Error(`${path}: provider.bindings maps ${target} Operation input fields to fields of ${entity.entity}.`);
  }
  for (const [input, own] of Object.entries(bindings)) {
    if (!entity.fields.some((candidate) => candidate.key === own)) {
      throw new Error(`${path}: provider.bindings.${input} names unknown field ${entity.entity}.${own}.`);
    }
  }
  result.readOnly = true;
  return {
    kind: collection ? "hasMany" : "belongsTo",
    entity: slug(target),
    target,
    fieldKey: field.key,
    ownership: "reference",
    provider: { bindings: { ...bindings } },
  };
}

function relationshipOf(
  entity: CoreEntity,
  field: Field,
  result: Field,
  semantic: OsfTypeDefinition,
  catalog: Record<string, OsfTypeDefinition>,
  collection: boolean,
): NonNullable<Field["relationship"]> {
  const path = `${entity.entity}.${field.key}`;
  const target = semantic.entity!;
  const metadata = field.relationship ?? {};
  if (!collection && metadata.ownership === "owned") {
    throw new Error(`${path}: single owned references require a single-storage ownership contract; use an owned inverse collection until supported.`);
  }
  if (!collection) {
    if (typeof metadata.inverse === "string") throw new Error(`${path}: a single reference declares its inverse collection as an object ({ key, label }), not as a field key.`);
    const foreignKey = field.persisted?.column ?? `${snake(field.key)}_id`;
    result.persisted = field.persisted ?? { column: foreignKey, storageClass: "core" };
    if (entity.authorization && result.persisted.column === "tenant_id") result.readOnly = true;
    result.validation = { ...semantic.validation, ...field.validation, format: "uuid" };
    return {
      kind: "belongsTo",
      entity: slug(target),
      target,
      fieldKey: field.key,
      ownership: metadata.ownership ?? "reference",
      foreignKey,
      ...(metadata.displayField ? { displayField: metadata.displayField } : {}),
      ...(metadata.version ? { version: metadata.version } : {}),
      ...(metadata.constraints ? { constraints: structuredClone(metadata.constraints) } : {}),
    };
  }
  if (field.persisted) throw new Error(`${path}: entity collections use a relation, never a JSON column.`);
  const inverse = metadata.inverse;
  if (typeof inverse !== "string") throw new Error(`${path}: a collection names the referencing field on ${target} as its inverse.`);
  let inverseTarget = entity.entity;
  let through: { field: string; column: string; target: string } | undefined;
  if (metadata.via) {
    const via = entity.fields.find((candidate) => candidate.key === metadata.via);
    const viaType = osfTypeDefinitionOf(via?.osfType, catalog);
    if (metadata.ownership === "owned" || field.sortable || !via || via === field || viaType?.kind !== "entity" ||
      viaType.entityIdentity === false || fieldCardinality(via) !== "single" || via.relationship?.via) {
      throw new Error(`${path}: via requires a read-only inverse collection through a direct, single entity reference.`);
    }
    inverseTarget = viaType.entity!;
    through = { field: via.key, column: via.persisted?.column ?? `${snake(via.key)}_id`, target: inverseTarget };
    result.readOnly = true;
  }
  const inverseField = semantic.shape?.find((candidate) => candidate.key === inverse);
  if (!inverseField || inverseField.osfType !== inverseTarget) {
    throw new Error(`${path}: inverse ${target}.${inverse} must refer to ${inverseTarget}.`);
  }
  if (fieldCardinality(inverseField) === "collection") {
    throw new Error(`${path}: bidirectional collections require an explicit association entity.`);
  }
  const foreignKey = inverseField.persisted?.column ?? `${snake(inverse)}_id`;
  return {
    kind: "hasMany",
    entity: slug(target),
    target,
    fieldKey: field.key,
    ownership: metadata.ownership ?? "reference",
    inverse,
    ...(through ? { via: metadata.via!, through } : {}),
    foreignKey,
    ...(metadata.displayField ? { displayField: metadata.displayField } : {}),
    ...(metadata.constraints ? { constraints: structuredClone(metadata.constraints) } : {}),
  };
}
