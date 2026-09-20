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
  OperationFieldBaseType,
  OperationFieldCardinality,
  OperationFieldDefinition,
  OperationFieldOptions,
  OperationFieldOsfType,
  OperationFieldSchemaOptions,
  OperationFieldSchemaRegistry,
  OperationJsonSchema,
  OperationLocalizedText,
  ResolvedOperationField,
} from "./field-schema-types.js";

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

export function localizedText(value: OperationLocalizedText | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  // An empty English string is absent, not a translation that hides the Dutch one.
  return [value.en, value.nl, value.fr].map((text) => text?.trim()).find((text) => text) || undefined;
}

/**
 * Authored option values are strings (the authoring schema admits nothing
 * else); an enumeration on a typed field carries the values in that type, so
 * `{ type: integer, enum: [1] }` validates what a client sends. A value that
 * does not convert exactly (`yes` on a boolean, `1.5` or an unsafe integer on
 * an integer) is an authoring error, never a string smuggled into a typed
 * enumeration.
 */
export function typedEnumValues(values: readonly string[], baseType: string | undefined): (string | number | boolean)[] {
  return values.map((value) => {
    const text = value.trim();
    if (baseType === "integer") {
      if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`Enumeration value ${JSON.stringify(value)} is not a safe integer.`);
      return Number(text);
    }
    if (baseType === "number") {
      if (text === "" || !Number.isFinite(Number(text))) throw new Error(`Enumeration value ${JSON.stringify(value)} is not a finite number.`);
      return Number(text);
    }
    if (baseType === "boolean") {
      if (text !== "true" && text !== "false") throw new Error(`Enumeration value ${JSON.stringify(value)} is not a boolean.`);
      return text === "true";
    }
    return value;
  });
}

/** Unwrap `x` or `{ value: x }` — validation rules carry either. */
export function ruleValue(rule: unknown): number | string | boolean | undefined {
  if (rule === undefined || rule === null) return undefined;
  if (typeof rule === "object" && "value" in (rule as OperationJsonSchema)) {
    const value = (rule as { value: unknown }).value;
    return typeof value === "number" || typeof value === "string" || typeof value === "boolean"
      ? value
      : undefined;
  }
  return typeof rule === "number" || typeof rule === "string" || typeof rule === "boolean"
    ? rule
    : undefined;
}

export function numericRule(rule: unknown): number | undefined {
  const value = ruleValue(rule);
  return typeof value === "number" ? value : undefined;
}

export function stringRule(rule: unknown): string | undefined {
  const value = ruleValue(rule);
  return typeof value === "string" ? value : undefined;
}

export type ResolvedCardinality = {
  cardinality: "single" | "collection";
  /** The exact authored bounds; only a collection keeps them. */
  bounds?: { min?: number; max?: number | "unbounded" };
  /** A lower bound of one or more means the value cannot be omitted. */
  required: boolean;
};

/**
 * The one reading of `cardinality`, shared by the compiler, the runtime
 * projector and the documents engine: `single`, `collection`, or exact
 * bounds. Bounds are integers, `min` is at least zero, `max` is `unbounded`
 * or at least `max(1, min)`; `max` above one is a collection; `min >= 1`
 * makes the field required. Invalid bounds are an authoring error.
 */
