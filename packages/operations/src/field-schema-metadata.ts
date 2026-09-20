// SPDX-License-Identifier: BUSL-1.1
/**
 * The pieces a projected property is assembled from: the constrained JSON
 * type, the collection wrapper and its bounds, the enumeration and the
 * human-facing description. Pure functions of a resolved field; the order
 * they are applied in is field-schema.ts's contract.
 */

import type {
  OperationFieldSchemaRegistry,
  OperationJsonSchema,
  OperationLocalizedText,
  ResolvedOperationField,
} from "./field-schema-types.js";
import { localizedText, numericRule, stringRule } from "./field-resolution.js";

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
