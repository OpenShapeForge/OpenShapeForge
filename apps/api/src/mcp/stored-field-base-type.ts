// SPDX-License-Identifier: BUSL-1.1
/**
 * A stored field definition names its type as `osfType`; its base is the type
 * itself for a base type and the semantic-type registry entry's `valueType`
 * otherwise. Unknown types project as strings, the way an unknown semantic
 * type always did.
 */
import fieldSchemaRegistry from "../generated/operations/field-schema-registry.json" with { type: "json" };

export const STORED_FIELD_BASE_TYPES = new Set(["string", "integer", "number", "boolean", "date", "datetime", "object"]);

export function storedFieldBaseType(definition: { osfType?: unknown }): string {
  const osfType = typeof definition.osfType === "string" ? definition.osfType : "string";
  if (STORED_FIELD_BASE_TYPES.has(osfType)) return osfType;
  const semantic = (fieldSchemaRegistry.semanticTypes as Record<string, { valueType?: unknown } | undefined>)[osfType];
  return typeof semantic?.valueType === "string" ? semantic.valueType : "string";
}
