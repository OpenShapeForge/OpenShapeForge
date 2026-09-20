// SPDX-License-Identifier: BUSL-1.1

/**
 * The one FieldDefinition to JSON Schema projection.
 *
 * The compiler projects its resolved entity fields through `fieldSchema` and
 * `objectSchema`; the runtime plugin host resolves a stored definition through
 * the host registries (`resolveFields`) and projects it through the same two
 * functions. A plugin supplies only authored FieldDefinitions and can never
 * replace those registries with a private interpretation.
 *
 * Key order is part of the contract: generated artifacts are compared byte
 * for byte, so a schema is assembled in one fixed order — structural
 * constraints, `x-osf-i18n`, `title`, `x-osf-type`, `enum`, `x-osf-reference`,
 * `description`, `default`, then the collection wrapper and its bounds.
 * `x-osf-type` is stamped here and nowhere else.
 */

import type {
  OperationFieldDefinition,
  OperationFieldSchemaOptions,
  OperationFieldSchemaRegistry,
  OperationJsonSchema,
  ResolvedOperationField,
} from "./field-schema-types.js";
import { localizedText, resolveFields, typedEnumValues } from "./field-resolution.js";
import { collectionBounds, constrainedType, describeField, fieldEnumeration, type FieldEnumeration } from "./field-schema-metadata.js";

export type {
  OperationFieldBaseType,
  OperationFieldCardinality,
  OperationFieldDefinition,
  OperationFieldOptions,
  OperationFieldOsfType,
  OperationFieldRelationship,
  OperationFieldSchemaOptions,
  OperationFieldSchemaRegistry,
  OperationFieldValidation,
  OperationJsonSchema,
  OperationLocalizedText,
  OperationReferenceConstraints,
  ResolvedOperationField,
} from "./field-schema-types.js";

export {
  cardinalityOf,
  isBaseType,
  localizedText,
  numericRule,
  resolveFieldBaseType,
  resolveFields,
  ruleValue,
  stringRule,
  typedEnumValues,
  type ResolvedCardinality,
} from "./field-resolution.js";
export {
  collectionBounds,
  collectionShape,
  constrainedType,
  describeField,
  fieldEnumeration,
  type DescribeFieldOptions,
  type FieldEnumeration,
} from "./field-schema-metadata.js";

function valueSchema(
  field: ResolvedOperationField,
  registry: OperationFieldSchemaRegistry,
  options: OperationFieldSchemaOptions,
): OperationJsonSchema {
  if (field.schema) return structuredClone(field.schema) as OperationJsonSchema;
  if (field.baseType === "object" && field.children?.length) {
    return objectSchema(field.children, registry, { ...options, requireRequired: options.requireNestedRequired ?? true });
  }
  return constrainedType(field);
}

function withFieldMetadata(
  schema: OperationJsonSchema,
  field: ResolvedOperationField,
  enumeration: FieldEnumeration | undefined,
  options: OperationFieldSchemaOptions,
): OperationJsonSchema {
  const title = localizedText(field.label);
  // Authored UI copy stays apart from transport documentation and validation.
  const copy: OperationJsonSchema = {};
  if (field.label && typeof field.label === "object") copy.title = field.label;
  if (enumeration) copy.enum = enumeration.uiLabels;
  const help = field.help ?? field.description;
  if (help && typeof help === "object") copy.description = help;
  if (Object.keys(copy).length) schema["x-osf-i18n"] = copy;
  if (title) schema.title = title;
  // The type a form renders the property through; the JSON type beside it is what validates.
  schema["x-osf-type"] = field.osfType;
  if (enumeration) schema.enum = typedEnumValues(enumeration.values, field.baseType);
  if (field.options?.type === "entity") {
    if (!field.options.source?.trim()) throw new Error(`Entity options for ${field.key} require a source.`);
    schema["x-osf-reference"] = { entity: field.options.source, valueField: field.options.valueField ?? "id" };
  }
  if (field.relationship?.target) {
    schema["x-osf-reference"] = {
      entity: field.relationship.target,
      valueField: "id",
      ...(field.relationship.constraints ? { constraints: structuredClone(field.relationship.constraints) } : {}),
    };
  }
  const descriptionParts: string[] = [];
  const fieldDescription = (options.describeField ?? describeField)(field);
  if (fieldDescription) descriptionParts.push(fieldDescription);
  if (enumeration && enumeration.labels.size > 0) {
    const rendered = enumeration.values.map((value) => {
      const label = enumeration.labels.get(value);
      return label ? `${value} (${label})` : value;
    }).join(", ");
    descriptionParts.push(`Allowed values: ${rendered}.`);
  }
  if (descriptionParts.length > 0) schema.description = descriptionParts.join(" ");
  if (field.defaultValue !== undefined && options.includeDefault !== false) schema.default = field.defaultValue;
  return schema;
}

