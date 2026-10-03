// SPDX-License-Identifier: BUSL-1.1
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { operationFailure, type OperationViolation } from "@openshapeforge/operations";
import { createOperationAjv } from "../operation-ajv.js";
import { fieldNameForColumn } from "./columns.js";
import type { EntityOperationContract, GeneratedCrudTable } from "./types.js";

/**
 * The compiled `inputSchema` of an entity Operation IS the write contract: the
 * enum an authored `options` list became, the `pattern`, the length and range
 * bounds. MCP enforced it at its transport edge while REST and GraphQL handed
 * the body straight to the mutation, so `status: "banana"` persisted through
 * two of the three interfaces. This is the one place every interface passes
 * through (executeEntityOperation), so the contract holds regardless of the
 * transport, and MCP's earlier check of the same schema can only agree.
 *
 * Two deliberate relaxations, both of them what the schema already means:
 *
 * - `partial` validates only the keys the caller sent. The update schema
 *   carries no `required` list, and a blueprint create is completed from the
 *   blueprint's values before the row is written.
 * - `null` on a nullable column clears it. The compiled property schemas name
 *   the value's type without `null`, but a nullable column has always accepted
 *   a clear through GraphQL; a `null` on a NOT NULL column still fails as the
 *   type error it is.
 */
const ajv = createOperationAjv();
const validators = new WeakMap<EntityOperationContract, Map<string, ValidateFunction>>();

type ValuesSchema = Record<string, unknown> & {
  properties?: Record<string, unknown>;
  required?: string[];
};

function valuesSchemaOf(operation: EntityOperationContract): ValuesSchema | undefined {
  const properties = operation.inputSchema?.properties as Record<string, unknown> | undefined;
  const values = properties?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
  return values as ValuesSchema;
}

function validatorFor(operation: EntityOperationContract, partial: boolean): ValidateFunction | undefined {
  const mode = partial ? "partial" : "full";
  const cached = validators.get(operation)?.get(mode);
  if (cached) return cached;
  const values = valuesSchemaOf(operation);
  if (!values) return undefined;
  const { required, ...rest } = values;
  // `$ref` targets are rooted in the Operation schema, not its values subtree:
  // carry the bundled definitions along so a reference still resolves.
  const definitions = operation.inputSchema?.$defs;
  const schema = {
    ...rest,
    ...(partial || !required ? {} : { required }),
    ...(definitions && typeof definitions === "object" && !Array.isArray(definitions) ? { $defs: definitions } : {}),
  };
  const validate = ajv.compile(schema);
  const byMode = validators.get(operation) ?? new Map<string, ValidateFunction>();
  byMode.set(mode, validate);
  validators.set(operation, byMode);
  return validate;
}

const VIOLATION_CODES: Record<string, string> = {
  required: "REQUIRED",
  additionalProperties: "UNKNOWN_FIELD",
  enum: "NOT_IN_OPTIONS",
  const: "NOT_IN_OPTIONS",
  pattern: "PATTERN_MISMATCH",
  type: "INVALID_TYPE",
  format: "INVALID_FORMAT",
  minLength: "TOO_SHORT",
  maxLength: "TOO_LONG",
  minimum: "BELOW_MINIMUM",
  exclusiveMinimum: "BELOW_MINIMUM",
  maximum: "ABOVE_MAXIMUM",
  exclusiveMaximum: "ABOVE_MAXIMUM",
  minItems: "TOO_FEW_ITEMS",
  maxItems: "TOO_MANY_ITEMS",
  uniqueItems: "DUPLICATE_ITEMS",
  multipleOf: "INVALID_MULTIPLE",
};

function fieldPath(error: ErrorObject): string | undefined {
  const segments = error.instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    segments.push(error.params.missingProperty);
  } else if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") {
    segments.push(error.params.additionalProperty);
  }
  return segments.length ? segments.join(".") : undefined;
}

