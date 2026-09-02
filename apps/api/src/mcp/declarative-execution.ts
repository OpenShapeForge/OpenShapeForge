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
import { randomUUID } from "node:crypto";
import { HttpError } from "../rest/http-error.js";
import { hostAllowed } from "../connectors/executor.js";
import {
  ProviderObservations,
  ProviderOutcomeError,
  classifyProviderOutcome,
  providerOutcomeMessage,
} from "../connectors/provider-outcome.js";
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
const MAX_REDIRECTS = 5;

/** Follow redirects only while every hop remains inside the authored grant. */
export async function fetchWithAllowedRedirects(
  input: string | URL,
  init: RequestInit,
  allowlist: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let url = new URL(input);
  let requestInit = { ...init };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !hostAllowed(url.hostname, allowlist)
    ) {
      throw new HttpError(
        403,
        "EGRESS_DENIED",
        `Redirect host ${url.hostname} is outside the egress allow-list.`,
      );
    }
    const response = await fetchImpl(url, {
      ...requestInit,
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (hop === MAX_REDIRECTS) {
      throw new HttpError(
        502,
        "PROVIDER_ERROR",
        "Provider exceeded the redirect limit.",
      );
    }
    url = new URL(location, url);
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        requestInit.method === "POST")
    ) {
      const headers = new Headers(requestInit.headers);
      headers.delete("content-type");
      headers.delete("content-length");
      requestInit = { ...requestInit, method: "GET", headers };
      delete requestInit.body;
    }
  }
  throw new HttpError(
    502,
    "PROVIDER_ERROR",
    "Provider redirect handling failed.",
  );
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
 * Connection values split by sensitivity. Secrets stay in their own bag so a
 * template resolver can be handed ONLY the plain half for URL positions.
 * `urlSafeKeys` names encrypted fields whose CLASSIFICATION is not secret —
 * those decrypt into the plain half, because encryption at rest is storage
 * hygiene while the classification is the policy.
 */
export function splitConnectionValues(
  values: unknown,
  decrypt: (secret: StoredSecret, field: string) => string,
  urlSafeKeys?: ReadonlySet<string>,
): { plain: Record<string, string>; secret: Record<string, string> } {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  if (values && typeof values === "object" && !Array.isArray(values)) {
    for (const [key, value] of Object.entries(values as JsonRecord)) {
      if (looksLikeStoredSecret(value)) {
        const target = urlSafeKeys?.has(key) ? plain : secret;
        target[key] = decrypt(value, key);
      } else if (
        value !== null &&
        value !== undefined &&
        typeof value !== "object"
      ) {
        plain[key] = String(value);
      }
    }
  }
  return { plain, secret };
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/**
 * Sensitivities whose values are stored encrypted at rest AND barred from URL
 * positions. Storage and policy are deliberately separate: a value encrypted
 * at rest whose field is NOT classified here may still resolve into URLs (the
 * runtime decrypts it), so reclassifying a field frees its stored value
 * without anyone re-entering it.
 */
export const SECRET_SENSITIVITY = new Set(["confidential", "pii", "bsn"]);

type FieldDefinition = {
  key?: unknown;
  classification?: { sensitivity?: unknown };
};

/** Field keys the given definitions classify as secret (see SECRET_SENSITIVITY). */
export function secretFieldKeys(definitions: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(definitions)) return keys;
  for (const definition of definitions as FieldDefinition[]) {
    const sensitivity = definition?.classification?.sensitivity;
    if (
      typeof definition?.key === "string" &&
      typeof sensitivity === "string" &&
      SECRET_SENSITIVITY.has(sensitivity)
    ) {
      keys.add(definition.key);
    }
  }
  return keys;
}

/** All field keys the given definitions declare. */
export function definitionFieldKeys(definitions: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(definitions)) return keys;
  for (const definition of definitions as FieldDefinition[]) {
    if (typeof definition?.key === "string") keys.add(definition.key);
  }
  return keys;
}

