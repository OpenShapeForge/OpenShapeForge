// SPDX-License-Identifier: BUSL-1.1
import type { JsonSchema } from "./plugins.js";

/** Flat transport inputs relax only copied fields, and only with an explicit source. */
export function withBlueprintCreate(schema: JsonSchema, blueprint: { fields: string[] } | undefined): JsonSchema {
  if (!blueprint) return schema;
  const required = (schema.required ?? []) as string[];
  return {
    ...schema,
    properties: { ...(schema.properties as Record<string, unknown>), blueprintId: { type: "string", minLength: 1 } },
    required: required.filter((key) => !blueprint.fields.includes(key)),
    allOf: [
      ...((schema.allOf ?? []) as unknown[]),
      { if: { not: { required: ["blueprintId"] } }, then: { required } },
    ],
  };
}