function violationMessage(error: ErrorObject, field: string | undefined): string {
  const subject = field ?? "values";
  switch (error.keyword) {
    case "required":
      return `${subject} is required.`;
    case "additionalProperties":
      return `${subject} is not a field of this Operation.`;
    case "enum": {
      const allowed = Array.isArray(error.params.allowedValues)
        ? (error.params.allowedValues as unknown[]).map((value) => JSON.stringify(value)).join(", ")
        : undefined;
      return allowed ? `${subject} must be one of ${allowed}.` : `${subject} is not one of the allowed values.`;
    }
    default:
      return `${subject} ${error.message ?? "is invalid"}.`;
  }
}

/**
 * One violation per distinct field and code, in schema order. A value of the
 * wrong type fails every other constraint on its field as well; only the type
 * violation is reported, since the others are consequences of it.
 */
export function violationsFromAjvErrors(errors: readonly ErrorObject[]): OperationViolation[] {
  const seen = new Set<string>();
  const wrongType = new Set(errors.filter((error) => error.keyword === "type").map(fieldPath));
  const violations: OperationViolation[] = [];
  for (const error of errors) {
    const field = fieldPath(error);
    if (error.keyword !== "type" && wrongType.has(field)) continue;
    const code = VIOLATION_CODES[error.keyword] ?? error.keyword.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
    const key = `${field ?? ""}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push({ ...(field ? { field } : {}), code, message: violationMessage(error, field) });
  }
  return violations;
}

/** The nullable columns of `table`, by authored field name. */
function nullableFields(table: GeneratedCrudTable): Set<string> {
  return new Set(
    table.columns.filter((column) => !column.required).map((column) => fieldNameForColumn(column)),
  );
}

export type EntityValuesValidation = {
  /** Validate only the keys present, leaving `required` to the write itself. */
  partial: boolean;
};

/**
 * Refuse `values` that do not satisfy the Operation's compiled write contract,
 * as the canonical VALIDATION failure with one violation per offending field.
 * Returns silently when the Operation publishes no values schema (a plugin
 * Operation owns its own input).
 */
export function assertEntityValuesValid(
  operation: EntityOperationContract,
  table: GeneratedCrudTable,
  values: Readonly<Record<string, unknown>>,
  options: EntityValuesValidation,
): void {
  const validate = validatorFor(operation, options.partial);
  if (!validate) return;
  const clearable = nullableFields(table);
  const checked = Object.fromEntries(
    Object.entries(values).filter(([field, value]) => value !== undefined && !(value === null && clearable.has(field))),
  );
  if (validate(checked)) return;
  const violations = violationsFromAjvErrors(validate.errors ?? []);
  throw operationFailure({
    code: "VALIDATION",
    message: `The values do not satisfy the ${operation.entityName}.${operation.intent} contract.`,
    detail: violations.map((violation) => violation.message).join(" "),
    violations,
    retryable: false,
  });
}

const inputValidators = new WeakMap<EntityOperationContract, ValidateFunction>();

/**
 * A plugin-backed Operation owns its whole input contract (a document with
 * its version and artifact), so the request is held to the compiled
 * `inputSchema` as one object, before prerequisites or the handler run,
 * and refused as the same VALIDATION failure an entity write gets.
 */
export function assertOperationInputValid(
  operation: EntityOperationContract,
  input: Readonly<Record<string, unknown>>,
): void {
  if (!operation.inputSchema) return;
  let validate = inputValidators.get(operation);
  if (!validate) {
    validate = ajv.compile(operation.inputSchema as Record<string, unknown>);
    inputValidators.set(operation, validate);
  }
  if (validate(input)) return;
  const violations = violationsFromAjvErrors(validate.errors ?? []);
  throw operationFailure({
    code: "VALIDATION",
    message: `The input does not satisfy the ${operation.entityName}.${operation.intent} contract.`,
    detail: violations.map((violation) => violation.message).join(" "),
    violations,
    retryable: false,
  });
}
