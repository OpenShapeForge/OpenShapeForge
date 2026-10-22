// SPDX-License-Identifier: BUSL-1.1
import type { CompiledField } from "../types/compiled.js";
import { compiledObjectSchema } from "../../field-json-schema.js";

/** Bounded, typed predicates; the executor accepts exactly this operator vocabulary. */
export function structuredQuerySchema(fields: CompiledField[], filterFields: string[], sortFields: string[]) {
  const record = compiledObjectSchema(fields, {}, { requireRequired: true }) as { properties: Record<string, Record<string, unknown>> };
  const predicates: Record<string, unknown> = {};
  for (const key of filterFields) {
    const field = fields.find(candidate => candidate.key === key);
    if (!field || (field.baseType === "object" && field.cardinality !== "collection")) throw new Error(`Invalid structured query field ${key}.`);
    const value = record.properties[key]!;
    const collection = field.cardinality === "collection";
    const scalar = collection ? value.items as Record<string, unknown> : value;
    const properties: Record<string, unknown> = collection
      ? { contains: scalar }
      : { eq: scalar, ne: scalar, in: { type: "array", minItems: 1, maxItems: 100, items: scalar }, isNull: { type: "boolean" } };
    if (!collection && ["string", "date", "datetime", "integer", "number"].includes(field.baseType)) {
      for (const op of ["gt", "gte", "lt", "lte"]) properties[op] = scalar;
    }
    if (!collection && field.baseType === "string") {
      properties.contains = { type: "string", maxLength: 500 };
      properties.startsWith = { type: "string", maxLength: 500 };
    }
    predicates[key] = { type: "object", additionalProperties: false, minProperties: 1, properties };
  }
  const definitions = Object.fromEntries(Array.from({ length: 5 }, (_, depth) => [`filter${depth}`, {
    type: "object", additionalProperties: false, maxProperties: 30,
    properties: { ...predicates, ...(depth < 4 ? Object.fromEntries(["and", "or"].map(key => [key, {
      type: "array", minItems: 1, maxItems: 20, items: { $ref: `#/$defs/filter${depth + 1}` },
    }])) : {}) },
  }]));
  if (sortFields.some(key => !fields.some(field => field.key === key && field.cardinality === "single" && field.baseType !== "object"))) throw new Error("Structured query sorting requires scalar fields.");
  return { type: "object", additionalProperties: false, $defs: definitions, properties: {
    first: { type: "integer", minimum: 1, maximum: 200, default: 50 }, after: { type: "string", maxLength: 4096 },
    filter: { $ref: "#/$defs/filter0" }, sortField: { type: "string", enum: sortFields }, sortDirection: { type: "string", enum: ["asc", "desc"] },
  } };
}
