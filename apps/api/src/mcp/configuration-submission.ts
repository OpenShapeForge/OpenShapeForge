// SPDX-License-Identifier: BUSL-1.1
/**
 * A submitted configuration form: the field definitions it asks, the
 * parsing and coercion of the posted values, the merge with an existing
 * row, the failure code a person is shown, and the storage of the values.
 * The pending-handoff store (mint, peek, consume) stays in
 * configuration-handoff.ts. Split out of it, verbatim.
 */

/**
 * Translate one submitted form value to the definition's type. Returns
 * undefined for an absent optional value; a string error for a bad one.
 */
import type { SecretKeyring } from "../connectors/secrets.js";
import { operationErrorOf } from "@openshapeforge/operations";
import { type ElicitOnCreateEntry } from "./elicitation.js";
import { HttpError } from "../rest/http-error.js";
import type { JsonRecord, PendingConfiguration, StoredFieldDefinition } from "./configuration-handoff.js";
import { elicitationSchemaFromDefinitions, storeElicitedValues } from "./elicitation.js";
import { storedFieldBaseType } from "../modules/field-schemas.js";
export function coerceValue(
  definition: StoredFieldDefinition,
  raw: string | null,
): { value?: unknown; error?: string } {
  const valueType = storedFieldBaseType(definition);
  if (valueType === "boolean") return { value: raw !== null };
  if (raw === null || raw === "") {
    return definition.required === true
      ? { error: "This value is required." }
      : {};
  }
  if (valueType === "integer") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed)
      ? { error: "Enter a whole number." }
      : { value: parsed };
  }
  if (valueType === "number") {
    const parsed = Number.parseFloat(raw);
    return Number.isNaN(parsed)
      ? { error: "Enter a number." }
      : { value: parsed };
  }
  return { value: raw };
}

export type ParsedSubmission = {
  content: JsonRecord;
  errors: Record<string, string>;
};

/** The exact field subset both browser renderers and submission parsing use. */
export function configurationFormDefinitions(
  pending: PendingConfiguration,
): JsonRecord[] {
  return elicitationSchemaFromDefinitions(pending.definitions)
    .elicitable as JsonRecord[];
}

/** Parse a urlencoded submission against the pending definitions. */
export function parseSubmission(
  pending: PendingConfiguration,
  body: string,
): ParsedSubmission {
  const params = new URLSearchParams(body);
  const { elicitable } = elicitationSchemaFromDefinitions(pending.definitions);
  const content: JsonRecord = {};
  const errors: Record<string, string> = {};
  for (const definition of elicitable as StoredFieldDefinition[]) {
    const key = definition.key as string;
    const { value, error } = coerceValue(definition, params.get(key));
    if (error) errors[key] = error;
    else if (value !== undefined) content[key] = value;
  }
  return { content, errors };
}

/**
 * The already-stored row a submission belongs to, if any: the row in the
 * target table whose `key` equals the key the model supplied when it minted
 * the handoff. A second submission for that key - a retried form, a rotated
 * secret - must update this row, never create a duplicate beside it.
 */
export function findExistingConfiguration(
  rows: readonly JsonRecord[],
  pending: Pick<PendingConfiguration, "modelValues">,
): JsonRecord | undefined {
  const wanted = pending.modelValues.key;
  if (typeof wanted !== "string" || wanted.length === 0) return undefined;
  return rows.find((row) => row.key === wanted);
}

/**
 * Merge a submission into the values a row already holds: every submitted
 * key replaces the stored value under that key (a secret submitted again is
 * the new secret, once), keys the form did not carry stay as they were.
 */
export function mergeConfigurationValues(
  existing: unknown,
  submitted: JsonRecord,
): JsonRecord {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as JsonRecord)
      : {};
  return { ...base, ...submitted };
}

/**
 * Why a browser handoff failed, as a bounded name for the server log. The
 * request logger redacts every error to its class, which is right for
 * messages (a provider's or the database's text can carry personal data)
 * but left an administrator's "could not be saved" page with no trail at
 * all. Codes are ours (HttpError, OperationFailure) or PostgreSQL's
 * five-character SQLSTATE; a message never gets through here.
 */
export function handoffFailureCode(error: unknown): string {
  if (error instanceof HttpError) return `http:${error.code}`;
  const operation = operationErrorOf(error);
  if (operation) return `operation:${operation.code}`;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return `postgres:${code}`;
  }
  return error instanceof Error ? `error:${error.name}` : "unknown";
}

/**
 * The identity a browser handoff will write the row with. The form asks the
 * person only for the elicited values, so every other required create
 * argument has to be known when the form is minted. A model routinely omits
 * a connection's key and name; the source (provider) row supplies both, the
 * way the connection-problem path already does. Anything still missing
 * refuses the handoff here, naming the fields, so the model can call again —
 * rather than the person's submission failing on a NOT NULL column with a
 * page that cannot say why.
 */
export function handoffModelValues(input: {
  required: readonly string[];
  elicit: ElicitOnCreateEntry;
  modelValues: JsonRecord;
  sourceRow: JsonRecord;
}): JsonRecord {
  const values: JsonRecord = { ...input.modelValues };
  for (const field of ["key", "name"]) {
    if (values[field] === undefined && typeof input.sourceRow[field] === "string") {
      values[field] = input.sourceRow[field];
    }
  }
  const missing = input.required.filter(
    (field) =>
      field !== input.elicit.into &&
      (values[field] === undefined || values[field] === null || values[field] === ""),
  );
  if (missing.length > 0) {
    throw new HttpError(
      400,
      "VALIDATION",
      `Provide ${missing.join(", ")} in the call: the secure form asks the person ` +
        `only for ${input.elicit.into}, so every other required value must come from you.`,
    );
  }
  return values;
}

/** Encrypt-and-shape the parsed values exactly as the in-band form would. */
export function storeSubmission(
  pending: PendingConfiguration,
  content: JsonRecord,
  keyring?: SecretKeyring,
): JsonRecord {
  const { elicitable } = elicitationSchemaFromDefinitions(pending.definitions);
  return {
    ...pending.modelValues,
    [pending.elicit.into]: storeElicitedValues(
      pending.elicit.sourceTable,
      elicitable,
      content,
      keyring,
    ),
  };
}
