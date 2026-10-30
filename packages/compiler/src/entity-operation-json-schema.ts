import { relatedUpdateSchema } from "./related-update-schema.js";
import { blueprintBindingsSchema } from "./blueprint-create-schema.js";
import { sortablePositionFieldKeys } from "./authoring/sortable-position.js";
// SPDX-License-Identifier: BUSL-1.1
/** Concrete JSON Schemas for the canonical entity Operation executor. */
import type {
  CompiledColumn,
  CompiledEntityContract,
  CompiledEntityOperation,
  CompiledField,
  CompiledRelationship,
} from "./authoring/types.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import {
  compiledFieldSchemaWithoutDefinitions,
  compiledObjectSchema,
  localizedText,
  splitBundledDefinitions,
} from "./field-json-schema.js";
import type { JsonSchema } from "./plugins.js";
import { compileFieldValuePolicy, fieldValuePolicySchema, partialFieldPolicySchema } from "./authoring/field-value-policy.js";
import {
  FIELD_BINDINGS_FIELD,
  isScalarType,
  MAX_BINDING_TEMPLATE_LENGTH,
  MAX_VARIABLE_REFERENCE_LENGTH,
  scalarJsonSchema,
  VARIABLE_NAMESPACES,
  VARIABLE_REFERENCE_PATTERN,
} from "@openshapeforge/operations";
import {
  operationControlProperties,
  type OperationControlSchema,
  withOperationControlProperties,
} from "./entity-operation-controls.js";

type JsonObject = Record<string, unknown>;

const SERVER_MANAGED_FIELDS = new Set([
  "id",
  "tenantId",
  "createdAt",
  "updatedAt",
]);

export type EntityRelationshipTarget = { label: string; listTool?: string };
export type EntityRelationshipKey = {
  key: string;
  relationship: string;
  target: string;
  required: boolean;
  schema: JsonObject;
};

function entityLabel(contract: CompiledEntityContract): string {
  return localizedText(contract.entity.labels) ??
    contract.entity.title ??
    contract.entity.name;
}

const storageValueSchema = (type: CompiledColumn["type"]): JsonObject =>
  isScalarType(type) ? (scalarJsonSchema(type) as JsonObject) : { type: "string" };

function nullableSchema(schema: JsonObject): JsonObject {
  return { anyOf: [schema, { type: "null" }] };
}

/** The annotations a form reads from a property node, kept on a wrapper (`anyOf`/`oneOf`) around it. */
function presentation(schema: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key === "x-osf-type" || key === "x-osf-reference" || key === "x-osf-i18n" || key === "x-osf-typed-by" || key === "x-osf-presentation" || key === "x-osf-value-context" || key === "x-osf-variables"));
}

export type EntityRecordOutputOptions = {
  /** A transport's own wording for a field, kept beside the shared title. */
  describeField?: (field: CompiledField) => string | undefined;
};

/**
 * The persisted fields of this entity that accept a variable in place of a
 * literal, with the shape each one authored. A field is bindable only where
 * it is persisted: the binding is stored beside the value it resolved to.
 */
