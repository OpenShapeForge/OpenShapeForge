// SPDX-License-Identifier: BUSL-1.1
/**
 * Declarative execution of derived tools — stored rows all the way down.
 *
 * A derived tool's defining row carries ordered BINDINGS; each binding
 * references an OPERATION row (a declaratively described provider call),
 * which references a PROVIDER row (transport, base URL, auth metadata,
 * egress allow-list); the tenant's values for the provider live on a
 * CONNECTION row. Which entities play these parts is configuration
 * (`mcp.derivedTools.execution`); WHAT their fields mean is the canonical
 * vocabulary this module interprets:
 *
 *   provider row:   transport ("rest"), baseUrlTemplate, auth
 *                   { scheme: basic|bearer|header, usernameTemplate,
 *                     passwordFrom, headerName, tokenFrom }, egressHosts
 *   operation row:  kind, operation { method, pathTemplate },
 *                   inputFields, responseMapping { rootPath, fieldPaths }
 *   binding:        <operationRef>, order, inputMapping [{from,to}],
 *                   outputMapping [{from,to}]
 *   connection row: <connectionValuesField> — plain values and encrypted
 *                   StoredSecret values from create-time elicitation
 *
 * Fixed rules, not configuration:
 *   - No generated or loaded code: rows are data, this module is the only
 *     interpreter. REST only in this slice.
 *   - Egress is a grant: an empty/absent egressHosts refuses every call.
 *   - Secret values resolve ONLY into auth credentials — never into URLs,
 *     paths, query strings, bodies, or error messages.
 *   - Template placeholders form a closed vocabulary: connection value keys
 *     and operation inputs. An unresolved placeholder fails the call.
 */
import { HttpError } from "../rest/http-error.js";
import { hostAllowed } from "../connectors/executor.js";
import {
  decryptSecret,
  keyringFromEnv,
  type SecretKeyring,
  type StoredSecret,
} from "../connectors/secrets.js";

export type ExecutionCatalogEntry = {
  bindingsField: string;
  operationRef: string;
  operationEntity: string;
  operationTable: string;
  providerRef: string;
  providerEntity: string;
  providerTable: string;
  connectionEntity: string;
  connectionTable: string;
  connectionProviderRef: string;
  connectionValuesField: string;
};

type JsonRecord = Record<string, unknown>;

const KEYRING_ENV = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";
const REQUEST_TIMEOUT_MS = 15_000;

function looksLikeStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSecret).ciphertext === "string" &&
    typeof (value as StoredSecret).keyId === "string"
  );
}

/**
 * Connection values split by sensitivity. Secrets stay in their own bag so a
 * template resolver can be handed ONLY the plain half for URL positions.
 */
export function splitConnectionValues(
  values: unknown,
  decrypt: (secret: StoredSecret, field: string) => string,
): { plain: Record<string, string>; secret: Record<string, string> } {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  if (values && typeof values === "object" && !Array.isArray(values)) {
    for (const [key, value] of Object.entries(values as JsonRecord)) {
      if (looksLikeStoredSecret(value)) {
        secret[key] = decrypt(value, key);
      } else if (value !== null && value !== undefined && typeof value !== "object") {
        plain[key] = String(value);
      }
    }
  }
  return { plain, secret };
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/**
 * Resolve `{key}` placeholders from the given sources, failing closed on an
 * unknown key: a template reaching for a value that does not exist must never
 * silently produce a malformed URL or credential.
 */
export function resolveTemplate(
  template: string,
  sources: Record<string, string>,
  context: string,
): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = sources[key];
    if (value === undefined) {
      throw new HttpError(
        400,
        "TEMPLATE_UNRESOLVED",
        `Template placeholder "{${key}}" in ${context} has no value.`,
      );
    }
    return value;
  });
}

type AuthConfig = {
  scheme?: unknown;
  usernameTemplate?: unknown;
  passwordFrom?: unknown;
  headerName?: unknown;
  tokenFrom?: unknown;
};

/**
 * Auth headers from the provider's declarative auth block. Secrets enter here
 * and nowhere else. Providers without an interpretable scheme contribute no
 * header — a provider that needs none (or a mock) stays callable.
 */
