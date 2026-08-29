// SPDX-License-Identifier: BUSL-1.1
/**
 * Publication-time validation of derived-tool definitions.
 *
 * A derived tool's defining row is ordinary data right up to the moment a
 * write makes it VISIBLE to its audience (`visibleWhen`): from then on it is
 * a live tool whose first call executes the row's binding chain. Publishing a
 * broken chain therefore ships a guaranteed runtime failure to the audience —
 * so the write that would make a row visible is validated here first, and
 * refused with a readable list of problems instead of persisted.
 *
 * What "usable" means is deliberately publication-grade, not call-grade:
 *   - the row's key must yield a projectable tool name that collides with
 *     neither a static tool nor another visible row;
 *   - every binding must resolve to an existing operation row, and every
 *     operation to an existing provider row;
 *   - every referenced provider must have a tenant-owned connection whose
 *     values satisfy the provider's required configuration definitions and
 *     the credential keys its auth block references.
 * Personal sign-in tokens are NOT required: for `oauth2AuthorizationCode`
 * providers consent happens per person AFTER publication, so publication
 * requires only the tenant connection carrying the OAuth client credentials.
 *
 * Validation reads rows through an injected reader so the rule stays a pure
 * interpretation of stored data, like declarative execution itself.
 */
import { HttpError } from "../rest/http-error.js";
import { deriveToolName, type DerivedToolsCatalogEntry } from "./derived-tools.js";

type JsonRecord = Record<string, unknown>;

/** Tenant-scoped row reader; the caller binds db/session/tables. */
export type PublicationRowReader = (
  table: string,
  filter: JsonRecord,
) => Promise<JsonRecord[]>;

const TEMPLATE_PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

function placeholderKeys(template: unknown): string[] {
  if (typeof template !== "string") return [];
  return [...template.matchAll(TEMPLATE_PLACEHOLDER)].map((match) => match[1]!);
}

function hasValue(values: JsonRecord, key: string): boolean {
  const value = values[key];
  return value !== undefined && value !== null && value !== "";
}

/**
 * The connection-value keys a provider's auth block will resolve at call
 * time. Only keys that come from the CONNECTION are listed — operation
 * inputs and runtime-issued tokens are not publication concerns.
 */
export function requiredAuthValueKeys(auth: unknown): string[] {
  if (!auth || typeof auth !== "object") return [];
  const config = auth as JsonRecord;
  // Personal sign-in: the tenant connection holds only the OAuth client that
  // later mints each person's tokens. Scheme-derived keys (bearer/header
  // token fields) are issued by the runtime AFTER consent, so requiring them
  // here would demand a value no person could have — found live as
  // "Missing required values: access_token" on a correct setup.
  if (config.profile === "oauth2AuthorizationCode") {
    return ["clientId", "clientSecret"];
  }
  const keys = new Set<string>();
  switch (config.scheme) {
    case "basic":
      for (const key of placeholderKeys(config.usernameTemplate)) keys.add(key);
      if (typeof config.passwordFrom === "string") keys.add(config.passwordFrom);
      break;
    case "bearer":
    case "header":
      if (typeof config.tokenFrom === "string") keys.add(config.tokenFrom);
      break;
    case "oauth2ClientCredentials":
      keys.add(typeof config.clientIdFrom === "string" ? config.clientIdFrom : "clientId");
      keys.add(
        typeof config.clientSecretFrom === "string" ? config.clientSecretFrom : "clientSecret",
      );
      break;
    default:
      break;
  }
  return [...keys];
}

/** Keys of required definitions in a stored FieldDefinition collection. */
function requiredDefinitionKeys(definitions: unknown): string[] {
  if (!Array.isArray(definitions)) return [];
  return (definitions as JsonRecord[])
    .filter((definition) => definition?.required === true && typeof definition.key === "string")
    .map((definition) => definition.key as string);
}

export type ValidateVisibleDefinitionInput = {
  entry: DerivedToolsCatalogEntry;
  /** The row exactly as the write would store it. */
  row: JsonRecord;
  /** Excluded from the sibling-collision check (the row being updated). */
  rowId?: string | undefined;
  /** Static tool names a derived name may never shadow. */
  reservedNames: ReadonlySet<string>;
  /** Field on the provider row holding its FieldDefinition collection, if declared. */
  providerDefinitionsField?: string | undefined;
  readRows: PublicationRowReader;
};

/**
 * Throws HttpError(400, NOT_PUBLISHABLE) listing every problem found, or
 * returns silently when the row is fit to be visible. Callers invoke this
 * only for writes whose RESULT matches the entry's `visibleWhen` predicate.
 */
