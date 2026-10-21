// SPDX-License-Identifier: BUSL-1.1
/**
 * Resolution of a FieldDefinition's type axis: the base type behind an
 * osfType, the one reading of cardinality, catalog defaults merged in. The
 * output is a ResolvedOperationField, the input of the projector in
 * field-schema.ts; the compiler's CompiledField is the same shape.
 */

import type {
  OperationFieldBaseType,
  OperationFieldCardinality,
  OperationFieldDefinition,
  OperationFieldOptions,
  OperationFieldOsfType,
  OperationFieldSchemaRegistry,
  OperationJsonSchema,
  OperationLocalizedText,
  ResolvedOperationField,
} from "./field-schema-types.js";
import { isExactDecimalText, isExactIntegerText } from "./exact-numeric.js";

export function localizedText(value: OperationLocalizedText | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  // An empty English string is absent, not a translation that hides the Dutch one.
  return [value.en, value.nl, value.fr].map((text) => text?.trim()).find((text) => text) || undefined;
}

/**
 * Authored option values are strings (the authoring schema admits nothing
 * else); an enumeration on a typed field carries the values in that type, so
 * `{ type: boolean, enum: [true] }` validates what a client sends. A value
 * that is not of that type (`yes` on a boolean, `1.5` on an integer, `abc` on
 * a number) is an authoring error, never a string smuggled into a typed
 * enumeration.
 *
 * A NUMERIC domain keeps its authored decimal text, and is compared by exact
 * decimal comparison where it is enforced (`x-osf-exact`, see
 * `field-schema-metadata.ts`). `Number(text)` is deliberately not used: it
 * rounds `9007199254740993` and rewrites `12.50` before anything is compared,
 * and a numeric value crosses every transport as that same decimal text, so
 * the domain and the value are compared in one exact representation instead of
 * through an IEEE double. Spelling is not identity there: `1`, `1.0` and `"1"`
 * are one member of the domain.
 */
export function typedEnumValues(values: readonly string[], baseType: string | undefined): (string | number | boolean)[] {
  return values.map((value) => {
    const text = value.trim();
    if (baseType === "integer") {
      if (!isExactIntegerText(text)) throw new Error(`Enumeration value ${JSON.stringify(value)} is not an integer.`);
      return text;
    }
    if (baseType === "number") {
      if (!isExactDecimalText(text)) throw new Error(`Enumeration value ${JSON.stringify(value)} is not a number.`);
      return text;
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
 * A field's choices: its own `options`, else a `reference` group, else the
 * catalog type's `options`, else where the catalog type says a value is
 * picked from (`optionSource`: an identity alias names its entity).
 */
export function resolveOptions(
  field: Pick<OperationFieldDefinition, "options" | "reference">,
  semantic: Pick<OperationFieldOsfType, "options" | "optionSource"> | undefined,
): OperationFieldOptions | undefined {
  if (field.options) return field.options;
  if (field.reference?.kind === "referentiedata" && field.reference.group) {
    return { type: "referentiedata", referentieGroep: field.reference.group };
  }
  return semantic?.options ?? semantic?.optionSource;
}

/** Resolve stored or plugin-authored definitions against the host registries. */
export function resolveFields(
  fields: readonly OperationFieldDefinition[],
  registry: OperationFieldSchemaRegistry,
  ancestry: readonly string[] = [],
): ResolvedOperationField[] {
  if (ancestry.length > 32) throw new Error("Field definitions exceed the supported nesting depth.");
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
    const component = field.render?.component ?? semantic?.render?.component ?? semantic?.render?.input ?? semantic?.render?.display;
    const render = component ? {component,props:{...semantic?.props,...semantic?.render?.props,...field.render?.props}} : field.render;
    const target = semantic?.kind === "entity" ? semantic.entity : undefined;
    return {
      key: field.key,
      ...(field.typedBy ? { typedBy: { ...field.typedBy } } : {}),
      osfType: field.osfType,
      ...(field.document ? { document: structuredClone(field.document) } : {}),
      baseType,
      cardinality,
      ...(bounds ? { cardinalityBounds: bounds } : {}),
      ...(field.variables ? { variables: field.variables } : {}),
      required: field.required === true || required,
      label: field.label ?? semantic?.label ?? { en: field.key, nl: field.key },
      ...(field.description !== undefined ? { description: field.description } : {}),
      ...(field.help !== undefined ? { help: field.help } : {}),
      ...(field.unit !== undefined ? { unit: field.unit } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      ...(validation ? { validation } : {}),
      ...(options ? { options } : {}),
      ...(render ? {render} : {}),
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