/** The `{placeholder}` keys one template string references. */
export function templatePlaceholders(template: unknown): string[] {
  if (typeof template !== "string") return [];
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

/**
 * Every canonical URL-position template a provider row declares, with the
 * context name errors use. These are the positions secret values must never
 * reach.
 */
export function providerUrlTemplates(
  providerRow: JsonRecord,
): Array<{ context: string; template: string }> {
  const auth = (providerRow.auth ?? null) as JsonRecord | null;
  const probe = (providerRow.probe ?? null) as JsonRecord | null;
  return [
    { context: "baseUrlTemplate", template: providerRow.baseUrlTemplate },
    { context: "probe pathTemplate", template: probe?.pathTemplate },
    { context: "auth.authorizationUrl", template: auth?.authorizationUrl },
    { context: "auth.tokenUrl", template: auth?.tokenUrl },
  ].filter(
    (entry): entry is { context: string; template: string } =>
      typeof entry.template === "string" && entry.template.length > 0,
  );
}

/**
 * The refusal for a URL template that reaches for a secret-classified field —
 * readable and self-healing, because the correct fix (reclassify a value that
 * was never truly a secret) is one the caller can apply directly.
 */
export function secretUrlPlaceholderError(
  key: string,
  context: string,
): HttpError {
  return new HttpError(
    400,
    "SECRET_IN_URL_TEMPLATE",
    `The "{${key}}" placeholder in ${context} references a field classified as a secret, ` +
      `and secret values only ever resolve into request authentication — never into URLs. ` +
      `If the value is not truly a secret (tenant subdomains, hostnames and regions are not), ` +
      `change that field's classification to internal; its stored value then works as-is, ` +
      `nothing needs re-entering.`,
  );
}

/**
 * Whether a call selects this binding. A binding may declare
 * `when: { field, equals }` against ONE service input: it runs when that
 * input equals the value OR was not provided (an omitted selector means
 * "all sources" — the combined read), and is skipped silently when the call
 * names a different value. This is what routes one canonical intent
 * (tasks, mail) to exactly one of several providers through a plain
 * `provider` input instead of per-provider employee tools. Write intents
 * should declare the selector input as required, so a change can never fan
 * out to every provider at once.
 */
export function bindingSelected(
  binding: JsonRecord,
  args: JsonRecord,
): boolean {
  const when = binding.when as JsonRecord | null | undefined;
  if (!when || typeof when !== "object") return true;
  const field = typeof when.field === "string" ? when.field : "";
  if (!field) return true;
  const value = args[field];
  if (value === undefined || value === null) return true;
  if (value === "") return false;
  return String(value) === String(when.equals);
}

/**
 * Resolve `{key}` placeholders from the given sources, failing closed on an
 * unknown key: a template reaching for a value that does not exist must never
 * silently produce a malformed URL or credential. When the missing key is in
 * `secretKeys`, the error explains the classification cause instead of
 * reading like a data-entry gap.
 */
export function resolveTemplate(
  template: string,
  sources: Record<string, string>,
  context: string,
  secretKeys?: ReadonlySet<string>,
): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = sources[key];
    if (value === undefined) {
      if (secretKeys?.has(key)) throw secretUrlPlaceholderError(key, context);
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
  tokenUrl?: unknown;
  scopes?: unknown;
  clientIdFrom?: unknown;
  clientSecretFrom?: unknown;
};

/**
 * Client-credentials tokens cached per (tokenUrl, clientId) until shortly
 * before expiry, so a burst of tool calls costs one token round-trip. The
 * cache holds bearer tokens only — never the client secret.
 */
const oauthTokenCache = new Map<
  string,
  { token: string; expiresAtMs: number }
>();

async function clientCredentialsToken(input: {
  config: AuthConfig;
  plain: Record<string, string>;
  secret: Record<string, string>;
  egress: readonly string[];
  fetchImpl: typeof fetch;
}): Promise<string> {
  const { config } = input;
  const tokenUrlRaw =
    typeof config.tokenUrl === "string" ? config.tokenUrl : "";
  const credentialSources = { ...input.plain, ...input.secret };
  const tokenUrl = new URL(
    resolveTemplate(tokenUrlRaw, input.plain, "auth.tokenUrl"),
  );
  if (tokenUrl.protocol !== "https:" && tokenUrl.protocol !== "http:") {
    throw new HttpError(
      400,
      "EGRESS_DENIED",
      "Only http(s) token endpoints are supported.",
    );
  }
  if (!hostAllowed(tokenUrl.hostname, input.egress)) {
    throw new HttpError(
      403,
      "EGRESS_DENIED",
      `Token endpoint host ${tokenUrl.hostname} is not in the provider's egress allow-list.`,
    );
  }
  const clientIdKey =
    typeof config.clientIdFrom === "string" ? config.clientIdFrom : "clientId";
  const clientSecretKey =
    typeof config.clientSecretFrom === "string"
      ? config.clientSecretFrom
      : "clientSecret";
  const clientId = credentialSources[clientIdKey];
  const clientSecret = credentialSources[clientSecretKey];
  if (clientId === undefined || clientSecret === undefined) {
    throw new HttpError(
      400,
      "CONNECTION_INCOMPLETE",
      `OAuth client credentials need the connection values "${clientIdKey}" and "${clientSecretKey}".`,
    );
  }

  const cacheKey = `${tokenUrl.href}\u0000${clientId}`;
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) return cached.token;

  const form = new URLSearchParams({ grant_type: "client_credentials" });
  const scopes = Array.isArray(config.scopes)
    ? (config.scopes as unknown[]).filter(
        (scope): scope is string => typeof scope === "string",
      )
    : [];
  if (scopes.length > 0) form.set("scope", scopes.join(" "));
  const response = await fetchWithAllowedRedirects(
    tokenUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        accept: "application/json",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    input.egress,
    input.fetchImpl,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      502,
      "TOKEN_ENDPOINT_ERROR",
      `Token endpoint answered ${response.status}.`,
    );
  }
  let payload: { access_token?: unknown; expires_in?: unknown };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new HttpError(
      502,
      "TOKEN_ENDPOINT_ERROR",
      "Token endpoint response is not JSON.",
    );
  }
  if (typeof payload.access_token !== "string") {
    throw new HttpError(
      502,
      "TOKEN_ENDPOINT_ERROR",
      "Token endpoint returned no access_token.",
    );
  }
  const expiresInS =
    typeof payload.expires_in === "number" ? payload.expires_in : 300;
  oauthTokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAtMs: Date.now() + Math.max(0, expiresInS - 60) * 1000,
  });
  return payload.access_token;
}

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
      throw new HttpError(
        400,
        "AUTH_MISCONFIGURED",
        `Provider auth ${what} is not configured.`,
      );
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
          ? resolveTemplate(
              config.usernameTemplate,
              credentialSources,
              "auth.usernameTemplate",
            )
          : secretByKey(config.usernameTemplate, "usernameTemplate");
      const password = secretByKey(config.passwordFrom, "passwordFrom");
      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      return { authorization: `Basic ${encoded}` };
    }
    case "bearer":
      return {
        authorization: `Bearer ${secretByKey(config.tokenFrom, "tokenFrom")}`,
      };
    case "header": {
      const name =
        typeof config.headerName === "string" ? config.headerName.trim() : "";
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
        throw new HttpError(
          400,
          "AUTH_MISCONFIGURED",
          "Provider auth headerName is not a valid header name.",
        );
      }
      return {
        [name.toLowerCase()]: secretByKey(config.tokenFrom, "tokenFrom"),
      };
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
    if (typeof entry?.from !== "string" || typeof entry?.to !== "string")
      continue;
    if (values[entry.from] !== undefined) mapped[entry.to] = values[entry.from];
  }
  return mapped;
}

