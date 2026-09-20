// SPDX-License-Identifier: BUSL-1.1
/**
 * The advertised JSON Schema is the contract: what tools/list promises,
 * tools/call enforces. The edge validates the argument envelope here.
 *
 * Split out of generated-mcp-server.ts.
 */
import {
  invalidExpectedVersionFailure,
  invalidMutationControlTypeFailure,
} from "../operations/entity/index.js";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { HttpError } from "../rest/http-error.js";

// The advertised JSON Schema IS the contract: what tools/list promises,
// tools/call enforces. The edge holds the argument envelope and the derived
// and composed tools to it; an entity tool's authored values are judged by
// executeEntityOperation, the one validator every interface shares
// (operations/entity/input-validation.ts), so `status: "banana"` comes back
// as VALIDATION with a per-field violation here as it does over REST.
export const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
// ajv-formats is CJS; under NodeNext the default import is typed as the
// module namespace rather than the callable it is at runtime.
(addFormats as unknown as (instance: Ajv) => unknown)(ajv);
export function assertSchemaValid(
  schema: Record<string, unknown>,
  value: unknown,
  what: string,
  expectedVersionField?: string,
): void {
  const checker: ValidateFunction = ajv.compile(schema);
  try {
    if (!checker(value)) {
      const invalidMutationControlType = (checker.errors ?? []).find(
        (error) =>
          error.keyword === "type" &&
          [
            "/expectedVersion",
            "/leaseToken",
            "/confirmed",
            "/confirmationToken",
            "/confirmationAnswer",
          ].includes(error.instancePath),
      );
      if (invalidMutationControlType) {
        const field = invalidMutationControlType.instancePath.slice(1) as
          | "expectedVersion"
          | "leaseToken"
          | "confirmed"
          | "confirmationToken"
          | "confirmationAnswer";
        const expectedType = field === "confirmed" ? "boolean" : "string";
        throw invalidMutationControlTypeFailure(field, expectedType);
      }
      const invalidExpectedVersion = (checker.errors ?? []).some(
        (error) =>
          error.instancePath === "/expectedVersion" &&
          error.keyword === "format" &&
          error.params?.format === "date-time",
      );
      if (invalidExpectedVersion && expectedVersionField) {
        throw invalidExpectedVersionFailure(expectedVersionField);
      }
      const details = (checker.errors ?? [])
        .slice(0, 5)
        .map((error) => {
          const offender =
            typeof error.params?.additionalProperty === "string"
              ? ` ("${error.params.additionalProperty}")`
              : "";
          return `${error.instancePath || what} ${error.message ?? "invalid"}${offender}`;
        })
        .join("; ");
      throw new HttpError(400, "BAD_USER_INPUT", `Invalid ${what}: ${details}`);
    }
  } finally {
    ajv.removeSchema(schema);
  }
}

export const ENVELOPE_KEYS = new Set([
  "id",
  "blueprintId",
  "expectedVersion",
  "leaseToken",
  "confirmed",
  "confirmationToken",
  "confirmationAnswer",
]);

/**
 * The tool schema with the authored values taken out: an update's `values`
 * becomes a bare object, a create keeps only its transport controls and
 * admits the fields as additional properties. Reads and deletes carry no
 * values and validate as advertised.
 */
export function envelopeSchema(
  schema: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  if (operation !== "create" && operation !== "update") return schema;
  const { required: advertisedRequired, ...rest } = schema;
  const properties = (rest.properties ?? {}) as Record<string, unknown>;
  if (operation === "update") {
    return { ...schema, properties: { ...properties, values: { type: "object" } } };
  }
  // `required` is always replaced: a create reduced to its controls must not
  // keep the advertised field list, or ajv answers for the missing field
  // before the runtime can name it as a REQUIRED violation.
  const required = Array.isArray(advertisedRequired)
    ? (advertisedRequired as unknown[]).filter((key) => typeof key === "string" && ENVELOPE_KEYS.has(key))
    : [];
  return {
    ...rest,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([key]) => ENVELOPE_KEYS.has(key)),
    ),
    ...(required.length ? { required } : {}),
    additionalProperties: true,
  };
}