export function bindableEntityFields(
  contract: CompiledEntityContract,
): Array<{ key: string; variables: "whole" | "template" | "both" }> {
  const persisted = new Set(contract.storage.columns.map((column) => column.field));
  return contract.model.fields
    .filter((field) => field.variables !== undefined && field.variables !== "none" && persisted.has(field.key))
    .map((field) => ({ key: field.key, variables: field.variables as "whole" | "template" | "both" }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * What may be written into one bindable field: a reference the whole value is
 * taken from, or the authored template whose tokens are filled. Each field
 * offers only the shapes its own mode authors, so the published contract says
 * what the write path will compare rather than a superset of it.
 */
function bindingInputSchema(variables: "whole" | "template" | "both"): JsonObject {
  const whole: JsonObject = {
    type: "string",
    pattern: VARIABLE_REFERENCE_PATTERN,
    maxLength: MAX_VARIABLE_REFERENCE_LENGTH,
    description:
      `The variable this field's whole value is taken from, as ${VARIABLE_NAMESPACES.map((namespace) => `${namespace}.key`).join(" or ")}. ` +
      "Its declared type must fit this field; the value is resolved server-side and revalidated on every read.",
  };
  const template: JsonObject = {
    type: "object",
    additionalProperties: false,
    required: ["template"],
    properties: {
      template: {
        type: "string",
        maxLength: MAX_BINDING_TEMPLATE_LENGTH,
        description: "The authored text whose `{{namespace.key}}` tokens are filled with each variable's formatted value.",
      },
    },
  };
  return variables === "whole" ? whole : variables === "template" ? template : { oneOf: [whole, template] };
}

/**
 * The two binding controls of a create or update, beside `values`: what to
 * bind, and what to freeze as a literal again. Offered only where the entity
 * has a bindable field, so an entity without one keeps the contract it had.
 */
export function entityBindingControlProperties(contract: CompiledEntityContract): JsonObject {
  const bindable = bindableEntityFields(contract);
  if (bindable.length === 0) return {};
  return {
    bindings: {
      type: "object",
      additionalProperties: false,
      description:
        "Fields to bind to a variable instead of a literal. A literal in `values` clears that field's binding; " +
        "a binding is stored apart from the value it resolved to and is revalidated against its source on every read.",
      properties: Object.fromEntries(bindable.map(({ key, variables }) => [key, bindingInputSchema(variables)])),
    },
    unbind: {
      type: "array",
      uniqueItems: true,
      maxItems: bindable.length,
      description:
        "Fields whose binding is removed. The source is resolved once more and that value is written as a literal, " +
        "so the record keeps the value it has now rather than a stale one.",
      items: { type: "string", enum: bindable.map(({ key }) => key) },
    },
  };
}

/**
 * The same two controls merged into a FLAT transport input schema — an MCP
 * entity tool, whose create takes its fields at the top level. A tool that did
 * not advertise them would refuse a binding as an undeclared argument, so the
 * three interfaces would offer three different write contracts.
 */
export function withEntityBindingControls(
  schema: JsonSchema,
  contract: CompiledEntityContract,
): JsonSchema {
  const controls = entityBindingControlProperties(contract);
  if (Object.keys(controls).length === 0) return schema;
  const properties = { ...(schema.properties as Record<string, unknown> | undefined), ...controls };
  const nested = properties.values && typeof properties.values === "object" ? properties.values as JsonObject : undefined;
  const bindable = new Set(bindableEntityFields(contract).map((field) => field.key));
  const requiredBindings = new Set<string>();
  const relaxRequired = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.filter((field) => {
      if (typeof field !== "string" || !bindable.has(field)) return true;
      requiredBindings.add(field);
      return false;
    });
  };
  let required = schema.required;
  if (nested) properties.values = { ...nested, required: relaxRequired(nested.required) };
  else required = relaxRequired(required);
  // Blueprint inputs defer copied literals too. Preserve their source guard
  // while permitting a required bindable field to arrive through bindings.
  const existing = ((schema.allOf ?? []) as JsonObject[]).map((condition) => {
    const then = condition.then as JsonObject | undefined;
    if (!then) return condition;
    const thenProperties = then.properties as JsonObject | undefined;
    const thenValues = thenProperties?.values as JsonObject | undefined;
    if (nested && thenValues) return { ...condition, then: { ...then, properties: {
      ...thenProperties, values: { ...thenValues, required: relaxRequired(thenValues.required) },
    } } };
    if (!nested && then.required) return { ...condition, then: { ...then, required: relaxRequired(then.required) } };
    return condition;
  });
  const alternatives = [...requiredBindings].map((field) => ({ anyOf: [
    nested ? { required: ["values"], properties: { values: { required: [field] } } } : { required: [field] },
    { required: ["bindings"], properties: { bindings: { required: [field] } } },
    ...(contract.blueprint ? [{ required: ["blueprintId"] }] : []),
  ] }));
  return {
    ...schema,
    properties,
    ...(required === undefined ? {} : { required }),
    ...(existing.length || alternatives.length ? { allOf: [...existing, ...alternatives] } : {}),
  };
}

/**
 * Persisted record shape returned by every canonical entity read/write. It
 * follows storage, not the create schema: server-managed values and
 * relationship foreign keys are present in reads too, and older rows are not
 * rewritten by input validation rules, so no bounds or enums constrain it.
 * `additionalProperties` stays open because a runtime may add a safe,
 * server-derived projection.
 */
export function entityRecordOutputSchema(
  contract: CompiledEntityContract,
  generic = false,
  options: EntityRecordOutputOptions = {},
): JsonObject {
  if (generic) return { type: "object", additionalProperties: true };

  const fields = new Map(contract.model.fields.map((field) => [field.key, field]));
  const properties: JsonObject = {};
  const required: string[] = [];
  const add = (key: string, schema: JsonObject, isRequired: boolean): void => {
    properties[key] = schema;
    if (isRequired) required.push(key);
  };
  for (const column of contract.storage.columns) {
    const field = fields.get(column.field);
    const title = field ? localizedText(field.label) : undefined;
    const description = field ? options.describeField?.(field) : undefined;
    const schema = {
      ...storageValueSchema(column.type),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    };
    const readMayBeRedacted = field?.authorization !== undefined ||
      ["pii", "bsn", "confidential"].includes(field?.classification?.sensitivity ?? "");
    add(
      column.field,
      {
        ...(column.nullable || readMayBeRedacted ? nullableSchema(schema) : schema),
        ...(field?.label && typeof field.label === "object"
          ? { "x-osf-i18n": { title: field.label } } : {}),
        // The type a reader renders the property through, on the node a reader gets (the nullable wrapper included).
        ...(field?.osfType ? { "x-osf-type": field.osfType } : {}),
      },
      !column.nullable,
    );
  }
  for (const [key, schema] of [
    ["id", { type: "string", format: "uuid" }],
    ["tenantId", { type: "string", format: "uuid" }],
    ["createdAt", { type: "string", format: "date-time" }],
    ["updatedAt", { type: "string", format: "date-time" }],
  ] as const) {
    if (!(key in properties)) {
      const labels = {
        id: { en: "ID", nl: "ID" }, tenantId: { en: "Organization ID", nl: "Organisatie-ID" },
        createdAt: { en: "Created at", nl: "Aangemaakt op" }, updatedAt: { en: "Updated at", nl: "Bijgewerkt op" },
      };
      add(key, { ...schema, "x-osf-i18n": { title: labels[key] } }, true);
    }
  }
  // The bindings a record carries, read beside the values they resolved to.
  // Present on every read of a bindable entity, so a reader can tell a bound
  // field from a literal one without inferring it from the value.
  const bindable = bindableEntityFields(contract);
  if (bindable.length > 0 && !(FIELD_BINDINGS_FIELD in properties)) {
    add(FIELD_BINDINGS_FIELD, nullableSchema({
      type: "object",
      additionalProperties: false,
      title: "Field bindings",
      description: "Per bound field, the variable its value is taken from, or the authored template its text is filled from.",
      properties: Object.fromEntries(bindable.map(({ key }) => [key, {
        oneOf: [
          { type: "object", additionalProperties: false, required: ["kind", "ref"], properties: { kind: { const: "whole" }, ref: { type: "string" } } },
          { type: "object", additionalProperties: false, required: ["kind", "source"], properties: { kind: { const: "template" }, source: { type: "string" } } },
        ],
      }])),
    }), false);
  }
  return { type: "object", properties, required, additionalProperties: true };
}

/** Fields accepted by generated create/update, shared with interface schemas. */
export function writableEntityFields(
  fields: readonly CompiledField[],
  operation: "create" | "update",
): CompiledField[] {
  return fields.filter(
    (field) =>
      !SERVER_MANAGED_FIELDS.has(field.key) &&
      !(field.relationship && field.cardinality === "collection") &&
      field.computed === undefined &&
      !(field.writtenBy !== undefined && field.writtenBy.length > 0) &&
      field.deriveOnCreate === undefined &&
      !(operation === "update" && field.immutable === true),
  );
}

/** Resolve one authored belongsTo relation to its implicit writable FK field. */
export function entityRelationshipColumn(
  contract: CompiledEntityContract,
  relationship: CompiledRelationship,
): { key: string; nullable: boolean } | undefined {
  if (relationship.kind !== "belongsTo" || !relationship.foreignKey) return undefined;
  const column = contract.storage.columns.find(
    (candidate) => candidate.column === relationship.foreignKey,
  );
  return {
    key: column?.field ?? `${relationship.key}Id`,
    nullable: column ? column.nullable : true,
  };
}

export function entityRelationshipKeys(
  contract: CompiledEntityContract,
  targets: ReadonlyMap<string, EntityRelationshipTarget>,
): EntityRelationshipKey[] {
  const ownedByField = new Set(contract.model.fields.map((field) => field.key));
  const keys: EntityRelationshipKey[] = [];
  for (const relationship of contract.model.relationships) {
    const column = entityRelationshipColumn(contract, relationship);
    if (!column || ownedByField.has(column.key)) continue;
    const target = targets.get(relationship.target);
    const targetLabel = target?.label ?? relationship.target;
    keys.push({
      key: column.key,
      relationship: relationship.key,
      target: relationship.target,
      required: !column.nullable,
      schema: {
        type: "string",
        format: "uuid",
        "x-osf-type": relationship.target,
        description:
          `Identifier of the ${targetLabel} this ${entityLabel(contract)} belongs to` +
          (target?.listTool ? `, as returned by \`${target.listTool}\`.` : "."),
      },
    });
  }
  return keys;
}

export function withEntityRelationshipKeys(
  schema: JsonObject,
  keys: readonly EntityRelationshipKey[],
  requireRequired: boolean,
): JsonObject {
  if (keys.length === 0) return schema;
  const properties = { ...((schema.properties as JsonObject | undefined) ?? {}) };
  const required = [...((schema.required as string[] | undefined) ?? [])];
  for (const entry of keys) {
    properties[entry.key] = entry.schema;
    if (requireRequired && entry.required) required.push(entry.key);
  }
  return {
    ...schema,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** `schema` with the Operation's controls merged in, keeping its own required and dependent keys. */
export function withEntityOperationControls(
  schema: JsonObject,
  operation: CompiledEntityOperation | undefined,
): JsonObject {
  return withOperationControlProperties(schema, {
    concurrency: operation?.concurrency,
    confirmation: operation?.interaction?.confirmation ?? { mode: "none" },
  });
}

/** Platform-owned controls attached to the executor input, never business values. */
export function entityOperationControlSchema(
  operation: CompiledEntityOperation | undefined,
): OperationControlSchema {
  return operationControlProperties({
    concurrency: operation?.concurrency,
    confirmation: operation?.interaction?.confirmation ?? { mode: "none" },
  });
}

function relationshipTargets(
  contracts: readonly CompiledEntityContract[],
): ReadonlyMap<string, EntityRelationshipTarget> {
  return new Map(
    contracts.map((contract) => [
      contract.entity.name,
      { label: entityLabel(contract) },
    ]),
  );
}

function openOperationOffers(): JsonObject {
  return { type: "array", items: { type: "object", additionalProperties: true } };
}

/** Shared canonical record envelope; offers are additionally checked by core execution. */
export function entityRecordEnvelopeSchema(record: JsonObject): JsonObject {
  return { type: "object", additionalProperties: false, required: ["data", "operations"],
    properties: {
      data: { ...record, "x-osf-i18n": { title: { en: "Record", nl: "Record" } } },
      operations: { ...openOperationOffers(), "x-osf-i18n": { title: { en: "Available actions", nl: "Beschikbare acties" } } },
    } };
}

function exactFilter(schema: JsonObject): JsonObject {
  return {
    type: "object",
    properties: { eq: schema },
    required: ["eq"],
    additionalProperties: false,
  };
}

function relationshipAnyFilters(
  contract: CompiledEntityContract,
  contracts: readonly CompiledEntityContract[],
  referentiedata: CoreReferentiedataSnapshot,
): JsonObject {
  const byName = new Map(contracts.map((candidate) => [candidate.entity.name, candidate]));
  const result: JsonObject = {};
  for (const relationship of contract.model.relationships) {
    if (relationship.kind !== "hasMany" || !relationship.foreignKey) continue;
    const target = byName.get(relationship.target);
    if (!target?.entityOperations.list) continue;
    const properties: JsonObject = {};
    for (const field of target.model.fields) {
      if (field.cardinality === "collection" || field.baseType === "object") continue;
      const schema = compiledFieldSchemaWithoutDefinitions(field, referentiedata);
      delete schema.default;
      properties[field.key] = exactFilter(schema);
    }
    result[relationship.key] = {
      type: "object",
      properties: {
        any: { type: "object", properties, minProperties: 1, additionalProperties: false },
      },
      required: ["any"],
      additionalProperties: false,
    };
  }
  return result;
}

/**
 * The fields a list may filter on, each with the bare schema of one value:
 * no default (a default would silently narrow a caller's result set), no
 * collection or object fields, and the belongsTo keys as uuids. Every
 * transport builds its filter properties from this one list; the canonical
 * executor wraps each in its exact-match alternative.
 */
export function entityListFilterFields(
  contract: CompiledEntityContract,
  relationships: readonly EntityRelationshipKey[],
  referentiedata: CoreReferentiedataSnapshot | undefined,
  options: { excludeField?: string | undefined; describeField?: EntityRecordOutputOptions["describeField"] } = {},
): Array<{ key: string; schema: JsonObject }> {
  const fields = contract.model.fields
    .filter((field) =>
      field.key !== options.excludeField &&
      field.cardinality !== "collection" &&
      field.baseType !== "object"
    )
    .map((field) => {
      const schema = compiledFieldSchemaWithoutDefinitions(
        field,
        referentiedata,
        options.describeField ? { describeField: options.describeField } : {},
      );
      delete schema.default;
      return { key: field.key, schema };
    });
  return [...fields, ...relationships.map((entry) => ({ key: entry.key, schema: entry.schema }))];
}

/**
 * The fields a list may sort on: every single-valued scalar the caller may
 * filter on, then the positions that order this entity's children in another
 * entity's sortable collection (`sortablePositionFieldKeys`), which the
 * runtime sorts on like any column. Without `contracts` no owner is known and
 * only the entity's own fields are offered.
 */
export function entitySortableFieldKeys(
  contract: CompiledEntityContract,
  excludeField?: string,
  contracts: readonly CompiledEntityContract[] = [],
): string[] {
  const own = contract.model.fields
    .filter((field) =>
      field.key !== excludeField &&
      field.cardinality !== "collection" &&
      field.baseType !== "object"
    )
    .map((field) => field.key);
  const positions = sortablePositionFieldKeys(contract.entity.name, contracts).filter((key) => !own.includes(key));
  return [...own, ...positions];
}

/**
 * One page of a list: the items, the total and the cursor. `counted` is the
 * page a transport that always counts returns; `optional` the executor's,
 * whose count is null unless the caller asked for it.
 */
export function entityListPageSchema(
  item: JsonObject,
  totalCount: "counted" | "optional",
): JsonObject {
  return {
    type: "object",
    properties: {
      items: { type: "array", items: item },
      totalCount: totalCount === "counted"
        ? { type: "integer" }
        : { anyOf: [{ type: "integer" }, { type: "null" }] },
      nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["items", "totalCount", "nextCursor"],
    additionalProperties: false,
  };
}

/**
 * The writable values of a create or update, as one object schema: the
 * writable fields with their authored rules, then the belongsTo keys. The
 * canonical executor nests it under `values`; REST flattens it into the body.
 * Definitions a field schema bundles are split off so each transport can
 * place them where its document keeps shared definitions.
 */
export function entityValuesSchema(
  contract: CompiledEntityContract,
  operation: "create" | "update",
  contracts: readonly CompiledEntityContract[],
  referentiedata: CoreReferentiedataSnapshot,
  options: {
    /** A field a transport fills by other means (an elicited value), never from the model. */
    excludeField?: string | undefined;
    describeField?: EntityRecordOutputOptions["describeField"];
    targets?: ReadonlyMap<string, EntityRelationshipTarget>;
  } = {},
): { values: JsonObject; definitions: JsonObject } {
  const secureInputTarget = contract.entityOperations.create?.interaction?.secureInput?.into;
  const relationships = entityRelationshipKeys(contract, options.targets ?? relationshipTargets(contracts));
  // A field the storage layer gave no column (a runtime-resolved projection)
  // has nothing the executor could write to.
  const persisted = new Set(contract.storage.columns.map((column) => column.field));
  const fields = writableEntityFields(contract.model.fields, operation)
    .filter((field) =>
      field.key !== secureInputTarget && field.key !== options.excludeField && persisted.has(field.key)
    );
  const compiledValues = withEntityRelationshipKeys(
    compiledObjectSchema(operation === "create" ? fields.map(field => field.defaultTemplate === undefined ? field : {...field, required: false}) : fields, referentiedata, {
      ...(operation === "create"
        ? { requireRequired: true, defaultsAreMaterialized: true }
        : { requireRequired: false, includeDefault: false }),
      ...(options.describeField ? { describeField: options.describeField } : {}),
    }),
    relationships,
    operation === "create",
  );
  const { schema: values, definitions } = splitBundledDefinitions(compiledValues);
  const properties = values.properties as Record<string, JsonObject>;
  for (const field of fields) {
    if (operation === "create" && field.defaultTemplate && properties[field.key]) properties[field.key]!["x-osf-default-template"] = field.defaultTemplate;
    const policy = compileFieldValuePolicy(field);
    if (policy && (policy.children || policy.item) && properties[field.key]) {
      properties[field.key] = operation === "update"
        ? partialFieldPolicySchema(properties[field.key]!, policy)
        : fieldValuePolicySchema(properties[field.key]!, policy);
    }
  }
  return { values, definitions };
}

/**
 * Materialize the canonical `platform.operations.execute` input and data
 * output for one entity Operation. Interface adapters may flatten this shape,
 * but workflow/runtime consumers use this envelope verbatim.
 */
export function entityOperationJsonSchemas(
  contract: CompiledEntityContract,
  operation: CompiledEntityOperation,
  contracts: readonly CompiledEntityContract[],
  referentiedata: CoreReferentiedataSnapshot,
): { inputSchema: JsonSchema; outputSchema: JsonSchema } {
  const id = {
    type: "string",
    format: "uuid",
    description: `Identifier of the ${entityLabel(contract)}.`,
  };
  const controls = entityOperationControlSchema(operation);
  const secureInputTarget = contract.entityOperations.create
    ?.interaction.secureInput?.into;
  const controlled = (properties: JsonObject, required: string[]): JsonSchema => ({
    type: "object",
    properties: { ...properties, ...controls.properties },
    required: [...required, ...controls.required],
    additionalProperties: false,
    ...(controls.dependentRequired
      ? { dependentRequired: controls.dependentRequired }
      : {}),
  });
  if (operation.input.kind === "json-schema") {
    if (operation.output.kind !== "json-schema") {
      throw new Error(
        `Entity Operation "${operation.id}" has mismatched plugin-backed input/output contracts.`,
      );
    }
    const authored = operation.input.schema;
    const properties = authored.properties;
    const required = authored.required;
    if (
      authored.type !== "object" || !properties || typeof properties !== "object" ||
      Array.isArray(properties) || (required !== undefined && !Array.isArray(required))
    ) {
      throw new Error(
        `Plugin-backed entity Operation "${operation.id}" input must be an object JSON Schema.`,
      );
    }
    return {
      inputSchema: {
        ...authored,
        properties: { ...properties, ...controls.properties },
        required: [...((required as string[] | undefined) ?? []), ...controls.required],
        ...(controls.dependentRequired
          ? {
              dependentRequired: {
                ...((authored.dependentRequired as Record<string, string[]> | undefined) ?? {}),
                ...controls.dependentRequired,
              },
            }
          : {}),
      },
      outputSchema: operation.output.schema,
    };
  }

  const relationships = entityRelationshipKeys(
    contract,
    relationshipTargets(contracts),
  );
  const record = entityRecordOutputSchema(contract);
  const nullableRecord = { anyOf: [record, { type: "null" }] };

  switch (operation.intent) {
    case "list": {
      if (operation.input.kind !== "collection-query") {
        throw new Error(`Entity Operation "${operation.id}" has an invalid list input contract.`);
      }
      const filterProperties: JsonObject = {};
      for (const { key, schema } of entityListFilterFields(contract, relationships, referentiedata, { excludeField: secureInputTarget })) {
        const field=contract.model.fields.find(field=>field.key===key);
        const operand=Object.fromEntries(Object.entries(schema).filter(([key])=>!key.startsWith("x-")&&key!=="description"&&key!=="title"));
        const properties:JsonObject={eq:operand,ne:operand,in:{type:"array",minItems:1,maxItems:100,items:operand},isNull:{type:"boolean"}};
        if(field&&["string","date","datetime","integer","number"].includes(field.baseType))for(const operator of ["gt","gte","lt","lte"])properties[operator]=operand;
        if(field?.baseType==="string"&&field.validation?.format!=="uuid")Object.assign(properties,{contains:{type:"string",maxLength:500},startsWith:{type:"string",maxLength:500}});
        filterProperties[key]={...presentation(schema),oneOf:[schema,{type:"object",additionalProperties:false,minProperties:1,properties}]};
      }
      // Batched authorized reference reads use the canonical record identity.
      // The executor applies tenant and row access to this filter as to every list.
      filterProperties.id ??= { oneOf: [id, { type: "object", additionalProperties: false, minProperties: 1,
        properties: { eq: id, in: { type: "array", minItems: 1, maxItems: 100, items: id } } }] };
      Object.assign(filterProperties, relationshipAnyFilters(contract, contracts, referentiedata));
      const filterDefinitions = {entityFilter: {
        type:"object", additionalProperties:false, maxProperties:30,
        properties:{...filterProperties, ...Object.fromEntries(["and","or"].map(key=>[key,{
          type:"array",minItems:1,maxItems:20,items:{$ref:"#/$defs/entityFilter"}
        }]))}
      }};
      const sortable = entitySortableFieldKeys(contract, secureInputTarget, contracts);
      return {
        inputSchema: {
          $defs: filterDefinitions,
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: operation.input.pagination.maxLimit,
              default: operation.input.pagination.defaultLimit,
            },
            cursor: { type: "string", description: "Opaque cursor from a previous page." },
            filter: { $ref: "#/$defs/entityFilter" },
            sort: {
              type: "object",
              properties: {
                field: { type: "string", ...(sortable.length > 0 ? { enum: sortable } : {}) },
                direction: { type: "string", enum: ["asc", "desc"] },
              },
              additionalProperties: false,
            },
            includeTotalCount: { type: "boolean" },
          },
          additionalProperties: false,
        },
        outputSchema: entityListPageSchema(
          {
            type: "object",
            properties: { data: record, operations: openOperationOffers() },
            required: ["data", "operations"],
            additionalProperties: false,
          },
          "optional",
        ),
      };
    }
    case "get":
      return {
        inputSchema: controlled({ id }, ["id"]),
        outputSchema: nullableRecord,
      };
    case "create": {
      const { values, definitions } = entityValuesSchema(contract, "create", contracts, referentiedata);
      const blueprint = contract.blueprint;
      const requiredValues = Array.isArray(values.required) ? values.required as string[] : [];
      const copyValues = blueprint ? { ...values, required: requiredValues.filter((key) => !blueprint.fields.includes(key)) } : values;
      const inputSchema = controlled(
        {
          values: copyValues,
          ...entityBindingControlProperties(contract),
          ...(blueprint ? { blueprintId: { type: "string", minLength: 1 }, blueprintBindings: blueprintBindingsSchema } : {}),
        },
        ["values"],
      );
      if (blueprint) {
        inputSchema.allOf = [{
          if: { not: { required: ["blueprintId"] } },
          then: { properties: { values: { required: requiredValues } } },
        }];
      }
      return {
        inputSchema: {
          ...withEntityBindingControls(inputSchema, contract),
          ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
        },
        outputSchema: record,
      };
    }
    case "update": {
      const { values, definitions } = entityValuesSchema(contract, "update", contracts, referentiedata);
      const relatedChanges = relatedUpdateSchema(contract, contracts, (entity, intent) => {
        const nested = entityValuesSchema(entity, intent, contracts, referentiedata);
        Object.assign(definitions, nested.definitions);
        return nested.values;
      });
      const inputSchema = controlled({ id, values, ...entityBindingControlProperties(contract), ...(relatedChanges ? { relatedChanges } : {}) }, ["id", "values"]);
      return {
        inputSchema: {
          ...inputSchema,
          ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
        },
        outputSchema: nullableRecord,
      };
    }
    case "delete":
      return {
        inputSchema: controlled({ id }, ["id"]),
        outputSchema: {
          type: "object",
          properties: { deleted: { type: "boolean" } },
          required: ["deleted"],
          additionalProperties: false,
        },
      };
  }
}
