// SPDX-License-Identifier: BUSL-1.1
/**
 * JSON Schemas for connector operation input and output.
 *
 * These are the runtime boundary with third-party code. A connector package is
 * written by someone else and shipped separately; generated TypeScript types are
 * erased before it is ever loaded, so they protect nothing. The platform
 * validates input before calling a package and output before handing anything
 * back to a caller, and both sides check against these.
 *
 * The constraint mapping is shared with the MCP tool catalog
 * (`field-json-schema.ts`) so the two surfaces cannot disagree about what an
 * operation accepts — a value advertised as valid and then rejected is a bug
 * neither surface would catch alone.
 *
 * Determinism: pure function of the authored fields, in authored order.
 */
import {
  bundleFieldDefinitionSchema,
  localizedText,
  splitBundledDefinitions,
  type JsonObject,
} from "../../field-json-schema.js";
import { collectionShape, constrainedType } from "@openshapeforge/operations";
import type { FieldDefinition, FieldDefinitionValueType } from "../types/field-definition.js";
import type { ConnectorOperationOutput } from "../types/connector.js";
import type { OsfTypeDefinition, OsfTypeSchemaReference } from "../types/authoring.js";
import { osfTypeDefinitionOf, resolveBaseType } from "../entity-fields.js";

/**
 * A closed vocabulary, when the field declares one. Only `static` options are
 * honoured: referentiedata groups are an entity concept, and a connector
 * talking to a remote system has no business inheriting this platform's code
 * tables into its wire contract.
 */
function staticEnum(field: FieldDefinition): string[] | undefined {
  const options = field.options;
  if (options?.type !== "static" || !options.items?.length) return undefined;
  return options.items.map((item) => item.value);
}

export type ConnectorOsfTypes = Record<string, OsfTypeDefinition>;

/**
 * Connector fields never go through entity normalization, so their base type
 * is resolved here: a base osf type is its own base, a catalog key resolves
 * through the catalog, anything else is refused. A catalog type that declares
 * its own value schema is projected through that schema.
 */
function withBaseType(
  field: FieldDefinition,
  osfTypes: ConnectorOsfTypes,
): FieldDefinition & { baseType: FieldDefinitionValueType; schema?: OsfTypeSchemaReference } {
  const baseType = resolveBaseType(field.osfType, osfTypes);
  if (!baseType) throw new Error(`Connector field ${field.key}: unknown osfType ${field.osfType}.`);
  const schema = osfTypeDefinitionOf(field.osfType, osfTypes)?.schema;
  return { ...field, baseType, ...(schema ? { schema } : {}) };
}

/**
 * Key order matches the MCP catalog's: constraints, then enum, then
 * description, then default, then the collection wrapper.
 */
function connectorFieldSchemaWithoutDefinitions(field: FieldDefinition, osfTypes: ConnectorOsfTypes): JsonObject {
  const resolved = withBaseType(field, osfTypes);
  const scalar: JsonObject = resolved.schema ? structuredClone(resolved.schema) : constrainedType(resolved);

  const values = staticEnum(field);
  if (values) scalar.enum = values;

  const parts: string[] = [];
  const description = localizedText(field.description) ?? localizedText(field.label);
  const help = localizedText(field.help);
  if (description) parts.push(description);
  if (help) parts.push(help);
  if (field.unit) parts.push(`Unit: ${field.unit}.`);
  if (parts.length > 0) scalar.description = parts.join(" ");

  if (field.defaultValue !== undefined) scalar.default = field.defaultValue;

  return field.cardinality === "collection" ? collectionShape(scalar, field) : scalar;
}

export function connectorFieldSchema(field: FieldDefinition, osfTypes: ConnectorOsfTypes = {}): JsonObject {
  return bundleFieldDefinitionSchema(connectorFieldSchemaWithoutDefinitions(field, osfTypes));
}

/**
 * `additionalProperties` is always false: an unknown property is a caller
 * error worth surfacing, not something to drop silently. A default never
 * makes a required field omittable here — connector contract validators do
 * not materialize defaults, so their callers keep the stricter boundary.
 */
export function connectorObjectSchema(fields: FieldDefinition[], osfTypes: ConnectorOsfTypes = {}): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.key] = connectorFieldSchemaWithoutDefinitions(field, osfTypes);
    if (field.required) required.push(field.key);
  }
  return bundleFieldDefinitionSchema({
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  });
}

export type ConnectorOperationSchemas = {
  input: JsonObject;
  output: JsonObject;
};

/**
 * `cardinality: many` wraps the row shape in an array. The wrapper lives here
 * rather than in the package contract so a connector cannot decide to return a
 * bare object where the contract promised a list.
 */
export function buildOperationSchemas(
  input: FieldDefinition[],
  output: ConnectorOperationOutput,
  osfTypes: ConnectorOsfTypes = {},
): ConnectorOperationSchemas {
  const rowSchema = connectorObjectSchema(output.fields, osfTypes);
  const { schema: row, definitions } = splitBundledDefinitions(rowSchema);
  return {
    input: connectorObjectSchema(input, osfTypes),
    output:
      output.cardinality === "many"
        ? {
            type: "array",
            items: row,
            ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
          }
        : rowSchema,
  };
}