export function cardinalityOf(value: OperationFieldCardinality | undefined, path = "cardinality"): ResolvedCardinality {
  if (value === undefined || value === "single") return { cardinality: "single", required: false };
  if (value === "collection") return { cardinality: "collection", required: false };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path}: invalid cardinality bounds.`);
  }
  const min = value.min ?? 0;
  const max = value.max ?? 1;
  if (
    !Number.isSafeInteger(min) || min < 0 ||
    (max !== "unbounded" && (!Number.isSafeInteger(max) || max < Math.max(1, min)))
  ) {
    throw new Error(`${path}: invalid cardinality bounds.`);
  }
  const collection = max === "unbounded" || max > 1;
  return {
    cardinality: collection ? "collection" : "single",
    ...(collection ? { bounds: { ...value } } : {}),
    required: min >= 1,
  };
}

const BASE_TYPES: readonly OperationFieldBaseType[] = ["string", "integer", "number", "boolean", "date", "datetime", "object"];

export function isBaseType(value: string | undefined): value is OperationFieldBaseType {
  return (BASE_TYPES as readonly string[]).includes(value ?? "");
}

/**
 * A base osfType is its own base; a catalog key resolves through the
 * registry. Anything else is unknown — refused, never projected as a string.
 */
export function resolveFieldBaseType(
  field: { key: string; osfType: string },
  osfTypes: OperationFieldSchemaRegistry["osfTypes"] = {},
): OperationFieldBaseType {
  if (isBaseType(field.osfType)) return field.osfType;
  const semantic = Object.hasOwn(osfTypes, field.osfType) ? osfTypes[field.osfType] : undefined;
  if (!semantic || !isBaseType(semantic.baseType)) {
    throw new Error(`${field.key}: unknown osfType ${field.osfType}.`);
  }
  return semantic.baseType;
}

function slug(entity: string): string {
  return entity.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * The two authoring spellings in the corpus: `options` is canonical;
 * `render.props.referentieGroep` remains a compatibility fallback until those
 * fields are normalized without changing unrelated generated UI.
 */
function resolveOptions(field: OperationFieldDefinition, semantic: OperationFieldOsfType | undefined): OperationFieldOptions | undefined {
  if (field.options) return field.options;
  if (field.reference?.kind === "referentiedata" && field.reference.group) {
    return { type: "referentiedata", referentieGroep: field.reference.group };
  }
  return semantic?.options;
}

/** Resolve stored or plugin-authored definitions against the host registries. */
export function resolveFields(
  fields: readonly OperationFieldDefinition[],
  registry: OperationFieldSchemaRegistry,
  ancestry: readonly string[] = [],
): ResolvedOperationField[] {
  return fields.map((field) => {
    const semantic = isBaseType(field.osfType) || !registry.osfTypes || !Object.hasOwn(registry.osfTypes, field.osfType)
      ? undefined
      : registry.osfTypes[field.osfType];
    const baseType = resolveFieldBaseType(field, registry.osfTypes);
    const path = [...ancestry, field.key].join(".");
    const { cardinality, bounds, required } = cardinalityOf(field.cardinality ?? semantic?.cardinality, path);
    // An identity reference does not inline the target record (which may refer back).
    const nested = field.shape ?? field.children ?? (semantic?.kind === "entity" && semantic.entity
      ? undefined : semantic?.shape ?? semantic?.children);
    const item = field.item ?? semantic?.item;
    const options = resolveOptions(field, semantic);
    const validation = semantic?.validation || field.validation
      ? { ...semantic?.validation, ...field.validation }
      : undefined;
    const target = semantic?.kind === "entity" ? semantic.entity : undefined;
    return {
      key: field.key,
      osfType: field.osfType,
      baseType,
      cardinality,
      ...(bounds ? { cardinalityBounds: bounds } : {}),
      required: field.required === true || required,
      label: field.label ?? semantic?.label ?? { en: field.key, nl: field.key },
      ...(field.description !== undefined ? { description: field.description } : {}),
      ...(field.help !== undefined ? { help: field.help } : {}),
      ...(field.unit !== undefined ? { unit: field.unit } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      ...(validation ? { validation } : {}),
      ...(options ? { options } : {}),
      ...(field.render ? { render: field.render } : {}),
      ...(target
        ? { relationship: { kind: cardinality === "collection" ? "hasMany" : "belongsTo", entity: slug(target), target, ...(field.relationship?.constraints ? { constraints: field.relationship.constraints } : {}) } }
        : field.relationship
          ? { relationship: field.relationship }
          : {}),
      ...(field.computed ? { computed: field.computed } : {}),
      ...(semantic?.schema ? { schema: semantic.schema } : {}),
      ...(nested ? { children: resolveFields(nested, registry, [...ancestry, field.key]) } : {}),
      ...(item ? { item: resolveFields([item], registry, [...ancestry, field.key])[0] } : {}),
    };
  });
}

function baseTypeSchema(field: Pick<ResolvedOperationField, "baseType">): OperationJsonSchema {
  switch (field.baseType) {
    case "boolean": return { type: "boolean" };
    case "integer": return { type: "integer" };
    case "number": return { type: "number" };
    case "date": return { type: "string", format: "date" };
    case "datetime": return { type: "string", format: "date-time" };
    case "object": return { type: "object" };
    default: return { type: "string" };
  }
}

/**
 * Base type plus every authored validation bound. Deliberately does NOT add
 * `enum`, `description` or `default` — see the file header on key order.
 */
export function constrainedType(field: Pick<ResolvedOperationField, "baseType" | "validation">): OperationJsonSchema {
  const schema = baseTypeSchema(field);
  const validation = field.validation;
  if (!validation) return schema;
  const minLength = numericRule(validation.minLength);
  const maxLength = numericRule(validation.maxLength);
  const minimum = numericRule(validation.min);
  const maximum = numericRule(validation.max);
  const pattern = stringRule(validation.pattern);
  if (minLength !== undefined) schema.minLength = minLength;
  if (maxLength !== undefined) schema.maxLength = maxLength;
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
  if (pattern !== undefined) schema.pattern = pattern;
  // `format: uuid` is both a JSON Schema format and the signal the storage
  // layer uses to pick a uuid column, so it carries through unchanged.
  if (validation.format !== undefined) schema.format = validation.format;
  return schema;
}

export function collectionBounds(
  array: OperationJsonSchema,
  field: Pick<ResolvedOperationField, "validation" | "cardinalityBounds">,
): OperationJsonSchema {
  const minItems = numericRule(field.validation?.minItems);
  const cardinalityMin = field.cardinalityBounds?.min;
  const effectiveMin = minItems === undefined
    ? cardinalityMin
    : cardinalityMin === undefined
      ? minItems
      : Math.max(minItems, cardinalityMin);
  if (effectiveMin !== undefined) array.minItems = effectiveMin;
  if (typeof field.cardinalityBounds?.max === "number") {
    array.maxItems = field.cardinalityBounds.max;
  }
  return array;
}

/**
 * Wrap a finished scalar schema as an array. The scalar shape becomes the item
 * shape; a description on the array itself is more useful than one buried in
 * `items`.
 */
export function collectionShape(
  scalar: OperationJsonSchema,
  field: Pick<ResolvedOperationField, "validation" | "cardinalityBounds">,
): OperationJsonSchema {
  const { description, ...items } = scalar;
  const array: OperationJsonSchema = { type: "array", items };
  if (items["x-osf-type"] !== undefined) array["x-osf-type"] = items["x-osf-type"];
  if (description !== undefined) array.description = description;
  return collectionBounds(array, field);
}

export type FieldEnumeration = {
  values: string[];
  labels: Map<string, string>;
  /** Authored labels kept per language for `x-osf-i18n`. */
  uiLabels: Record<string, Exclude<OperationLocalizedText, string>>;
};

export function fieldEnumeration(
  field: Pick<ResolvedOperationField, "options" | "render">,
  registry: Pick<OperationFieldSchemaRegistry, "referentiedata">,
): FieldEnumeration | undefined {
  const options = field.options;
  const renderGroep = field.render?.props?.referentieGroep;
  const groep = options?.type === "referentiedata" && options.referentieGroep
    ? options.referentieGroep
    : typeof renderGroep === "string"
      ? renderGroep
      : undefined;
  const items = options?.type === "static" && options.items?.length
    ? options.items
    : groep
      ? registry.referentiedata?.[groep]
      : undefined;
  if (!items?.length) return undefined;
  return {
    values: items.map(({ value }) => value),
    labels: new Map(items.flatMap((item) => {
      const label = localizedText(item.label);
      return label ? [[item.value, label] as const] : [];
    })),
    uiLabels: Object.fromEntries(items.flatMap((item) =>
      item.label && typeof item.label === "object" ? [[item.value, item.label] as const] : [],
    )),
  };
}

export type DescribeFieldOptions = {
  relationshipInstruction?: string;
};

/**
 * The stable, human-facing description shared by generated transport
 * schemas. Transport-specific instructions are deliberately added by the
 * consumer instead of leaking into every projection.
 */
export function describeField(
  field: Pick<ResolvedOperationField, "label" | "description" | "help" | "unit" | "relationship" | "computed">,
  options: DescribeFieldOptions = {},
): string | undefined {
  const parts: string[] = [];
  const label = localizedText(field.label);
  const description = localizedText(field.description);
  const help = localizedText(field.help);
  if (description) parts.push(description);
  else if (label) parts.push(label);
  if (help) parts.push(help);
  if (field.unit) parts.push(`Unit: ${field.unit}.`);
  if (field.relationship?.entity) {
    const reference = `References the ${field.relationship.entity} entity`;
    parts.push(options.relationshipInstruction ? `${reference} — ${options.relationshipInstruction}` : `${reference}.`);
  }
  if (field.computed?.expression) parts.push("Derived server-side; any supplied value is ignored.");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

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
