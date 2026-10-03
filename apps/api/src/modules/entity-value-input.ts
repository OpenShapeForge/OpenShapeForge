// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { RuntimeEntityValueCarrier, RuntimeEntityValueDefinition, RuntimeJsonSchemaValidator } from "@openshapeforge/plugin-runtime";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const invalid = (message: string): never => { throw operationFailure({ code: "VALIDATION", message, retryable: false }); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function selected(carrier: RuntimeEntityValueCarrier, key: unknown): RuntimeEntityValueDefinition {
  if (typeof key !== "string" || !Object.hasOwn(carrier.definitions, key)) invalid("The selected entity-value definition is unavailable.");
  return carrier.definitions[key as string]!;
}

/**
 * Logical typed fields enter through one entityValue object. Only the compiler
 * decides which of those fields belongs in JSON and which is a physical FK.
 * The caller MUST authorize every returned reference in its write transaction.
 */
export function splitEntityValueInput(
  carrier: RuntimeEntityValueCarrier,
  definitionKey: unknown,
  input: unknown,
  schemas: RuntimeJsonSchemaValidator,
): {
  values: Record<string, unknown>;
  columns: Record<string, string | null>;
  references: Array<{ fieldKey: string; entityName: string; id: string }>;
} {
  const definition = selected(carrier, definitionKey);
  if (!object(input)) invalid("Entity values must be an object.");
  const raw = input as Record<string, unknown>;
  const referenceKeys = new Set(definition.references.map((reference) => reference.fieldKey));
  const allowedKeys = new Set([...referenceKeys, ...definition.fields.map((field) => field.key)]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) invalid("Entity values contain an undeclared field.");
  const values = Object.assign(Object.create(null) as Record<string, unknown>, Object.fromEntries(definition.fields.filter((field) => typeof field.key === "string" && !referenceKeys.has(field.key) && field.defaultValue !== undefined)
    .map((field) => [field.key as string, structuredClone(field.defaultValue)])));
  for (const [key, value] of Object.entries(raw)) if (!referenceKeys.has(key)) values[key] = value;
  const valid = schemas.validate(definition.valueSchema, values);
  if (!valid.valid) throw operationFailure(valid.error);
  const references: Array<{ fieldKey: string; entityName: string; id: string }> = [];
  const columns = Object.fromEntries(Object.values(carrier.definitions).flatMap((definition) => definition.references.flatMap((reference) => [[reference.column, null], ...(reference.parameterColumn ? [[reference.parameterColumn, null]] : [])]))) as Record<string, string | null>;
  for (const reference of definition.references) {
    const value = Object.hasOwn(raw, reference.fieldKey) ? raw[reference.fieldKey] : undefined;
    if (object(value)) {
      if (!reference.parameterColumn || Object.keys(value).length !== 1 || typeof value.parameter !== "string" || !/^[a-z][A-Za-z0-9]{0,127}$/.test(value.parameter)) invalid(`The ${reference.fieldKey} parameter binding is invalid.`);
      columns[reference.parameterColumn!] = value.parameter as string;
      continue;
    }
    if (value === null || value === undefined) {
      if (reference.required) invalid(`The ${reference.fieldKey} relationship is required.`);
      columns[reference.column] = null;
      continue;
    }
    if (typeof value !== "string" || !uuid.test(value)) invalid(`The ${reference.fieldKey} relationship must be a UUID.`);
    columns[reference.column] = value as string;
    references.push({ fieldKey: reference.fieldKey, entityName: reference.targetEntity, id: value as string });
  }
  return { values: structuredClone(values), columns, references };
}

/** Rebuilds the logical object without exposing internal discriminator-specific column names. */
export function projectEntityValue(
  carrier: RuntimeEntityValueCarrier,
  row: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const definition = selected(carrier, row[carrier.definitionColumn]);
  const raw = row[carrier.valuesColumn];
  if (!object(raw)) invalid("Stored entity values are invalid.");
  const value = structuredClone(raw) as Record<string, unknown>;
  for (const reference of definition.references) {
    if (Object.hasOwn(value, reference.fieldKey)) invalid("A stored relationship cannot be embedded in JSON values.");
    const id = row[reference.column] ?? null;
    const parameter = reference.parameterColumn ? row[reference.parameterColumn] ?? null : null;
    if (parameter !== null) {
      if (id !== null || typeof parameter !== "string" || !/^[a-z][A-Za-z0-9]{0,127}$/.test(parameter)) invalid("A stored parameter binding is invalid.");
      value[reference.fieldKey] = { parameter };
      continue;
    }
    if (id === null && reference.required || id !== null && (typeof id !== "string" || !uuid.test(id))) invalid("A stored typed relationship is invalid.");
    value[reference.fieldKey] = id;
  }
  return value;
}
