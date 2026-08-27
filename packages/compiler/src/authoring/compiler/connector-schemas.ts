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
  applyCollectionShape,
  bundleFieldDefinitionSchema,
  constraintsForField,
  FIELD_DEFINITION_SEMANTIC_TYPE,
  fieldDefinitionValueSchema,
  isCollection,
  localizedText,
  objectSchemaFrom,
  splitBundledDefinitions,
  type JsonObject,
} from "../../field-json-schema.js";
import type { FieldDefinition } from "../types/field-definition.js";
import type { ConnectorOperationOutput } from "../types/connector.js";

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

/**
 * Key order matches the MCP catalog's: constraints, then enum, then
 * description, then default, then the collection wrapper.
 */
function connectorFieldSchemaWithoutDefinitions(field: FieldDefinition): JsonObject {
  const scalar =
    field.semanticType === FIELD_DEFINITION_SEMANTIC_TYPE
      ? fieldDefinitionValueSchema()
      : constraintsForField(field);

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

  return isCollection(field) ? applyCollectionShape(scalar, field) : scalar;
}

export function connectorFieldSchema(field: FieldDefinition): JsonObject {
  return bundleFieldDefinitionSchema(connectorFieldSchemaWithoutDefinitions(field), [field]);
}

export function connectorObjectSchema(fields: FieldDefinition[]): JsonObject {
  return bundleFieldDefinitionSchema(
    objectSchemaFrom(
      fields,
      (field) => connectorFieldSchemaWithoutDefinitions(field as FieldDefinition),
      { requireRequired: true },
    ),
    fields,
  );
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
): ConnectorOperationSchemas {
  const rowSchema = connectorObjectSchema(output.fields);
  const { schema: row, definitions } = splitBundledDefinitions(rowSchema);
  return {
    input: connectorObjectSchema(input),
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
