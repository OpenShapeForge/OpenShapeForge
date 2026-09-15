// SPDX-License-Identifier: BUSL-1.1

/**
 * Transport-neutral FieldDefinition to JSON Schema projection.
 *
 * The compiler and runtime plugin host both call this implementation. The
 * host supplies the resolved semantic-type and reference-data registries; a
 * plugin supplies only authored FieldDefinitions and can never replace those
 * registries with a private interpretation.
 */

export type OperationJsonSchema = Record<string, unknown>;
export type OperationLocalizedText = string | Readonly<{
  en?: string;
  nl?: string;
  fr?: string;
}>;

export type OperationFieldValidation = {
  minLength?: unknown;
  maxLength?: unknown;
  min?: unknown;
  max?: unknown;
  pattern?: unknown;
  format?: string;
  minItems?: unknown;
};

export type OperationFieldOptions = {
  type: "static" | "referentiedata" | "remote" | "dynamic";
  items?: readonly {
    value: string;
    label: OperationLocalizedText;
  }[];
  referentieGroep?: string;
};

export type OperationFieldDefinition = {
  key: string;
  valueType?: "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "object";
  cardinality?: "single" | "collection" | { min?: number; max?: number | "unbounded" };
  required?: boolean;
  label?: OperationLocalizedText;
  description?: OperationLocalizedText;
  help?: OperationLocalizedText;
  semanticType?: string;
  unit?: string;
  defaultValue?: unknown;
  validation?: OperationFieldValidation;
  options?: OperationFieldOptions;
  reference?: { kind?: string; group?: string };
  render?: { props?: Readonly<Record<string, unknown>> };
  relationship?: { entity?: string };
  computed?: { expression?: string };
  shape?: readonly OperationFieldDefinition[];
  children?: readonly OperationFieldDefinition[];
  item?: OperationFieldDefinition;
};

export type OperationFieldSemanticType = {
  kind?: string;
  entity?: string;
  valueType: OperationFieldDefinition["valueType"];
  cardinality?: OperationFieldDefinition["cardinality"];
  label?: OperationLocalizedText;
  validation?: OperationFieldValidation;
  shape?: readonly OperationFieldDefinition[];
  children?: readonly OperationFieldDefinition[];
  item?: OperationFieldDefinition;
};

export type OperationFieldSchemaRegistry = {
  semanticTypes?: Readonly<Record<string, OperationFieldSemanticType>>;
  referentiedata?: Readonly<Record<string, readonly {
    value: string;
    label: OperationLocalizedText;
  }[]>>;
  /** Self-contained definitions used by the recursive fieldDefinition type. */
  fieldDefinitionDefinitions?: OperationJsonSchema;
};

export type OperationFieldSchemaOptions = {
  includeDefault?: boolean;
  requireNestedRequired?: boolean;
  defaultsAreMaterialized?: boolean;
};

type ResolvedOperationField = {
  key: string;
  valueType: NonNullable<OperationFieldDefinition["valueType"]>;
  cardinality: "single" | "collection";
  cardinalityBounds?: { min?: number; max?: number | "unbounded" };
  required: boolean;
  label: OperationLocalizedText;
  description?: OperationLocalizedText;
  help?: OperationLocalizedText;
  semanticType?: string;
  unit?: string;
  defaultValue?: unknown;
  validation?: OperationFieldValidation;
  options?: OperationFieldOptions;
  relationship?: { entity?: string };
  computed?: { expression?: string };
  children?: ResolvedOperationField[];
  item?: ResolvedOperationField;
};

function localizedText(value: OperationLocalizedText | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  return (value.en ?? value.nl ?? value.fr)?.trim() || undefined;
}

