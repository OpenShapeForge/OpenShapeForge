// SPDX-License-Identifier: BUSL-1.1
/**
 * Field → JSON Schema mappings shared by every surface that publishes a
 * schema.
 *
 * Connector operation fields use the structural constraint core. Compiled
 * entity fields additionally use the rich projector at the bottom of this
 * file, shared by MCP and OpenAPI. If either transport mapped `maxLength`,
 * nested shapes, or enumerations independently, their advertised contracts
 * would drift even though they came from the same authored field.
 *
 * The rich projector is still a projection, not a second semantic model. Its
 * only inputs are the existing `CompiledField` and the already-resolved core
 * reference-data snapshot.
 */

import type { CompiledField } from "./authoring/types.js";
import type { LocalizedText } from "./authoring/types/common.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";

export type JsonObject = Record<string, unknown>;

/**
 * The structural minimum this mapping reads. Both `CompiledField` (compiled
 * entity model) and `FieldV2` (authored connector operation fields) satisfy it,
 * so neither consumer has to convert.
 */
export type SchemaSourceField = {
  key: string;
  valueType?: string;
  cardinality?: unknown;
  required?: boolean;
  validation?: {
    minLength?: unknown;
    maxLength?: unknown;
    min?: unknown;
    max?: unknown;
    pattern?: unknown;
    format?: string;
    minItems?: unknown;
  };
};