/** Set a value at a dot path, creating intermediate objects. */
export function setPath(
  target: JsonRecord,
  path: string,
  value: unknown,
): void {
  const segments = path.split(".");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "__proto__" || segment === "prototype",
    )
  ) {
    throw new HttpError(
      400,
      "BAD_USER_INPUT",
      "Mapped body paths contain an unsafe segment.",
    );
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as JsonRecord;
  }
  current[segments[segments.length - 1]!] = value;
}

/**
 * Dot-path extraction, e.g. `data.tickets`; empty/absent path is identity.
 * `$` is identity too, and a `$.` prefix is stripped — authors reach for
 * JSONPath spellings, and refusing them silently lost whole result sets.
 */
export function extractPath(value: unknown, path: unknown): unknown {
  if (typeof path !== "string" || path.length === 0 || path === "$")
    return value;
  const trimmed = path.startsWith("$.") ? path.slice(2) : path;
  let current: unknown = value;
  for (const segment of trimmed.split(".")) {
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
  /**
   * The provider's configuration field definitions. Their classifications
   * decide which encrypted values may resolve into URL positions; without
   * them, every encrypted value is treated as secret.
   */
  providerDefinitions?: unknown;
};

/**
 * Execute ONE binding: map service inputs to operation inputs, build the
 * request from the canonical operation/provider fields, enforce egress, call,
 * and map the (optionally rootPath-extracted) response onto service outputs.
 */
/** All schemes; the OAuth one needs I/O, so acquisition is async. */
export async function acquireAuthHeaders(input: {
  auth: unknown;
  plain: Record<string, string>;
  secret: Record<string, string>;
  egress: readonly string[];
  fetchImpl: typeof fetch;
}): Promise<Record<string, string>> {
  const config =
    input.auth && typeof input.auth === "object"
      ? (input.auth as AuthConfig)
      : undefined;
  if (config?.scheme === "oauth2ClientCredentials") {
    const token = await clientCredentialsToken({
      config,
      plain: input.plain,
      secret: input.secret,
      egress: input.egress,
      fetchImpl: input.fetchImpl,
    });
    return { authorization: `Bearer ${token}` };
  }
  return buildAuthHeaders(input.auth, input.plain, input.secret);
}

/**
 * Placeholder auth headers for composition WITHOUT credentials: the header
 * names and shapes are real, the values describe where the value would come
 * from. Secrets are never decrypted on this path.
 */
export function describeAuthHeaders(auth: unknown): Record<string, string> {
  if (!auth || typeof auth !== "object") return {};
  const config = auth as AuthConfig;
  switch (config.scheme) {
    case "basic":
      return { authorization: "Basic <credentials from the connection>" };
    case "bearer":
      return {
        authorization: `Bearer <value of "${String(config.tokenFrom ?? "?")}" from the connection>`,
      };
    case "header": {
      const name =
        typeof config.headerName === "string" ? config.headerName.trim() : "";
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) return {};
      return {
        [name.toLowerCase()]: `<value of "${String(config.tokenFrom ?? "?")}" from the connection>`,
      };
    }
    case "oauth2ClientCredentials":
      return {
        authorization: `Bearer <token from ${String(config.tokenUrl ?? "the token endpoint")}>`,
      };
    default:
      return {};
  }
}

