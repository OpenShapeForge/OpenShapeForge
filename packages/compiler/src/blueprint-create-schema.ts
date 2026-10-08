// SPDX-License-Identifier: BUSL-1.1
import type { JsonSchema } from "./plugins.js";

export const blueprintBindingsSchema = { type: "object", maxProperties: 20, additionalProperties: { type: "object", maxProperties: 1000, additionalProperties: { type: "string", format: "uuid" } } };

/** Flat transport inputs relax only copied fields, and only with an explicit source. */
export function withBlueprintCreate(schema: JsonSchema, blueprint: { fields: string[] } | undefined): JsonSchema {
  if (!blueprint) return schema;
  const required = (schema.required ?? []) as string[];
  return {
    ...schema,
    properties: { ...(schema.properties as Record<string, unknown>), blueprintId: { type: "string", minLength: 1 }, blueprintBindings: blueprintBindingsSchema },
    required: required.filter((key) => !blueprint.fields.includes(key)),
    allOf: [
      ...((schema.allOf ?? []) as unknown[]),
      { if: { required: ["blueprintBindings"] }, then: { required: ["blueprintId"] } },
      { if: { not: { required: ["blueprintId"] } }, then: { required } },
    ],
  };
}
