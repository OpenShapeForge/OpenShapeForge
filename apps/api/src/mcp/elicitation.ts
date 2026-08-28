// SPDX-License-Identifier: BUSL-1.1
/**
 * Create-time MCP elicitation — tenant configuration collected from the
 * PERSON at the client, not from the model.
 *
 * An entity opting in via `mcp.elicitOnCreate` stores a reference to a source
 * row that carries canonical FieldDefinitions (e.g. a provider's
 * configuration contract). On create, the runtime asks the client to show a
 * standard elicitation form for exactly those definitions and stores the
 * answers into the configured target field. Deliberate boundaries:
 *
 *   - Elicitation happens ONLY on create, only for the definitions on the
 *     source row, and only for primitive definitions the elicitation schema
 *     can express. Identity fields (keys, names, relations) remain ordinary
 *     tool arguments the model supplies.
 *   - Whatever the model passed for the target field is DISCARDED before the
 *     elicited values are stored — the model is not a channel for these
 *     values, and pretending it never sent any is the enforcement.
 *   - Values whose definition carries a restricting classification are
 *     encrypted at rest with the platform keyring and read back as the
 *     `__set__` sentinel, never as the value (and never as ciphertext).
 *   - A client that does not support elicitation, or a person who declines,
 *     fails the create cleanly. There is no fallback to tool arguments; that
 *     would silently reopen the channel this exists to close.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { HttpError } from "../rest/http-error.js";
import {
  encryptSecret,
  keyringFromEnv,
  SECRET_SET_SENTINEL,
  type SecretKeyring,
  type StoredSecret,
} from "../connectors/secrets.js";

export type ElicitOnCreateEntry = {
  sourceField: string;
  sourceEntity: string;
  sourceTable: string;
  definitionsField: string;
  into: string;
  message?: string;
};

type StoredFieldDefinition = {
  key?: unknown;
  valueType?: unknown;
  cardinality?: unknown;
  required?: unknown;
  label?: unknown;
  description?: unknown;
  validation?: Record<string, unknown>;
  options?: { items?: { value?: unknown }[] };
  classification?: { sensitivity?: unknown };
};

const RESTRICTING_SENSITIVITY = new Set(["confidential", "pii", "bsn"]);

function localized(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const first = (value as Record<string, unknown>).en;
    if (typeof first === "string") return first;
    const any = Object.values(value as Record<string, unknown>).find(
      (entry) => typeof entry === "string",
    );
    if (typeof any === "string") return any;
  }
  return undefined;
}

const ELICITABLE_TYPES: Record<string, string> = {
  string: "string",
  integer: "integer",
  number: "number",
  boolean: "boolean",
};

export function isSecretDefinition(definition: StoredFieldDefinition): boolean {
  const sensitivity = definition.classification?.sensitivity;
  return typeof sensitivity === "string" && RESTRICTING_SENSITIVITY.has(sensitivity);
}

/**
 * The flat primitive form schema elicitation supports. Definitions the form
 * cannot express (objects, collections) are reported back so the caller can
 * say so instead of silently dropping contract.
 */
export function elicitationSchemaFromDefinitions(definitions: unknown): {
  schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  elicitable: StoredFieldDefinition[];
  skipped: string[];
} {
  const list = Array.isArray(definitions) ? (definitions as StoredFieldDefinition[]) : [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const elicitable: StoredFieldDefinition[] = [];
  const skipped: string[] = [];

  for (const definition of list) {
    const key = definition?.key;
    if (typeof key !== "string" || key.length === 0) continue;
    const valueType = typeof definition.valueType === "string" ? definition.valueType : "string";
    const schemaType = ELICITABLE_TYPES[valueType];
    if (!schemaType || definition.cardinality === "collection") {
      skipped.push(key);
      continue;
    }
    const property: Record<string, unknown> = { type: schemaType };
    const title = localized(definition.label);
    if (title) property.title = title;
    const description = localized(definition.description);
    if (description) property.description = description;
    const optionValues = (definition.options?.items ?? [])
      .map((item) => item?.value)
      .filter((value): value is string => typeof value === "string");
    if (optionValues.length > 0) property.enum = optionValues;
    const format = definition.validation?.format;
    if (typeof format === "string" && ["email", "uri", "date", "date-time"].includes(format)) {
      property.format = format;
    }
    properties[key] = property;
    if (definition.required === true) required.push(key);
    elicitable.push(definition);
  }

  return {
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    elicitable,
    skipped,
  };
}

const KEYRING_ENV = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";

function elicitedKeyring(): SecretKeyring | undefined {
  return keyringFromEnv(process.env[KEYRING_ENV]);
}

/**
 * Store accepted answers: secret-classified values encrypted with the
 * platform keyring (fail closed without one — a plaintext secret at rest is
 * worse than a refused create), everything else stored as answered.
 */
export function storeElicitedValues(
  table: string,
  elicitable: StoredFieldDefinition[],
  content: Record<string, unknown>,
  keyring: SecretKeyring | undefined = elicitedKeyring(),
): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  for (const definition of elicitable) {
    const key = definition.key as string;
    const value = content[key];
    if (value === undefined || value === null || value === "") {
      if (definition.required === true) {
        throw new HttpError(400, "VALIDATION", `Elicited value for "${key}" is required.`);
      }
      continue;
    }
    if (isSecretDefinition(definition)) {
      if (!keyring) {
        throw new HttpError(
          500,
          "SECRET_KEYRING_MISSING",
          `Field "${key}" is classified as secret, but no keyring is configured. ` +
            `Set ${KEYRING_ENV} (<keyId>:<base64 32-byte key>) — secrets are never stored in plaintext.`,
        );
      }
      stored[key] = encryptSecret(keyring, table, key, String(value));
      continue;
    }
    stored[key] = value;
  }
  return stored;
}

function looksLikeStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSecret).ciphertext === "string" &&
    typeof (value as StoredSecret).keyId === "string"
  );
}

/**
 * Read-side redaction for the elicited target field: encrypted values come
 * back as the `__set__` sentinel so a caller can tell "set, not shown" from
 * "not set" — and neither the value nor its ciphertext is ever advertised.
 */
export function redactElicitedValues(
  row: Record<string, unknown>,
  intoField: string,
): Record<string, unknown> {
  const values = row[intoField];
  if (!values || typeof values !== "object" || Array.isArray(values)) return row;
  const redacted = Object.fromEntries(
    Object.entries(values as Record<string, unknown>).map(([key, value]) => [
      key,
      looksLikeStoredSecret(value) ? SECRET_SET_SENTINEL : value,
    ]),
  );
  return { ...row, [intoField]: redacted };
}

/**
 * Full create-time flow: read the source row's definitions, elicit the
 * primitive ones from the person at the client, and return the argument set
 * with the stored (and where required, encrypted) values in place of
 * whatever the model sent for the target field.
 */
export async function collectElicitedValues(input: {
  server: Server;
  elicit: ElicitOnCreateEntry;
  sourceRow: Record<string, unknown> | null;
  values: Record<string, unknown>;
  /**
   * The in-flight tool call's request id. Without it the SDK would try to
   * deliver the elicitation request on a standalone notification stream the
   * client may never have opened; relating it routes the request onto the
   * SSE response stream of the call itself.
   */
  relatedRequestId: string | number;
  /** Server-known context shown above the form, e.g. the redirect URL to register first. */
  messagePrefix?: string;
}): Promise<Record<string, unknown>> {
  const { server, elicit, sourceRow, values, relatedRequestId } = input;
  if (!sourceRow) {
    throw new HttpError(
      404,
      "NOT_FOUND",
      `The ${elicit.sourceEntity} referenced by "${elicit.sourceField}" was not found.`,
    );
  }

  const { schema, elicitable, skipped } = elicitationSchemaFromDefinitions(
    sourceRow[elicit.definitionsField],
  );
  // Nothing to ask is not an error: a source without configuration fields
  // simply creates without a form.
  if (elicitable.length === 0) {
    const { [elicit.into]: _discarded, ...rest } = values;
    return rest;
  }

  if (!server.getClientCapabilities()?.elicitation) {
    throw new HttpError(
      400,
      "ELICITATION_UNSUPPORTED",
      `Creating this record collects configuration from the person at the client, but ` +
        `this client does not support MCP elicitation. Use a client that does; the values ` +
        `are deliberately not accepted as tool arguments.`,
    );
  }

  const secretKeys = elicitable
    .filter(isSecretDefinition)
    .map((definition) => definition.key as string);
  const composedMessage =
    elicit.message ??
    `Configuration for this ${elicit.sourceEntity}. ` +
      (secretKeys.length > 0
        ? `Values for ${secretKeys.join(", ")} are stored encrypted and never shown back. `
        : "") +
      (skipped.length > 0 ? `(Not collected in this form: ${skipped.join(", ")}.)` : "");

  const message = input.messagePrefix
    ? `${input.messagePrefix}\n\n${composedMessage}`
    : composedMessage;
  const result = await server.elicitInput(
    {
      message: message.trim(),
      requestedSchema: schema as never,
    },
    { relatedRequestId },
  );
  if (result.action !== "accept") {
    throw new HttpError(
      400,
      "ELICITATION_DECLINED",
      `Configuration entry was ${result.action === "decline" ? "declined" : "cancelled"}; nothing was created.`,
    );
  }

  return {
    ...values,
    [elicit.into]: storeElicitedValues(
      elicit.sourceTable,
      elicitable,
      (result.content ?? {}) as Record<string, unknown>,
    ),
  };
}