export function buildAuthHeaders(
  auth: unknown,
  plain: Record<string, string>,
  secret: Record<string, string>,
): Record<string, string> {
  if (!auth || typeof auth !== "object") return {};
  const config = auth as AuthConfig;
  const credentialSources = { ...plain, ...secret };
  const secretByKey = (from: unknown, what: string): string => {
    if (typeof from !== "string" || from.length === 0) {
      throw new HttpError(400, "AUTH_MISCONFIGURED", `Provider auth ${what} is not configured.`);
    }
    const value = credentialSources[from];
    if (value === undefined) {
      throw new HttpError(
        400,
        "CONNECTION_INCOMPLETE",
        `Provider auth needs the connection value "${from}", which is not set.`,
      );
    }
    return value;
  };

  switch (config.scheme) {
    case "basic": {
      const username =
        typeof config.usernameTemplate === "string"
          ? resolveTemplate(config.usernameTemplate, credentialSources, "auth.usernameTemplate")
          : secretByKey(config.usernameTemplate, "usernameTemplate");
      const password = secretByKey(config.passwordFrom, "passwordFrom");
      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      return { authorization: `Basic ${encoded}` };
    }
    case "bearer":
      return { authorization: `Bearer ${secretByKey(config.tokenFrom, "tokenFrom")}` };
    case "header": {
      const name = typeof config.headerName === "string" ? config.headerName.trim() : "";
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
        throw new HttpError(400, "AUTH_MISCONFIGURED", "Provider auth headerName is not a valid header name.");
      }
      return { [name.toLowerCase()]: secretByKey(config.tokenFrom, "tokenFrom") };
    }
    default:
      return {};
  }
}

type Mapping = { from?: unknown; to?: unknown }[];

/** `[{from,to}]` applied to an object; absent mapping passes keys through. */
export function applyMapping(values: JsonRecord, mapping: unknown): JsonRecord {
  if (!Array.isArray(mapping) || mapping.length === 0) return { ...values };
  const mapped: JsonRecord = {};
  for (const entry of mapping as Mapping) {
    if (typeof entry?.from !== "string" || typeof entry?.to !== "string") continue;
    if (values[entry.from] !== undefined) mapped[entry.to] = values[entry.from];
  }
  return mapped;
}

/** Dot-path extraction, e.g. `data.tickets`; empty/absent path is identity. */
export function extractPath(value: unknown, path: unknown): unknown {
  if (typeof path !== "string" || path.length === 0) return value;
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as JsonRecord)[segment];
  }
  return current;
}

export type ExecuteBindingInput = {
  binding: JsonRecord;
  operationRow: JsonRecord;
  providerRow: JsonRecord;
  connectionValues: unknown;
  serviceInputs: JsonRecord;
  keyring?: SecretKeyring | undefined;
  fetchImpl?: typeof fetch;
  /** AAD scope the values were encrypted under (the elicitation source table). */
  secretScope: string;
};

/**
 * Execute ONE binding: map service inputs to operation inputs, build the
 * request from the canonical operation/provider fields, enforce egress, call,
 * and map the (optionally rootPath-extracted) response onto service outputs.
 */