export type ComposedRequest = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
};

/**
 * Compose the provider request for ONE binding — everything up to but not
 * including the network call. Mode "acquire" resolves real credentials
 * (including the client-credentials token round-trip); mode "describe" never
 * touches a secret and substitutes placeholder auth headers, which is what
 * makes a dry run safe to show.
 */
export async function composeBindingRequest(
  input: ExecuteBindingInput & { mode?: "acquire" | "describe" },
): Promise<ComposedRequest> {
  const { binding, operationRow, providerRow, serviceInputs } = input;
  const mode = input.mode ?? "acquire";
  const keyring = input.keyring ?? keyringFromEnv(process.env[KEYRING_ENV]);
  const fetchImpl = input.fetchImpl ?? fetch;

  const transport = providerRow.transport;
  if (transport !== "rest" && transport !== "graphql") {
    throw new HttpError(
      501,
      "NOT_IMPLEMENTED",
      `Transport "${String(transport)}" is not executable; rest and graphql are.`,
    );
  }

  const secretKeys = secretFieldKeys(input.providerDefinitions);
  const urlSafeKeys = new Set(
    [...definitionFieldKeys(input.providerDefinitions)].filter(
      (key) => !secretKeys.has(key),
    ),
  );
  const { plain, secret } = splitConnectionValues(
    input.connectionValues,
    (stored, field) => {
      // Composition-only mode never decrypts a SECRET: auth headers are
      // described rather than built. Encrypted fields whose classification is
      // not secret still decrypt — URL positions need their real values, and
      // the policy says they are safe to show.
      if (mode === "describe" && !urlSafeKeys.has(field)) return "<secret>";
      if (!keyring) {
        throw new HttpError(
          500,
          "SECRET_KEYRING_MISSING",
          `A stored secret needs the keyring; set ${KEYRING_ENV}.`,
        );
      }
      return decryptSecret(keyring, input.secretScope, field, stored);
    },
    urlSafeKeys,
  );

  const operationInputs = applyMapping(serviceInputs, binding.inputMapping);
  const operation = (operationRow.operation ?? {}) as JsonRecord;
  const isGraphql = transport === "graphql";
  const method = isGraphql
    ? "POST"
    : typeof operation.method === "string"
      ? operation.method.toUpperCase()
      : "GET";
  // GraphQL posts to the endpoint itself; a pathTemplate is optional there
  // (e.g. "/graphql") and required for REST.
  const pathTemplate =
    typeof operation.pathTemplate === "string" ? operation.pathTemplate : "";
  if (!isGraphql && !pathTemplate.startsWith("/")) {
    throw new HttpError(
      400,
      "OPERATION_MISCONFIGURED",
      "Operation pathTemplate must start with /.",
    );
  }
  if (isGraphql && typeof operation.graphqlOperation !== "string") {
    throw new HttpError(
      400,
      "OPERATION_MISCONFIGURED",
      "A graphql operation needs operation.graphqlOperation.",
    );
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
    typeof providerRow.baseUrlTemplate === "string"
      ? providerRow.baseUrlTemplate
      : "",
    plain,
    "provider baseUrlTemplate",
    secretKeys,
  );
  const usedInPath = new Set<string>();
  const path = (isGraphql && pathTemplate === "" ? "" : pathTemplate).replace(
    PLACEHOLDER,
    (_match, key: string) => {
      const value = urlSources[key];
      if (value === undefined) {
        if (secretKeys.has(key))
          throw secretUrlPlaceholderError(key, "operation pathTemplate");
        throw new HttpError(
          400,
          "TEMPLATE_UNRESOLVED",
          `Path placeholder "{${key}}" has no value.`,
        );
      }
      usedInPath.add(key);
      return encodeURIComponent(value);
    },
  );

  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(
      400,
      "EGRESS_DENIED",
      "Only http(s) providers are executable.",
    );
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

  // Canonical request mapping: inputs may be renamed into query parameters
  // and placed at dot paths inside the JSON body — provider APIs rarely
  // accept a flat echo of the input contract. Unmapped inputs keep the
  // default placement (query for reads, top-level body for writes).
  const requestMapping = (operationRow.requestMapping ?? {}) as JsonRecord;
  const mappedBody: JsonRecord = {};
  const queryRenames = Array.isArray(requestMapping.queryParams)
    ? (requestMapping.queryParams as { field?: unknown; param?: unknown }[])
    : [];
  const bodyPaths = Array.isArray(requestMapping.bodyPaths)
    ? (requestMapping.bodyPaths as { field?: unknown; path?: unknown }[])
    : [];
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(mode === "describe"
      ? describeAuthHeaders(providerRow.auth)
      : await acquireAuthHeaders({
          auth: providerRow.auth,
          plain,
          secret,
          egress,
          fetchImpl,
        })),
  };
  let body: string | undefined;
  if (isGraphql) {
    headers["content-type"] = "application/json";
    body = JSON.stringify({
      query: operation.graphqlOperation,
      variables: remaining,
    });
  } else {
    for (const entry of queryRenames) {
      if (typeof entry.field !== "string" || typeof entry.param !== "string")
        continue;
      const value = remaining[entry.field];
      if (value !== undefined && value !== null && typeof value !== "object") {
        url.searchParams.set(entry.param, String(value));
      }
      delete remaining[entry.field];
    }
    for (const entry of bodyPaths) {
      if (typeof entry.field !== "string" || typeof entry.path !== "string")
        continue;
      const value = remaining[entry.field];
      if (value !== undefined) setPath(mappedBody, entry.path, value);
      delete remaining[entry.field];
    }
    if (method === "GET" || method === "DELETE") {
      for (const [key, value] of Object.entries(remaining)) {
        if (value !== null && typeof value !== "object")
          url.searchParams.set(key, String(value));
      }
      if (Object.keys(mappedBody).length > 0) {
        throw new HttpError(
          400,
          "OPERATION_MISCONFIGURED",
          "requestMapping.bodyPaths cannot apply to a GET or DELETE operation.",
        );
      }
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ ...remaining, ...mappedBody });
    }
  }

  return { method, url, headers, ...(body !== undefined ? { body } : {}) };
}

