// SPDX-License-Identifier: BUSL-1.1
/**
 * The authored field → JSON Schema constraint mapping, shared by every surface
 * that publishes a schema.
 *
 * Two consumers exist: the MCP tool catalog (what a model is told it may send)
 * and the connector operation schemas (what the runtime validates on both sides
 * of a third-party call). They must agree. If one of them mapped `maxLength`
 * and the other did not, a value would be advertised as acceptable and then
 * rejected — or worse, accepted where the other would have refused.
 *
 * Scope is deliberately narrow: type, format, validation bounds, and the
 * collection wrapper. Enumerations and human-facing descriptions stay with each
 * consumer, because those differ by audience — the MCP catalog composes prose
 * for a model and expands referentiedata groups, neither of which belongs in a
 * validation contract.
 *
 * Callers add `enum`, `description` and `default` themselves, in that order,
 * so the emitted key order stays stable per surface.
 */

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