export async function validateVisibleDefinition(
  input: ValidateVisibleDefinitionInput,
): Promise<void> {
  const { entry, row, readRows } = input;
  const execution = entry.execution;
  if (!execution) return;
  const problems: string[] = [];

  const name = deriveToolName(row[entry.keyField]);
  if (!name) {
    problems.push(
      `the ${entry.keyField} value ${JSON.stringify(row[entry.keyField])} does not yield ` +
        `a usable tool name (lowercase letters, digits, hyphens).`,
    );
  } else if (input.reservedNames.has(name)) {
    problems.push(`the tool name "${name}" is reserved by the product's own tools.`);
  } else if (entry.visibleWhen) {
    const siblings = await readRows(entry.table, {
      [entry.visibleWhen.field]: entry.visibleWhen.equals,
    });
    const shadowed = siblings.find(
      (sibling) =>
        String(sibling.id ?? "") !== (input.rowId ?? "") &&
        deriveToolName(sibling[entry.keyField]) === name,
    );
    if (shadowed) {
      problems.push(
        `another visible ${entry.entity} (${JSON.stringify(shadowed[entry.keyField])}) ` +
          `already provides the tool name "${name}".`,
      );
    }
  }

  const bindingsRaw = row[execution.bindingsField];
  const bindings = Array.isArray(bindingsRaw) ? (bindingsRaw as JsonRecord[]) : [];
  if (bindings.length === 0) {
    problems.push(`the ${execution.bindingsField} collection is empty; nothing would execute.`);
  }

  // Provider rows collected across bindings so each connection is judged once.
  const providers = new Map<string, JsonRecord>();
  for (const [index, binding] of bindings.entries()) {
    const position = `binding ${index + 1}`;
    if (!binding || typeof binding !== "object") {
      problems.push(`${position} is not an object.`);
      continue;
    }
    const operationId = binding[execution.operationRef];
    if (typeof operationId !== "string" || operationId.length === 0) {
      problems.push(`${position} names no ${execution.operationEntity} (${execution.operationRef}).`);
      continue;
    }
    const [operationRow] = await readRows(execution.operationTable, { id: operationId });
    if (!operationRow) {
      problems.push(
        `${position} references ${execution.operationEntity} ${operationId}, which does not exist.`,
      );
      continue;
    }
    const providerId = operationRow[execution.providerRef];
    if (typeof providerId !== "string" || providerId.length === 0) {
      problems.push(
        `${position}: ${execution.operationEntity} ` +
          `${JSON.stringify(operationRow.key ?? operationId)} names no ${execution.providerEntity}.`,
      );
      continue;
    }
    if (!providers.has(providerId)) {
      const [providerRow] = await readRows(execution.providerTable, { id: providerId });
      if (!providerRow) {
        problems.push(
          `${position}: ${execution.operationEntity} ` +
            `${JSON.stringify(operationRow.key ?? operationId)} references ` +
            `${execution.providerEntity} ${providerId}, which does not exist.`,
        );
        continue;
      }
      providers.set(providerId, providerRow);
    }
  }

  for (const [providerId, providerRow] of providers) {
    const providerName = String(providerRow.name ?? providerRow.key ?? providerId);
    const connections = await readRows(execution.connectionTable, {
      [execution.connectionProviderRef]: providerId,
    });
    const tenantConnection = connections.find((connection) => !connection.ownerUserId);
    if (!tenantConnection) {
      problems.push(
        `no ${execution.connectionEntity} is configured for ${execution.providerEntity} ` +
          `"${providerName}"; create one first.`,
      );
      continue;
    }
    const values = (tenantConnection[execution.connectionValuesField] ?? {}) as JsonRecord;
    const missing = new Set<string>();
    if (input.providerDefinitionsField) {
      for (const key of requiredDefinitionKeys(providerRow[input.providerDefinitionsField])) {
        if (!hasValue(values, key)) missing.add(key);
      }
    }
    for (const key of requiredAuthValueKeys(providerRow.auth)) {
      if (!hasValue(values, key)) missing.add(key);
    }
    if (missing.size > 0) {
      problems.push(
        `the ${execution.connectionEntity} for ${execution.providerEntity} "${providerName}" ` +
          `is missing required configuration values: ${[...missing].sort().join(", ")}.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new HttpError(
      400,
      "NOT_PUBLISHABLE",
      `This ${entry.entity} cannot be made visible to its audience yet:\n` +
        problems.map((problem) => `- ${problem}`).join("\n"),
    );
  }
}
