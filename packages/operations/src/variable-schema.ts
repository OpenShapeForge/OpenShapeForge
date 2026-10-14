// SPDX-License-Identifier: BUSL-1.1
/**
 * The typed-variable shape of one compiled property.
 *
 * A binding is compared against the destination's own declared contract. On a
 * transport that contract is already published as JSON Schema — the property
 * the compiler projected through `field-schema.ts`, carrying `x-osf-type`,
 * `x-osf-variables`, the closed `enum`, the `x-osf-reference` target and the
 * collection wrapper. Reading the slot back out of that projection keeps one
 * contract: what a caller is told it may bind is the same thing the write
 * path compares, and no second copy of the field metadata has to travel
 * beside it.
 *
 * A property this reader cannot type is refused rather than guessed, so a
 * shape the build does not understand never silently becomes bindable.
 */

import type { OperationFieldBaseType, OperationJsonSchema } from "./field-schema-types.js";
import {
  isFieldVariableMode,
  type FieldVariableMode,
  type VariableSlot,
  type VariableValueShape,
} from "./field-variables.js";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * The JSON type of a property, as one name. A numeric property publishes both
 * of its forms (`["number", "string"]` — the JSON number and the exact
 * decimal text); the type axis is the numeric one, and the text form is a
 * spelling of it rather than a second type.
 */
function jsonType(schema: Readonly<Record<string, unknown>>): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (!Array.isArray(type)) return undefined;
  const names = type.filter((entry): entry is string => typeof entry === "string");
  return names.find((name) => name !== "string") ?? names.find((name) => name === "string");
}

function baseTypeOf(schema: Readonly<Record<string, unknown>>): OperationFieldBaseType | undefined {
  switch (jsonType(schema)) {
    case "boolean": return "boolean";
    case "integer": return "integer";
    case "number": return "number";
    case "object": return "object";
    case "string":
      return schema.format === "date" ? "date" : schema.format === "date-time" ? "datetime" : "string";
    default: return undefined;
  }
}

/** The item projection of a collection property, including the `allOf` pair an explicit item makes. */
function itemsOf(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  const items = record(schema.items);
  if (!items) return undefined;
  if (!Array.isArray(items.allOf)) return items;
  const merged: Record<string, unknown> = {};
  for (const branch of items.allOf) {
    const entry = record(branch);
    if (entry) Object.assign(merged, entry);
  }
  // The row node's own keywords win over the outer property's.
  return { ...merged, ...Object.fromEntries(Object.entries(items).filter(([key]) => key !== "allOf")) };
}

/**
 * The closed domain of a property, from the keyword that carries it: `enum`
 * for every type whose values JSON Schema can enumerate once, and
 * `x-osf-exact.enum` for a numeric one, whose two forms cannot both be listed
 * there (`field-schema-metadata.ts`). Reading both keeps one contract: the
 * domain a binding is compared against is the domain the write path enforces.
 */
function enumOf(schema: Readonly<Record<string, unknown>>): readonly (string | number | boolean)[] | undefined {
  const exact = record(schema["x-osf-exact"])?.enum;
  const published = Array.isArray(schema.enum) ? schema.enum : Array.isArray(exact) ? exact : undefined;
  if (!published) return undefined;
  const values = published.filter(
    (value): value is string | number | boolean =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
  return values.length === published.length ? values : undefined;
}

function targetOf(schema: Readonly<Record<string, unknown>>): string | undefined {
  const reference = record(schema["x-osf-reference"]);
  return typeof reference?.entity === "string" ? reference.entity : undefined;
}

export type SchemaVariableShapeOptions = {
  /** Whether the destination requires a value; a required slot takes no null. */
  readonly required?: boolean;
};

/**
 * The value shape of one compiled property, or `undefined` when the
 * projection does not type it.
 */
export function schemaVariableShape(
  schema: OperationJsonSchema,
  options: SchemaVariableShapeOptions = {},
): VariableValueShape | undefined {
  return shapeAtDepth(schema, options, 0);
}

function shapeAtDepth(schema: OperationJsonSchema, options: SchemaVariableShapeOptions, depth: number): VariableValueShape | undefined {
  if (depth > 32) return undefined;
  const node = record(schema);
  if (!node) return undefined;
  const collection = jsonType(node) === "array";
  const value = collection ? itemsOf(node) : node;
  if (!value) return undefined;
  const baseType = baseTypeOf(value);
  if (!baseType) return undefined;
  // The type axis of the property, not of its row: a collection is a use of
  // the same osf-type as its items, and the array node carries it.
  const osfType = typeof node["x-osf-type"] === "string"
    ? node["x-osf-type"]
    : typeof value["x-osf-type"] === "string" ? value["x-osf-type"] : baseType;
  const target = targetOf(node) ?? targetOf(value);
  const enumeration = enumOf(value) ?? enumOf(node);
  const context = record(node["x-osf-value-context"]) ?? record(value["x-osf-value-context"]);
  let children: Record<string, VariableValueShape> | undefined;
  const properties = record(value.properties);
  if (properties) {
    children = Object.create(null) as Record<string, VariableValueShape>;
    for (const [key,child] of Object.entries(properties)) {
      const projected = shapeAtDepth(child as OperationJsonSchema, {required:Array.isArray(value.required) && value.required.includes(key)}, depth + 1);
      if (!projected) return undefined;
      children[key] = projected;
    }
  }
  return Object.freeze({
    osfType,
    baseType,
    cardinality: collection ? "collection" : "single",
    nullable: options.required !== true,
    ...(enumeration ? { enum: enumeration } : {}),
    ...(target ? { target } : {}),
    ...(typeof context?.unit === "string" ? { unit: context.unit } : {}),
    ...(typeof context?.currency === "string" ? { currency: context.currency } : {}),
    ...(children ? { children } : {}),
  });
}

/** The authored variable mode of a compiled property; absent means `none`. */
export function schemaVariableMode(schema: OperationJsonSchema): FieldVariableMode | undefined {
  const mode = record(schema)?.["x-osf-variables"];
  if (mode === undefined) return "none";
  return isFieldVariableMode(mode) ? mode : undefined;
}

/**
 * The destination contract of one compiled property. `undefined` when the
 * property is not typed by this reader or declares a mode this build does not
 * know — a field whose contract cannot be read accepts no binding at all,
 * rather than one compared against a guess.
 */
export function schemaVariableSlot(
  path: string,
  schema: OperationJsonSchema,
  options: SchemaVariableShapeOptions = {},
): VariableSlot | undefined {
  const shape = schemaVariableShape(schema, options);
  const mode = schemaVariableMode(schema);
  if (!shape || !mode) return undefined;
  return Object.freeze({ ...shape, path, mode });
}