/** Unwrap `x` or `{ value: x }` — validation rules carry either. */
export function ruleValue(rule: unknown): number | string | boolean | undefined {
  if (rule === undefined || rule === null) return undefined;
  if (typeof rule === "object" && "value" in (rule as JsonObject)) {
    const inner = (rule as { value: unknown }).value;
    return typeof inner === "number" || typeof inner === "string" || typeof inner === "boolean"
      ? inner
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

export function baseTypeFor(field: SchemaSourceField): JsonObject {
  switch (field.valueType) {
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "date":
      return { type: "string", format: "date" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "object":
      return { type: "object" };
    case "string":
    default:
      return { type: "string" };
  }
}

/**
 * Base type plus every authored validation bound. Deliberately does NOT add
 * `enum`, `description` or `default` — see the file header on key order.
 */
export function constraintsForField(field: SchemaSourceField): JsonObject {
  const scalar: JsonObject = baseTypeFor(field);
  const validation = field.validation;
  if (!validation) return scalar;

  const minLength = numericRule(validation.minLength);
  const maxLength = numericRule(validation.maxLength);
  const min = numericRule(validation.min);
  const max = numericRule(validation.max);
  const pattern = stringRule(validation.pattern);

  if (minLength !== undefined) scalar.minLength = minLength;
  if (maxLength !== undefined) scalar.maxLength = maxLength;
  if (min !== undefined) scalar.minimum = min;
  if (max !== undefined) scalar.maximum = max;
  if (pattern !== undefined) scalar.pattern = pattern;
  // `format: uuid` is both a JSON Schema format and the signal the storage
  // layer uses to pick a uuid column, so it carries through unchanged.
  if (validation.format !== undefined) scalar.format = validation.format;

  return scalar;
}

export function isCollection(field: SchemaSourceField): boolean {
  return field.cardinality === "collection";
}

/**
 * Wrap a finished scalar schema as an array. The scalar shape becomes the item
 * shape; a description on the array itself is more useful than one buried in
 * `items`.
 */
export function applyCollectionShape(
  scalar: JsonObject,
  field: SchemaSourceField,
): JsonObject {
  const { description, ...items } = scalar;
  const array: JsonObject = { type: "array", items };
  if (description !== undefined) array.description = description;
  const minItems = numericRule(field.validation?.minItems);
  if (minItems !== undefined) array.minItems = minItems;
  return array;
}

/**
 * Assemble an object schema from per-field schemas. `additionalProperties` is
 * always false: an unknown property is a caller error worth surfacing, not
 * something to drop silently.
 */
export function objectSchemaFrom(
  fields: SchemaSourceField[],
  schemaForField: (field: SchemaSourceField) => JsonObject,
  options: { requireRequired: boolean },
): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.key] = schemaForField(field);
    if (options.requireRequired && field.required) {
      required.push(field.key);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function localizedText(value: LocalizedText | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  return (value.en ?? value.nl ?? value.fr)?.trim() || undefined;
}

/**
 * Compose the stable, human-facing description shared by generated transport
 * schemas. Transport-specific instructions are deliberately added by the
 * consumer instead of leaking into every projection.
 */
export function describeCompiledField(field: CompiledField): string | undefined {
  const parts: string[] = [];
  const label = localizedText(field.label);
  const description = localizedText(field.description);
  const help = localizedText(field.help);

  if (description) {
    parts.push(description);
  } else if (label) {
    parts.push(label);
  }
  if (help) parts.push(help);
  if (field.unit) parts.push(`Unit: ${field.unit}.`);
  if (field.relationship?.entity) {
    parts.push(`References the ${field.relationship.entity} entity.`);
  }
  if (field.computed?.expression) {
    parts.push("Derived server-side; any supplied value is ignored.");
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

export type CompiledFieldDescription = (field: CompiledField) => string | undefined;

export type CompiledFieldSchemaOptions = {
  describeField?: CompiledFieldDescription;
};

export type CompiledFieldEnumeration = {
  values: string[];
  labels: Map<string, string>;
};

/**
 * Resolve the two authoring spellings currently in the corpus. `options` is
 * canonical; `render.props.referentieGroep` remains a compatibility fallback
 * until those fields are normalized without changing unrelated generated UI.
 */
export function resolveCompiledFieldEnumeration(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot,
): CompiledFieldEnumeration | undefined {
  const options = field.options;
  const renderGroep = field.render?.props?.referentieGroep;

  if (options?.type === "static" && options.items && options.items.length > 0) {
    return {
      values: options.items.map((item) => item.value),
      labels: new Map(
        options.items.flatMap((item) => {
          const label = localizedText(item.label);
          return label ? [[item.value, label] as const] : [];
        }),
      ),
    };
  }

  const groep =
    options?.type === "referentiedata" && options.referentieGroep
      ? options.referentieGroep
      : typeof renderGroep === "string"
        ? renderGroep
        : undefined;
  if (!groep) return undefined;

  const items = referentiedata[groep] ?? [];
  if (items.length === 0) return undefined;
  return {
    values: items.map((item) => item.value),
    labels: new Map(
      items.flatMap((item) => {
        const label = localizedText(item.label);
        return label ? [[item.value, label] as const] : [];
      }),
    ),
  };
}

function compiledValueSchema(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot,
  options: CompiledFieldSchemaOptions,
): JsonObject {
  if (field.valueType === "object" && field.children && field.children.length > 0) {
    return compiledObjectSchema(field.children, referentiedata, {
      requireRequired: true,
      ...(options.describeField ? { describeField: options.describeField } : {}),
    });
  }
  return constraintsForField(field);
}

function addCompiledFieldMetadata(
  schema: JsonObject,
  field: CompiledField,
  enumeration: CompiledFieldEnumeration | undefined,
  describeField: CompiledFieldDescription,
): JsonObject {
  const title = localizedText(field.label);
  if (title) {
    schema.title = title;
  }
  if (enumeration) {
    schema.enum = enumeration.values;
  }

  const descriptionParts: string[] = [];
  const fieldDescription = describeField(field);
  if (fieldDescription) descriptionParts.push(fieldDescription);
  if (enumeration && enumeration.labels.size > 0) {
    const rendered = enumeration.values
      .map((value) => {
        const label = enumeration.labels.get(value);
        return label ? `${value} (${label})` : value;
      })
      .join(", ");
    descriptionParts.push(`Allowed values: ${rendered}.`);
  }
  if (descriptionParts.length > 0) {
    schema.description = descriptionParts.join(" ");
  }

  if (field.defaultValue !== undefined) {
    schema.default = field.defaultValue;
  }
  return schema;
}

/** Project one resolved entity field into deterministic JSON Schema. */
export function compiledFieldSchema(
  field: CompiledField,
  referentiedata: CoreReferentiedataSnapshot = {},
  options: CompiledFieldSchemaOptions = {},
): JsonObject {
  const describeField = options.describeField ?? describeCompiledField;
  const enumeration = resolveCompiledFieldEnumeration(field, referentiedata);
  const valueSchema = addCompiledFieldMetadata(
    compiledValueSchema(field, referentiedata, options),
    field,
    enumeration,
    describeField,
  );

  if (!isCollection(field)) {
    return valueSchema;
  }

  const { title, description, default: defaultValue, ...outerItemSchema } = valueSchema;
  const items = field.item
    ? compiledFieldSchema(field.item, referentiedata, options)
    : outerItemSchema;
  const array: JsonObject = { type: "array", items };
  if (title !== undefined) array.title = title;
  if (description !== undefined) array.description = description;
  if (defaultValue !== undefined) array.default = defaultValue;
  const minItems = numericRule(field.validation?.minItems);
  const cardinalityMin = field.cardinalityBounds?.min;
  const effectiveMinItems =
    minItems === undefined
      ? cardinalityMin
      : cardinalityMin === undefined
        ? minItems
        : Math.max(minItems, cardinalityMin);
  if (effectiveMinItems !== undefined) array.minItems = effectiveMinItems;
  const cardinalityMax = field.cardinalityBounds?.max;
  if (typeof cardinalityMax === "number") array.maxItems = cardinalityMax;
  return array;
}

/** Project a resolved field list into an object request/value schema. */
export function compiledObjectSchema(
  fields: CompiledField[],
  referentiedata: CoreReferentiedataSnapshot = {},
  options: { requireRequired: boolean } & CompiledFieldSchemaOptions,
): JsonObject {
  return objectSchemaFrom(
    fields,
    (field) => compiledFieldSchema(field as CompiledField, referentiedata, options),
    options,
  );
}