function ruleValue(rule: unknown): number | string | boolean | undefined {
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

function numericRule(rule: unknown): number | undefined {
  const value = ruleValue(rule);
  return typeof value === "number" ? value : undefined;
}

function stringRule(rule: unknown): string | undefined {
  const value = ruleValue(rule);
  return typeof value === "string" ? value : undefined;
}

function cardinalityOf(
  value: OperationFieldDefinition["cardinality"],
): "single" | "collection" {
  if (value === "collection") return "collection";
  if (value && typeof value === "object" &&
    (value.max === "unbounded" || (typeof value.max === "number" && value.max > 1))) {
    return "collection";
  }
  return "single";
}

function resolveOptions(field: OperationFieldDefinition): OperationFieldOptions | undefined {
  if (field.options) return field.options;
  const group = field.reference?.kind === "referentiedata" && field.reference.group
    ? field.reference.group
    : typeof field.render?.props?.referentieGroep === "string"
      ? field.render.props.referentieGroep
      : undefined;
  return group ? { type: "referentiedata", referentieGroep: group } : undefined;
}

function resolveFields(
  fields: readonly OperationFieldDefinition[],
  registry: OperationFieldSchemaRegistry,
): ResolvedOperationField[] {
  return fields.map((field) => {
    const semantic = field.semanticType
      ? registry.semanticTypes?.[field.semanticType]
      : undefined;
    const authoredCardinality = field.cardinality ?? semantic?.cardinality;
    const nested = field.shape ?? field.children ?? semantic?.shape ?? semantic?.children;
    const item = field.item ?? semantic?.item;
    const options = resolveOptions(field);
    return {
      key: field.key,
      valueType: field.valueType ?? semantic?.valueType ?? "string",
      cardinality: cardinalityOf(authoredCardinality),
      ...(authoredCardinality && typeof authoredCardinality === "object"
        ? { cardinalityBounds: { ...authoredCardinality } }
        : {}),
      required: field.required ?? false,
      label: field.label ?? semantic?.label ?? { en: field.key, nl: field.key },
      ...(field.description !== undefined ? { description: field.description } : {}),
      ...(field.help !== undefined ? { help: field.help } : {}),
      ...(field.semanticType !== undefined ? { semanticType: field.semanticType } : {}),
      ...(field.unit !== undefined ? { unit: field.unit } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      ...(field.validation ?? semantic?.validation
        ? { validation: field.validation ?? semantic!.validation! }
        : {}),
      ...(options ? { options } : {}),
      ...(semantic?.kind === "entity" && semantic.entity ? { relationship: { entity: semantic.entity } } : field.relationship ? { relationship: field.relationship } : {}),
      ...(field.computed ? { computed: field.computed } : {}),
      ...(nested ? { children: resolveFields(nested, registry) } : {}),
      ...(item ? { item: resolveFields([item], registry)[0] } : {}),
    };
  });
}

function baseType(field: ResolvedOperationField): OperationJsonSchema {
  switch (field.valueType) {
    case "boolean": return { type: "boolean" };
    case "integer": return { type: "integer" };
    case "number": return { type: "number" };
    case "date": return { type: "string", format: "date" };
    case "datetime": return { type: "string", format: "date-time" };
    case "object": return { type: "object" };
    default: return { type: "string" };
  }
}

function constrainedType(field: ResolvedOperationField): OperationJsonSchema {
  const schema = baseType(field);
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
  if (validation.format !== undefined) schema.format = validation.format;
  return schema;
}

function collectionBounds(
  schema: OperationJsonSchema,
  field: ResolvedOperationField,
): OperationJsonSchema {
  const minItems = numericRule(field.validation?.minItems);
  const cardinalityMin = field.cardinalityBounds?.min;
  const effectiveMin = minItems === undefined
    ? cardinalityMin
    : cardinalityMin === undefined
      ? minItems
      : Math.max(minItems, cardinalityMin);
  if (effectiveMin !== undefined) schema.minItems = effectiveMin;
  if (typeof field.cardinalityBounds?.max === "number") {
    schema.maxItems = field.cardinalityBounds.max;
  }
  return schema;
}

function enumeration(
  field: ResolvedOperationField,
  registry: OperationFieldSchemaRegistry,
): { values: string[]; labels: Map<string, string> } | undefined {
  const options = field.options;
  const items = options?.type === "static" && options.items?.length
    ? options.items
    : options?.type === "referentiedata" && options.referentieGroep
      ? registry.referentiedata?.[options.referentieGroep]
      : undefined;
  if (!items?.length) return undefined;
  return {
    values: items.map(({ value }) => value),
    labels: new Map(items.flatMap((item) => {
      const label = localizedText(item.label);
      return label ? [[item.value, label] as const] : [];
    })),
  };
}

function objectSchema(
  fields: readonly ResolvedOperationField[],
  registry: OperationFieldSchemaRegistry,
  options: OperationFieldSchemaOptions & { requireRequired: boolean },
): OperationJsonSchema {
  const properties: OperationJsonSchema = Object.create(null) as OperationJsonSchema;
  const required: string[] = [];
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) {
      throw new Error(`FieldDefinition key ${JSON.stringify(field.key)} is duplicated.`);
    }
    keys.add(field.key);
    properties[field.key] = fieldSchema(field, registry, options);
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

function fieldSchema(
  field: ResolvedOperationField,
  registry: OperationFieldSchemaRegistry,
  options: OperationFieldSchemaOptions,
): OperationJsonSchema {
  let schema = field.semanticType === "fieldDefinition"
    ? { $ref: "#/$defs/fieldDefinition" }
    : field.valueType === "object" && field.children?.length
      ? objectSchema(field.children, registry, {
          ...options,
          requireRequired: options.requireNestedRequired ?? true,
        })
      : constrainedType(field);
  const title = localizedText(field.label);
  if (field.relationship?.entity) schema["x-osf-reference"] = { entity: field.relationship.entity };
  if (title) schema.title = title;
  const values = enumeration(field, registry);
  if (values) schema.enum = values.values;
  const descriptionParts = [
    localizedText(field.description) ?? title,
    localizedText(field.help),
    field.unit ? `Unit: ${field.unit}.` : undefined,
    field.relationship?.entity
      ? `References the ${field.relationship.entity} entity.`
      : undefined,
    field.computed?.expression
      ? "Derived server-side; any supplied value is ignored."
      : undefined,
    values && values.labels.size > 0
      ? `Allowed values: ${values.values.map((value) => {
          const label = values.labels.get(value);
          return label ? `${value} (${label})` : value;
        }).join(", ")}.`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  if (descriptionParts.length > 0) schema.description = descriptionParts.join(" ");
  if (field.defaultValue !== undefined && options.includeDefault !== false) {
    schema.default = field.defaultValue;
  }
  if (field.cardinality !== "collection") return schema;
  const { title: itemTitle, description, default: defaultValue, ...itemSchema } = schema;
  const item = field.item
    ? { allOf: [itemSchema, fieldSchema(field.item, registry, options)] }
    : itemSchema;
  const collection = collectionBounds({ type: "array", items: item }, field);
  if (itemTitle !== undefined) collection.title = itemTitle;
  if (description !== undefined) collection.description = description;
  if (defaultValue !== undefined) {
    if (Array.isArray(defaultValue)) collection.default = defaultValue;
    else (collection.items as OperationJsonSchema).default = defaultValue;
  }
  return collection;
}

function bundleDefinitions(
  schema: OperationJsonSchema,
  registry: OperationFieldSchemaRegistry,
): OperationJsonSchema {
  const usesFieldDefinition = JSON.stringify(schema).includes('"#/$defs/fieldDefinition"');
  return usesFieldDefinition && registry.fieldDefinitionDefinitions
    ? { ...schema, $defs: structuredClone(registry.fieldDefinitionDefinitions) }
    : schema;
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