export async function executeBinding(input: ExecuteBindingInput): Promise<JsonRecord> {
  const { binding, operationRow, providerRow, serviceInputs } = input;
  const keyring = input.keyring ?? keyringFromEnv(process.env[KEYRING_ENV]);
  const fetchImpl = input.fetchImpl ?? fetch;

  if (providerRow.transport !== "rest") {
    throw new HttpError(
      501,
      "NOT_IMPLEMENTED",
      `Transport "${String(providerRow.transport)}" is not executable yet; only rest is.`,
    );
  }

  const { plain, secret } = splitConnectionValues(input.connectionValues, (stored, field) => {
    if (!keyring) {
      throw new HttpError(
        500,
        "SECRET_KEYRING_MISSING",
        `A stored secret needs the keyring; set ${KEYRING_ENV}.`,
      );
    }
    return decryptSecret(keyring, input.secretScope, field, stored);
  });

  const operationInputs = applyMapping(serviceInputs, binding.inputMapping);
  const operation = (operationRow.operation ?? {}) as JsonRecord;
  const method = typeof operation.method === "string" ? operation.method.toUpperCase() : "GET";
  const pathTemplate = typeof operation.pathTemplate === "string" ? operation.pathTemplate : "";
  if (!pathTemplate.startsWith("/")) {
    throw new HttpError(400, "OPERATION_MISCONFIGURED", "Operation pathTemplate must start with /.");
  }

  // URL positions resolve from PLAIN values and inputs only — never secrets.
  const urlSources: Record<string, string> = {
    ...plain,
    ...Object.fromEntries(
      Object.entries(operationInputs)
        .filter(([, value]) => value !== null && typeof value !== "object")
        .map(([key, value]) => [key, String(value)]),
    ),
  };
  const baseUrl = resolveTemplate(
    typeof providerRow.baseUrlTemplate === "string" ? providerRow.baseUrlTemplate : "",
    plain,
    "provider baseUrlTemplate",
  );
  const usedInPath = new Set<string>();
  const path = pathTemplate.replace(PLACEHOLDER, (_match, key: string) => {
    const value = urlSources[key];
    if (value === undefined) {
      throw new HttpError(400, "TEMPLATE_UNRESOLVED", `Path placeholder "{${key}}" has no value.`);
    }
    usedInPath.add(key);
    return encodeURIComponent(value);
  });

  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "EGRESS_DENIED", "Only http(s) providers are executable.");
  }
  const egress = Array.isArray(providerRow.egressHosts)
    ? (providerRow.egressHosts as string[])
    : [];
  if (!hostAllowed(url.hostname, egress)) {
    throw new HttpError(
      403,
      "EGRESS_DENIED",
      `Provider host ${url.hostname} is not in the provider's egress allow-list.`,
    );
  }

  const remaining = Object.fromEntries(
    Object.entries(operationInputs).filter(([key]) => !usedInPath.has(key)),
  );
  const headers: Record<string, string> = {
    accept: "application/json",
    ...buildAuthHeaders(providerRow.auth, plain, secret),
  };
  let body: string | undefined;
  if (method === "GET" || method === "DELETE") {
    for (const [key, value] of Object.entries(remaining)) {
      if (value !== null && typeof value !== "object") url.searchParams.set(key, String(value));
    }
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(remaining);
  }

  const response = await fetchImpl(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      502,
      "PROVIDER_ERROR",
      `Provider answered ${response.status} for ${String(operationRow.key ?? "operation")}: ` +
        text.slice(0, 300),
    );
  }
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new HttpError(502, "PROVIDER_ERROR", "Provider response is not valid JSON.");
  }

  const responseMapping = (operationRow.responseMapping ?? {}) as JsonRecord;
  const extracted = extractPath(parsed, responseMapping.rootPath);
  const fieldPaths = Array.isArray(responseMapping.fieldPaths)
    ? (responseMapping.fieldPaths as { field?: unknown; path?: unknown }[])
    : [];
  let operationOutputs: JsonRecord;
  if (fieldPaths.length > 0 && extracted !== null && typeof extracted === "object") {
    operationOutputs = {};
    for (const entry of fieldPaths) {
      if (typeof entry.field !== "string") continue;
      operationOutputs[entry.field] = extractPath(extracted, entry.path);
    }
  } else {
    operationOutputs =
      extracted !== null && typeof extracted === "object" && !Array.isArray(extracted)
        ? (extracted as JsonRecord)
        : { result: extracted };
  }

  return applyMapping(operationOutputs, binding.outputMapping);
}

/** Bindings in authored order; a malformed entry fails closed by index. */
export function orderedBindings(row: JsonRecord, bindingsField: string): JsonRecord[] {
  const raw = row[bindingsField];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, "SERVICE_MISCONFIGURED", "The service defines no bindings.");
  }
  return (raw as JsonRecord[])
    .map((binding, index) => {
      if (!binding || typeof binding !== "object") {
        throw new HttpError(400, "SERVICE_MISCONFIGURED", `Binding ${index + 1} is malformed.`);
      }
      return binding;
    })
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
}
