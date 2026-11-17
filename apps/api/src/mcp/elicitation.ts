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
import { localizedText, type ResolvedLocale } from "./locale.js";
import type { Server } from "@modelcontextprotocol/server";
import { HttpError } from "../rest/http-error.js";
import {
  encryptSecret,
  keyringFromEnv,
  type SecretKeyring,
} from "../connectors/secrets.js";
// One policy, one source: the same set decides what is encrypted at rest
// (here) and what is barred from URL positions (declarative-execution).
import { SECRET_SENSITIVITY } from "./declarative-execution.js";
import { storedFieldBaseType } from "../modules/field-schemas.js";
import { staticSecretScopeFor } from "../modules/entity-secrets.js";
import type { RuntimeSecureInputField } from "@openshapeforge/plugin-runtime";

/** The definitions live on another entity's row (a provider's configuration contract). */
export type SourcedElicitEntry = {
  sourceField: string;
  sourceEntity: string;
  sourceTable: string;
  definitionsField: string;
  into: string;
  message?: string;
  fields?: undefined;
  resolve?: undefined;
  rotation?: undefined;
};

/** The definitions are declared with the entity's own create Operation. */
export type StaticElicitEntry = {
  into: string;
  message?: string;
  fields: readonly RuntimeSecureInputField[];
  resolve?: { operations: readonly string[]; egress: { urlField: string } };
  rotation?: true;
  sourceField?: undefined;
  sourceEntity?: undefined;
  sourceTable?: undefined;
  definitionsField?: undefined;
};

export type ElicitOnCreateEntry = SourcedElicitEntry | StaticElicitEntry;

/** The compiled secure-input declaration as a static entry, if it is one. */
export function staticElicitEntry(
  secure: { into: string; message?: string; fields?: readonly RuntimeSecureInputField[];
    resolve?: StaticElicitEntry["resolve"]; rotation?: true } | undefined,
): StaticElicitEntry | undefined {
  if (!secure?.fields) return undefined;
  return {
    into: secure.into,
    fields: secure.fields,
    ...(secure.message ? { message: secure.message } : {}),
    ...(secure.resolve ? { resolve: secure.resolve } : {}),
    ...(secure.rotation ? { rotation: true as const } : {}),
  };
}

/**
 * The AAD scope a static entry's values are sealed under, from the ordinary
 * values of the record being written. Refused before anyone is asked for a
 * secret when the record's URL cannot be a destination at all.
 */
export function staticElicitScope(
  elicit: StaticElicitEntry,
  table: string,
  tenantId: string | null | undefined,
  values: Readonly<Record<string, unknown>>,
): string {
  if (!tenantId) throw new HttpError(403, "FORBIDDEN", "A tenant session is required.");
  const scope = staticSecretScopeFor(elicit, table, tenantId, values);
  if (!scope.ok) {
    throw new HttpError(
      400,
      "VALIDATION",
      `"${elicit.resolve!.egress.urlField}" must be an HTTPS URL naming one exact host, without credentials or a fragment. ` +
        "Credentials belong in a header, not in the URL.",
    );
  }
  return scope.scope;
}

type StoredFieldDefinition = {
  key?: unknown;
  osfType?: unknown;
  cardinality?: unknown;
  required?: unknown;
  label?: unknown;
  description?: unknown;
  validation?: Record<string, unknown>;
  options?: { items?: { value?: unknown }[] };
  classification?: { sensitivity?: unknown };
};

/**
 * The form a person actually reads, so it is resolved in THEIR language rather
 * than English-first (`mcp/locale.ts`). `locale` is optional because the two
 * non-MCP callers of `elicitationSchemaFromDefinitions` — the browser
 * configuration form and the handoff bookkeeping — carry a request context of
 * their own and have not been given one yet; they keep the English-first
 * fallback the resolver ends with.
 */
function localized(value: unknown, locale?: ResolvedLocale): string | undefined {
  return localizedText(value, locale);
}

const ELICITABLE_TYPES: Record<string, string> = {
  string: "string",
  integer: "integer",
  number: "number",
  boolean: "boolean",
};

export function isSecretDefinition(definition: StoredFieldDefinition): boolean {
  const sensitivity = definition.classification?.sensitivity;
  return typeof sensitivity === "string" && SECRET_SENSITIVITY.has(sensitivity);
}

/**
 * The flat primitive form schema elicitation supports. Definitions the form
 * cannot express (objects, collections) are reported back so the caller can
 * say so instead of silently dropping contract.
 */
export function elicitationSchemaFromDefinitions(
  definitions: unknown,
  locale?: ResolvedLocale,
): {
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
    const valueType = storedFieldBaseType(definition);
    const schemaType = ELICITABLE_TYPES[valueType];
    if (!schemaType || definition.cardinality === "collection") {
      skipped.push(key);
      continue;
    }
    const property: Record<string, unknown> = { type: schemaType };
    const title = localized(definition.label, locale);
    if (title) property.title = title;
    const description = localized(definition.description, locale);
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
      // Elicitation only ever asks for primitives, so anything else here is a
      // client that ignored the schema; `String(value)` would encrypt
      // "[object Object]" and the person would never find out.
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new HttpError(
          400,
          "VALIDATION",
          `Elicited value for "${key}" must be a string, number or boolean.`,
        );
      }
      stored[key] = encryptSecret(keyring, table, key, String(value));
      continue;
    }
    stored[key] = value;
  }
  return stored;
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
  /** The language the form's labels and descriptions are shown in. */
  locale?: ResolvedLocale;
  /** The AAD scope of a static entry's values; a sourced entry seals under its source table. */
  secretScope?: string;
}): Promise<Record<string, unknown>> {
  const { server, elicit, sourceRow, values, relatedRequestId } = input;
  if (!elicit.fields && !sourceRow) {
    throw new HttpError(
      404,
      "NOT_FOUND",
      `The ${elicit.sourceEntity} referenced by "${elicit.sourceField}" was not found.`,
    );
  }
  if (elicit.fields && !input.secretScope) {
    throw new HttpError(500, "INTERNAL", "Static secure input requires its storage scope.");
  }

  const { schema, elicitable, skipped } = elicitationSchemaFromDefinitions(
    elicit.fields ?? sourceRow![elicit.definitionsField],
    input.locale,
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
    `Configuration for this ${elicit.sourceEntity ?? "record"}. ` +
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
    // A person answers this form, often after a detour through a provider
    // portal to register an OAuth client or fetch values from a password
    // manager. The SDK's default 60-second request timeout is machine-scale
    // and cancels the form under them — and ten minutes proved too short for
    // the portal detour in live testing. Give them thirty.
    { relatedRequestId, timeout: 30 * 60 * 1000 },
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
      elicit.fields ? input.secretScope! : elicit.sourceTable,
      elicitable,
      (result.content ?? {}) as Record<string, unknown>,
    ),
  };
}