/** Project one resolved field into deterministic JSON Schema, without bundled definitions. */
export function fieldSchema(
  field: ResolvedOperationField,
  registry: OperationFieldSchemaRegistry = {},
  options: OperationFieldSchemaOptions = {},
): OperationJsonSchema {
  const schema = withFieldMetadata(valueSchema(field, registry, options), field, fieldEnumeration(field, registry), options);
  if (field.cardinality !== "collection") return schema;
  const { title, description, "x-osf-i18n": uiCopy, default: defaultValue, ...outerItemSchema } = schema;
  let items: OperationJsonSchema = field.item
    ? {
        allOf: [outerItemSchema, fieldSchema(field.item, registry, options)],
        // The row node names the row's type whether the item is explicit or not.
        "x-osf-type": field.item.osfType,
      }
    : outerItemSchema;
  const array: OperationJsonSchema = { type: "array", items };
  // The collection is a use of the same type as its items: a form resolves the property, not the row.
  array["x-osf-type"] = field.osfType;
  if (uiCopy !== undefined) array["x-osf-i18n"] = uiCopy;
  if (title !== undefined) array.title = title;
  if (description !== undefined) array.description = description;
  if (defaultValue !== undefined) {
    if (Array.isArray(defaultValue)) {
      array.default = defaultValue;
    } else {
      items = { ...items, default: defaultValue };
      array.items = items;
    }
  }
  return collectionBounds(array, field);
}

/**
 * Assemble an object schema from per-field schemas. `additionalProperties` is
 * always false: an unknown property is a caller error worth surfacing, not
 * something to drop silently.
 */
export function objectSchema(
  fields: readonly ResolvedOperationField[],
  registry: OperationFieldSchemaRegistry = {},
  options: OperationFieldSchemaOptions & { requireRequired: boolean },
): OperationJsonSchema {
  const properties: OperationJsonSchema = {};
  const required: string[] = [];
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) throw new Error(`FieldDefinition key ${JSON.stringify(field.key)} is duplicated.`);
    keys.add(field.key);
    properties[field.key] = fieldSchema(field, registry, options);
    // A default makes a required field omittable only on transports that
    // actually materialize it. Connector contract validators deliberately do
    // not, so their callers keep the stricter boundary.
    if (
      options.requireRequired && field.required &&
      (!options.defaultsAreMaterialized || field.defaultValue === undefined)
    ) required.push(field.key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function referencesDefinitions(value: unknown, definitions: OperationJsonSchema): boolean {
  if (Array.isArray(value)) return value.some((entry) => referencesDefinitions(entry, definitions));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as OperationJsonSchema).some(
    ([key, entry]) =>
      (key === "$ref" && typeof entry === "string" && entry.startsWith("#/$defs/") && Object.hasOwn(definitions, entry.slice("#/$defs/".length))) ||
      referencesDefinitions(entry, definitions),
  );
}

/** Bundle the registry definitions at the root of a schema that refers to one of them. */
export function bundleDefinitions(
  schema: OperationJsonSchema,
  registry: Pick<OperationFieldSchemaRegistry, "fieldDefinitionDefinitions">,
): OperationJsonSchema {
  if (!registry.fieldDefinitionDefinitions || !referencesDefinitions(schema, registry.fieldDefinitionDefinitions)) return schema;
  const existing = schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)
    ? (schema.$defs as OperationJsonSchema)
    : {};
  return { ...schema, $defs: { ...existing, ...structuredClone(registry.fieldDefinitionDefinitions) } };
}

export function operationFieldSchema(
  field: OperationFieldDefinition,
  registry: OperationFieldSchemaRegistry = {},
  options: OperationFieldSchemaOptions = {},
): OperationJsonSchema {
  return bundleDefinitions(fieldSchema(resolveFields([field], registry)[0]!, registry, options), registry);
}

export function operationFieldObjectSchema(
  fields: readonly OperationFieldDefinition[],
  registry: OperationFieldSchemaRegistry = {},
  options: OperationFieldSchemaOptions & { requireRequired?: boolean } = {},
): OperationJsonSchema {
  const { requireRequired = true, ...schemaOptions } = options;
  return bundleDefinitions(
    objectSchema(resolveFields(fields, registry), registry, { ...schemaOptions, requireRequired }),
    registry,
  );
}