function operationSubject(operationRow: JsonRecord): string {
  return `Operation "${String(operationRow.key ?? "operation")}"`;
}

/**
 * Declarative provider calls classify only what the platform observed. Their
 * bodies and arbitrary response metadata never enter this error.
 */
function providerFailure(
  operationRow: JsonRecord,
  response?: Response,
  message?: string,
): ProviderOutcomeError {
  const observations = new ProviderObservations(randomUUID());
  if (response) observations.observe(response);
  const observation = observations.last();
  const outcome = classifyProviderOutcome({
    correlationId: observations.correlationId,
    observation,
    retryAllowed: false,
    now: Date.now(),
  });
  return new ProviderOutcomeError(
    outcome,
    message ?? providerOutcomeMessage(outcome.code, operationSubject(operationRow)),
    observation?.status,
  );
}

export async function executeBinding(
  input: ExecuteBindingInput,
): Promise<JsonRecord> {
  const { binding, operationRow, providerRow } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const { method, url, headers, body } = await composeBindingRequest(input);
  const isGraphql = providerRow.transport === "graphql";
  const egress = Array.isArray(providerRow.egressHosts)
    ? (providerRow.egressHosts as string[])
    : [];

  let response: Response;
  try {
    response = await fetchWithAllowedRedirects(
      url,
      {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      egress,
      fetchImpl,
    );
  } catch (error) {
    if (!(error instanceof HttpError) || error.code === "PROVIDER_ERROR") {
      throw providerFailure(operationRow);
    }
    throw error;
  }
  if (!response.ok) {
    throw providerFailure(operationRow, response);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw providerFailure(
      operationRow,
      undefined,
      `${operationSubject(operationRow)} returned an invalid response.`,
    );
  }

  if (isGraphql) {
    const errors = (parsed as JsonRecord | null)?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw providerFailure(
        operationRow,
        undefined,
        `${operationSubject(operationRow)} answered with GraphQL errors.`,
      );
    }
    parsed = (parsed as JsonRecord | null)?.data ?? null;
  }

  const responseMapping = (operationRow.responseMapping ?? {}) as JsonRecord;
  const extracted = extractPath(parsed, responseMapping.rootPath);
  const fieldPaths = Array.isArray(responseMapping.fieldPaths)
    ? (responseMapping.fieldPaths as { field?: unknown; path?: unknown }[])
    : [];
  let operationOutputs: JsonRecord;
  if (
    fieldPaths.length > 0 &&
    extracted !== null &&
    typeof extracted === "object"
  ) {
    operationOutputs = {};
    if (Array.isArray(extracted)) {
      for (const entry of fieldPaths) {
        if (typeof entry.field !== "string") continue;
        if (entry.path === "$") {
          operationOutputs[entry.field] = extracted;
          continue;
        }
        let anyResolved = false;
        const projected = extracted.map((item) => {
          const value = extractPath(item, entry.path);
          if (value !== undefined) anyResolved = true;
          return value === undefined ? null : value;
        });
        if (!anyResolved && extracted.length > 0) {
          throw new HttpError(
            502,
            "SERVICE_MISCONFIGURED",
            `The response mapping produced no outputs: field path ` +
              `(${String(entry.path)}) does not exist in the provider response, ` +
              `which holds a collection of ${extracted.length} items — use path "$" ` +
              "to pass it through.",
          );
        }
        operationOutputs[entry.field] = projected;
      }
    } else {
      for (const entry of fieldPaths) {
        if (typeof entry.field !== "string") continue;
        operationOutputs[entry.field] = extractPath(extracted, entry.path);
      }
      // A mapping that matches NOTHING while the provider answered with data
      // is a definition mistake, not an empty result — an empty success here
      // silently loses the whole response (seen live: a calendar's events
      // vanished into {}). Name what was looked for and what was there.
      const anyResolved = Object.values(operationOutputs).some(
        (value) => value !== undefined,
      );
      const sourceKeys = Object.keys(extracted);
      if (!anyResolved && sourceKeys.length > 0) {
        throw new HttpError(
          502,
          "SERVICE_MISCONFIGURED",
          `The response mapping produced no outputs: none of its field paths ` +
            `(${fieldPaths.map((entry) => String(entry.path)).join(", ")}) exist in the ` +
            `provider response, which holds ${sourceKeys.join(", ")}.`,
        );
      }
    }
  } else {
    operationOutputs =
      extracted !== null &&
      typeof extracted === "object" &&
      !Array.isArray(extracted)
        ? (extracted as JsonRecord)
        : { result: extracted };
  }

  const mapped = applyMapping(operationOutputs, binding.outputMapping);
  if (
    Array.isArray(binding.outputMapping) &&
    (binding.outputMapping as unknown[]).length > 0 &&
    Object.keys(mapped).length === 0 &&
    Object.keys(operationOutputs).some(
      (key) => operationOutputs[key] !== undefined,
    )
  ) {
    throw new HttpError(
      502,
      "SERVICE_MISCONFIGURED",
      `The binding's output mapping matched nothing; the operation produced: ` +
        `${Object.keys(operationOutputs).join(", ")}.`,
    );
  }

  // Cursor pagination surfaces as data: the next-page cursor (when the
  // operation declares where it lives) rides along as `nextCursor`, and the
  // author feeds it back through a service input mapped onto the page
  // parameter. The engine stays single-request per call.
  const pagination = (operationRow.pagination ?? {}) as JsonRecord;
  if (
    pagination.style === "cursor" &&
    typeof pagination.cursorPath === "string"
  ) {
    const cursor = extractPath(parsed, pagination.cursorPath);
    if (cursor !== undefined && cursor !== null) mapped.nextCursor = cursor;
  }
  return mapped;
}

/**
 * Merge one binding's outputs into the accumulated result. Two ARRAYS under
 * the same key concatenate — that is what lets one canonical service (my
 * tasks, my mail) bind the same-shaped read from several providers and
 * answer with the union. Anything else overwrites, preserving read→act
 * chains where a later step deliberately replaces an earlier value.
 */
export function mergeOutputs(
  accumulated: JsonRecord,
  outputs: JsonRecord,
): void {
  for (const [key, value] of Object.entries(outputs)) {
    const existing = accumulated[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      accumulated[key] = [...existing, ...value];
    } else {
      accumulated[key] = value;
    }
  }
}

/** Bindings in authored order; a malformed entry fails closed by index. */
export function orderedBindings(
  row: JsonRecord,
  bindingsField: string,
): JsonRecord[] {
  const raw = row[bindingsField];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(
      400,
      "SERVICE_MISCONFIGURED",
      "The service defines no bindings.",
    );
  }
  return (raw as JsonRecord[])
    .map((binding, index) => {
      if (!binding || typeof binding !== "object") {
        throw new HttpError(
          400,
          "SERVICE_MISCONFIGURED",
          `Binding ${index + 1} is malformed.`,
        );
      }
      return binding;
    })
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
}
