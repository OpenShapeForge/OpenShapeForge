// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector compiler — normalizes a parsed connector contract into a
 * CompiledConnectorContract.
 *
 * Pipeline position: connectors compile independently of entities (they own no
 * storage), so this runs from the active compile alongside entity promotion
 * rather than inside the per-entity `compile()` orchestrator.
 *
 * What it decides: capability admission, surface projection (GraphQL namespace,
 * REST method/path, MCP tool names), reliability defaults, and the checksum an
 * installation pins itself to. What it deliberately does NOT do: resolve the
 * implementation package. Output must not depend on node_modules.
 *
 * Input:  ConnectorDefinition (parsed + identifier-validated by the loader)
 * Output: CompiledConnectorContract
 */
import { createHash } from "node:crypto";
import type {
  CompiledConnectorContract,
  CompiledConnectorExposure,
  CompiledConnectorOperation,
  CompiledConnectorReliability,
  ConnectorCapabilityKey,
  ConnectorConfigField,
  ConnectorDefinition,
  ConnectorOperation,
} from "../types/connector.js";
import { CONNECTOR_EGRESS_PATTERN } from "../connector-loader.js";
import { buildOperationSchemas, connectorObjectSchema } from "./connector-schemas.js";
import { deriveToolPrefix } from "./mcp.js";

/**
 * Capabilities the platform can actually honour today. `eventSource` and
 * `eventSink` are reserved vocabulary: the canonical event envelope, outbox
 * boundary, retry scheduling, dead-letter and replay are platform-owned and
 * designed separately. Accepting them here would let a contract advertise
 * delivery guarantees nothing enforces.
 */
const IMPLEMENTED_CAPABILITIES = new Set<ConnectorCapabilityKey>(["operations"]);
const RESERVED_CAPABILITIES = new Set<ConnectorCapabilityKey>([
  "eventSource",
  "eventSink",
]);

const ENTITLEMENT_PATTERN = /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/;

/**
 * Configuration field keys the PLATFORM owns.
 *
 * Secrets are stored one row per (installation, field key), and the platform
 * keeps rows of its own there — OAuth tokens it refreshes and rotates on a
 * connector's behalf, which package code must never receive. Nothing in the
 * field vocabulary constrains a key, so without this a contract could declare
 * `platform.oauth` and collide with one, either shadowing a token the runtime
 * needs or naming its way into reading one.
 *
 * Refused at compile time rather than resolved at write time, for the same
 * reason the reserved capabilities are: a contract must not be able to describe
 * something the platform will then have to disambiguate at runtime.
 */
const RESERVED_CONFIG_KEY_PREFIX = "platform.";

/** Platform defaults for reaching a remote system. Authoring only overrides. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPT_TIMEOUT_MS = 120_000;
/** Ceiling for the whole operation including retries (schedule-to-close). */
const MAX_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CONCURRENCY_PER_TENANT = 4;
const DEFAULT_REQUEST_BYTES = 1_048_576;
const DEFAULT_RESPONSE_BYTES = 8_388_608;

/** `listObjects` → `list-objects` (REST path segment). */
function toKebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** `listObjects` → `list_objects` (MCP tool-name suffix). */
function toSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** `ObjectStore` → `objectStore` (GraphQL namespace field). */
function toCamel(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** `listObjects` → `ListObjects` (GraphQL type-name segment). */
function toPascal(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Structural guards for the shapes this compiler dereferences.
 *
 * These are not a substitute for schema validation (#182) — they cover exactly
 * the assumptions the code below would otherwise make silently. Without them a
 * scalar where a list belongs is spread character by character: an authored
 * `invoke: "AdminRole"` compiled to `["A","R","d","e",…]`, a corrupted allow-list
 * that no error ever mentioned.
 */
function expectArray(value: unknown, what: string, origin: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Connector ${origin}: ${what} must be a list, got ${typeof value} ` +
        `(${JSON.stringify(value)}).`,
    );
  }
  return value;
}

function expectNonEmptyString(value: unknown, what: string, origin: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Connector ${origin}: ${what} must be a non-empty string, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function expectOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
  origin: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `Connector ${origin}: ${what} must be one of ${allowed.join(" | ")}, got ` +
        `${JSON.stringify(value)}.`,
    );
  }
  return value as T;
}

function assertUnique(values: string[], what: string, origin: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${what} "${value}" in connector ${origin}.`);
    }
    seen.add(value);
  }
}

/**
 * Reliability defaults, plus the one rule that cannot be a default: a mutation
 * may not be retry-eligible without a declared idempotency strategy. An
 * automatic retry of a non-idempotent remote mutation duplicates real-world
 * side effects — a second payment, a second message — and no amount of runtime
 * care recovers from it. Failing the build is the only safe answer.
 */
function buildReliability(
  operation: ConnectorOperation,
  origin: string,
): CompiledConnectorReliability {
  const authored = operation.reliability ?? {};
  const retryEligible = authored.retry?.eligible === true;
  const idempotency = authored.idempotency;

  if (operation.kind === "mutation" && retryEligible && !idempotency) {
    throw new Error(
      `Operation "${operation.key}" in connector ${origin} is a retry-eligible mutation ` +
        "without an idempotency declaration. Declare reliability.idempotency " +
        "(strategy: natural | key) or set retry.eligible: false — a retried " +
        "non-idempotent mutation duplicates upstream side effects.",
    );
  }

  if (idempotency?.strategy === "key") {
    const keyInput = idempotency.keyInput;
    const inputKeys = (operation.input ?? []).map((field) => field.key);
    if (!keyInput || !inputKeys.includes(keyInput)) {
      throw new Error(
        `Operation "${operation.key}" in connector ${origin} declares idempotency ` +
          `strategy "key" but keyInput ${JSON.stringify(keyInput)} is not one of its ` +
          `input fields (${inputKeys.join(", ") || "none"}).`,
      );
    }
  }

  const attemptMs = authored.timeouts?.attemptMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  if (typeof attemptMs !== "number" || !Number.isFinite(attemptMs)) {
    throw new Error(
      `Operation "${operation.key}" in connector ${origin} declares a non-numeric ` +
        `timeouts.attemptMs (${JSON.stringify(attemptMs)}).`,
    );
  }
  if (attemptMs <= 0 || attemptMs > MAX_ATTEMPT_TIMEOUT_MS) {
    throw new Error(
      `Operation "${operation.key}" in connector ${origin} declares timeouts.attemptMs ` +
        `${attemptMs}; must be > 0 and <= ${MAX_ATTEMPT_TIMEOUT_MS}. A longer budget pins a ` +
        "worker on an unresponsive upstream.",
    );
  }

  const maxAttempts = authored.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // Default the overall budget to what the retries can actually consume, so an
  // author who sets neither still gets a bound rather than an open-ended one.
  const totalMs =
    authored.timeouts?.totalMs ?? attemptMs * (retryEligible ? maxAttempts : 1);
  if (typeof totalMs !== "number" || !Number.isFinite(totalMs)) {
    throw new Error(
      `Operation "${operation.key}" in connector ${origin} declares a non-numeric ` +
        `timeouts.totalMs (${JSON.stringify(totalMs)}).`,
    );
  }
  if (totalMs < attemptMs) {
    throw new Error(
      `Operation "${operation.key}" in connector ${origin} declares timeouts.totalMs ` +
        `${totalMs} below timeouts.attemptMs ${attemptMs}; the overall budget cannot be ` +
        "smaller than a single attempt.",
    );
  }
  if (totalMs > MAX_TOTAL_TIMEOUT_MS) {
    throw new Error(
      `Operation "${operation.key}" in connector ${origin} declares timeouts.totalMs ` +
        `${totalMs}; must be <= ${MAX_TOTAL_TIMEOUT_MS}.`,
    );
  }

  return {
    timeouts: { attemptMs, totalMs },
    retry: {
      eligible: retryEligible,
      maxAttempts,
      backoff: authored.retry?.backoff ?? "exponential",
    },
    ...(idempotency
      ? { idempotency: { ...idempotency, header: idempotency.header ?? "Idempotency-Key" } }
      : {}),
    concurrency: {
      perTenant: authored.concurrency?.perTenant ?? DEFAULT_CONCURRENCY_PER_TENANT,
    },
    ...(authored.rateLimit?.perTenantPerMinute !== undefined
      ? { rateLimit: { perTenantPerMinute: authored.rateLimit.perTenantPerMinute } }
      : {}),
    ...(authored.circuitBreaker
      ? {
          circuitBreaker: {
            failureThreshold: authored.circuitBreaker.failureThreshold ?? 5,
            resetAfterMs: authored.circuitBreaker.resetAfterMs ?? 30_000,
          },
        }
      : {}),
    limits: {
      requestBytes: authored.limits?.requestBytes ?? DEFAULT_REQUEST_BYTES,
      responseBytes: authored.limits?.responseBytes ?? DEFAULT_RESPONSE_BYTES,
    },
    pagination: { style: authored.pagination?.style ?? "none" },
  };
}

function buildExposure(
  definition: ConnectorDefinition,
  slug: string,
  origin: string,
): CompiledConnectorExposure {
  const exposure = definition.exposure ?? {};

  // GraphQL is the native surface, as it is for entities; REST and MCP are
  // opt-in, matching the per-entity `rest:` / `mcp:` blocks.
  const graphql = exposure.graphql !== false;

  const restAuthored = exposure.rest;
  const restEnabled =
    restAuthored === true ||
    (typeof restAuthored === "object" &&
      restAuthored !== null &&
      restAuthored.enabled !== false);
  const rest = restEnabled
    ? {
        basePath:
          (typeof restAuthored === "object" && restAuthored !== null
            ? restAuthored.basePath
            : undefined) ?? slug,
      }
    : undefined;

  const mcpAuthored = exposure.mcp;
  const mcpEnabled =
    mcpAuthored === true ||
    (typeof mcpAuthored === "object" &&
      mcpAuthored !== null &&
      mcpAuthored.enabled !== false);
  const mcp = mcpEnabled
    ? {
        toolPrefix:
          (typeof mcpAuthored === "object" && mcpAuthored !== null
            ? mcpAuthored.toolPrefix
            : undefined) ?? deriveToolPrefix(definition.connector),
      }
    : undefined;

  if (!graphql && !rest && !mcp) {
    throw new Error(
      `Connector ${origin} declares the "operations" capability but exposes no surface ` +
        "(graphql: false, no rest, no mcp). Operations nothing can invoke are dead weight.",
    );
  }

  return { graphql, ...(rest ? { rest } : {}), ...(mcp ? { mcp } : {}) };
}

/** `{fieldKey}` placeholders in an OAuth endpoint template. */
const URL_TEMPLATE_PLACEHOLDER = /\{([^}]*)\}/g;

/**
 * Refuse an egress entry that is not a bare hostname pattern.
 *
 * Shape is checked from the SAME constant the load-time path uses, so an
 * in-repo contract and one shipped by a package cannot be judged by two
 * different regexes. They had drifted: adding `**.` to one and forgetting the
 * other made a contract that compiled from a layer fail from a package, citing
 * a pattern nobody had edited.
 *
 * That pattern also carries the only depth floor there is — it requires at
 * least two labels, so `**.com` is refused as a matter of shape rather than by
 * a separate breadth rule. Worth being plain that this is NOT public-suffix
 * aware: `**.co.uk` satisfies it while granting as much as `**.com` would.
 * Closing that needs the public suffix list as a dependency.
 */
function assertEgressPattern(entry: string, origin: string): void {
  if (CONNECTOR_EGRESS_PATTERN.test(entry)) return;
  throw new Error(
    `Connector ${origin} declares egress ${JSON.stringify(entry)}, which is not a hostname ` +
      "optionally prefixed with `*.` (one label) or `**.` (any depth). Schemes, ports, paths, " +
      "CIDR and a bare suffix widen the grant against a resolved request host.",
  );
}

/**
 * Validate and normalize the OAuth block.
 *
 * Every check here exists because the alternative failure is invisible until a
 * token exchange fails in production, by which time the reason is an opaque
 * provider error rather than the contract mistake that caused it.
 */
function compileAuth(
  definition: ConnectorDefinition,
  configFields: ConnectorConfigField[],
  egress: string[],
  origin: string,
): CompiledConnectorContract["auth"] {
  const authored = definition.auth;
  if (!authored) return undefined;

  const byKey = new Map(configFields.map((field) => [field.key, field]));

  function requireConfigField(key: string, role: string, mustBeSecret: boolean) {
    const field = byKey.get(key);
    if (!field) {
      throw new Error(
        `Connector ${origin} names ${role} "${key}", which is not a declared configuration field.`,
      );
    }
    // A client secret in a non-secret field would be stored in the installation
    // row in plaintext and returned by every configuration read.
    if (mustBeSecret && field.secret !== true) {
      throw new Error(
        `Connector ${origin} names ${role} "${key}", which is not marked secret. A client ` +
          "secret stored outside encrypted storage is readable from every configuration read.",
      );
    }
    if (!mustBeSecret && field.secret === true) {
      throw new Error(
        `Connector ${origin} names ${role} "${key}", which is marked secret. It is ` +
          "interpolated into an endpoint URL, so it must not be a credential.",
      );
    }
    return field;
  }

  requireConfigField(authored.clientIdField, "auth.clientIdField", false);
  requireConfigField(authored.clientSecretField, "auth.clientSecretField", true);

  for (const [name, template] of [
    ["auth.authorizeUrl", authored.authorizeUrl],
    ["auth.tokenUrl", authored.tokenUrl],
  ] as const) {
    expectNonEmptyString(template, name, origin);
    for (const match of template.matchAll(URL_TEMPLATE_PLACEHOLDER)) {
      const key = match[1] ?? "";
      const field = byKey.get(key);
      if (!field) {
        throw new Error(
          `Connector ${origin} interpolates "{${key}}" into ${name}, which is not a declared ` +
            "configuration field.",
        );
      }
      // Interpolating a secret into a URL puts it in a request line, and from
      // there into every proxy log between here and the provider.
      if (field.secret === true) {
        throw new Error(
          `Connector ${origin} interpolates the secret field "{${key}}" into ${name}. A secret ` +
            "in a URL is written to every log that records the request line.",
        );
      }
    }
    // A template still has to be a URL once the placeholders are gone, and the
    // literal host has to be one the contract may reach: a token endpoint the
    // bound fetch refuses is a connector that can never authenticate.
    const probe = template.replace(URL_TEMPLATE_PLACEHOLDER, "x");
    let url: URL;
    try {
      url = new URL(probe);
    } catch {
      throw new Error(
        `Connector ${origin} declares ${name} ${JSON.stringify(template)}, which is not a URL ` +
          "once its placeholders are filled.",
      );
    }
    if (url.protocol !== "https:") {
      throw new Error(
        `Connector ${origin} declares ${name} over ${url.protocol.replace(":", "")}. OAuth ` +
          "credentials and tokens require https.",
      );
    }
    if (egress.length === 0) {
      throw new Error(
        `Connector ${origin} declares ${name} but no network.egress. The platform performs the ` +
          "token exchange through the same allowlist a connector's own calls use.",
      );
    }
  }

  return {
    type: authored.type,
    flow: authored.flow,
    authorizeUrl: authored.authorizeUrl,
    tokenUrl: authored.tokenUrl,
    scopes: [...(authored.scopes ?? [])],
    clientIdField: authored.clientIdField,
    clientSecretField: authored.clientSecretField,
    refreshLeewaySeconds: authored.refreshLeewaySeconds ?? 60,
  };
}

export function buildConnector(
  definition: ConnectorDefinition,
  slug: string,
  origin: string,
): CompiledConnectorContract {
  if (definition.schemaVersion !== 1) {
    throw new Error(
      `Connector ${origin} declares schemaVersion ${JSON.stringify(definition.schemaVersion)}; ` +
        "only version 1 is supported.",
    );
  }
  expectNonEmptyString(definition.title, "title", origin);

  const capabilities = expectArray(
    definition.capabilities ?? [],
    "capabilities",
    origin,
  ) as ConnectorCapabilityKey[];
  if (capabilities.length === 0) {
    throw new Error(
      `Connector ${origin} declares no capabilities. Declare at least "operations".`,
    );
  }
  for (const capability of capabilities) {
    if (RESERVED_CAPABILITIES.has(capability)) {
      throw new Error(
        `Connector ${origin} declares capability "${capability}", which is reserved but not ` +
          "implemented. Event delivery is a platform-owned pipeline (canonical envelope, " +
          "outbox boundary, retry scheduling, dead-letter, replay) designed separately; a " +
          "connector cannot claim delivery guarantees the platform does not yet enforce.",
      );
    }
    if (!IMPLEMENTED_CAPABILITIES.has(capability)) {
      throw new Error(
        `Connector ${origin} declares unknown capability "${capability}". ` +
          `Known capabilities: ${[...IMPLEMENTED_CAPABILITIES].join(", ")}.`,
      );
    }
  }

  if (definition.events !== undefined) {
    throw new Error(
      `Connector ${origin} declares events, which require the reserved eventSource / ` +
        "eventSink capabilities. Remove the block until the event pipeline ships.",
    );
  }

  const operations = expectArray(
    definition.operations ?? [],
    "operations",
    origin,
  ) as ConnectorOperation[];
  if (capabilities.includes("operations") && operations.length === 0) {
    throw new Error(
      `Connector ${origin} declares the "operations" capability but no operations.`,
    );
  }
  if (operations.length > 0 && !capabilities.includes("operations")) {
    throw new Error(
      `Connector ${origin} declares operations without the "operations" capability.`,
    );
  }

  assertUnique(operations.map((operation) => operation.key), "operation key", origin);

  const configFields = expectArray(
    definition.configuration?.fields ?? [],
    "configuration.fields",
    origin,
  ) as ConnectorConfigField[];
  assertUnique(configFields.map((field) => field.key), "configuration field key", origin);

  for (const field of configFields) {
    if (field.key.startsWith(RESERVED_CONFIG_KEY_PREFIX)) {
      throw new Error(
        `Connector ${origin} declares configuration field "${field.key}". The ` +
          `"${RESERVED_CONFIG_KEY_PREFIX}" prefix is reserved for fields the platform stores ` +
          "against an installation itself, such as OAuth tokens it refreshes on a connector's " +
          "behalf. Choose a key without it.",
      );
    }
  }

  const entitlement = definition.availability?.entitlement;
  if (entitlement !== undefined && !ENTITLEMENT_PATTERN.test(entitlement)) {
    throw new Error(
      `Connector ${origin} declares entitlement ${JSON.stringify(entitlement)} — must match ` +
        `${ENTITLEMENT_PATTERN}.`,
    );
  }

  if (!definition.implementation?.package) {
    throw new Error(`Connector ${origin} must declare implementation.package.`);
  }
  if (typeof definition.implementation.contractVersion !== "number") {
    throw new Error(
      `Connector ${origin} must declare a numeric implementation.contractVersion — the ` +
        "runtime refuses a package built against a different generation.",
    );
  }
  if (!definition.implementation.license?.spdx) {
    throw new Error(
      `Connector ${origin} must declare implementation.license.spdx. The connector's ` +
        "license is surfaced wherever it is offered.",
    );
  }

  const exposure = buildExposure(definition, slug, origin);

  const mcpAuthored = definition.exposure?.mcp;
  const mcpOperationFlags =
    typeof mcpAuthored === "object" && mcpAuthored !== null
      ? (mcpAuthored.operations ?? {})
      : {};
  const operationKeys = new Set(operations.map((operation) => operation.key));
  for (const key of Object.keys(mcpOperationFlags)) {
    if (!operationKeys.has(key)) {
      throw new Error(
        `Connector ${origin} sets an mcp operation flag for "${key}", which is not a ` +
          "declared operation.",
      );
    }
  }

  const compiledOperations: CompiledConnectorOperation[] = operations.map((operation) => {
    if (operation.kind !== "query" && operation.kind !== "mutation") {
      throw new Error(
        `Operation "${operation.key}" in connector ${origin} must declare kind: query | mutation.`,
      );
    }
    if (!operation.output || !Array.isArray(operation.output.fields)) {
      throw new Error(
        `Operation "${operation.key}" in connector ${origin} must declare an output shape. ` +
          "The output schema is validated at the runtime boundary, so it cannot be implicit.",
      );
    }
    expectOneOf(
      operation.output.cardinality,
      ["one", "many"] as const,
      `operation "${operation.key}" output.cardinality`,
      origin,
    );
    expectArray(operation.input ?? [], `operation "${operation.key}" input`, origin);

    const roles = expectArray(
      operation.authorization?.roles?.invoke ?? [],
      `operation "${operation.key}" authorization.roles.invoke`,
      origin,
    ) as string[];
    for (const role of roles) {
      expectNonEmptyString(role, `operation "${operation.key}" invoke role`, origin);
    }
    if (roles.length === 0) {
      throw new Error(
        `Operation "${operation.key}" in connector ${origin} declares no invoke roles. ` +
          "Authorization is fail-closed: an operation nobody is allowed to call is a " +
          "configuration error, not an open one.",
      );
    }

    const typeBase = `${definition.connector}${toPascal(operation.key)}`;
    return {
      key: operation.key,
      kind: operation.kind,
      ...(operation.label ? { label: operation.label } : {}),
      ...(operation.description ? { description: operation.description } : {}),
      graphql: {
        field: operation.key,
        inputType: `${typeBase}Input`,
        resultType: `${typeBase}Result`,
      },
      rest: {
        method:
          operation.rest?.method ?? (operation.kind === "query" ? "GET" : "POST"),
        path: operation.rest?.path ?? toKebab(operation.key),
      },
      ...(exposure.mcp && mcpOperationFlags[operation.key] !== false
        ? { mcp: { toolName: `${exposure.mcp.toolPrefix}_${toSnake(operation.key)}` } }
        : {}),
      roles: { invoke: [...new Set(roles)].sort() },
      input: operation.input ?? [],
      output: operation.output,
      schemas: buildOperationSchemas(operation.input ?? [], operation.output),
      reliability: buildReliability(operation, origin),
    };
  });

  assertUnique(
    compiledOperations.map((operation) => `${operation.rest.method} ${operation.rest.path}`),
    "rest method+path",
    origin,
  );

  const egressAllowlist = [...(definition.network?.egress ?? [])].sort();
  for (const entry of egressAllowlist) assertEgressPattern(entry, origin);

  const auth = compileAuth(definition, configFields, egressAllowlist, origin);

  const contract: Omit<CompiledConnectorContract, "checksum"> = {
    slug,
    connector: definition.connector,
    title: definition.title,
    ...(definition.labels ? { labels: definition.labels } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.category ? { category: definition.category } : {}),
    domains: [...(definition.domains ?? [])].sort(),
    capabilities: [...capabilities].sort(),
    implementation: definition.implementation,
    availability: entitlement === undefined ? {} : { entitlement },
    configuration: {
      instances: definition.configuration?.instances ?? "single",
      verify: definition.configuration?.verify === true,
      fields: configFields,
      secretFields: configFields
        .filter((field) => field.secret === true)
        .map((field) => field.key)
        .sort(),
      schema: connectorObjectSchema(configFields),
    },
    ...(auth ? { auth } : {}),
    network: { egress: egressAllowlist },
    operations: compiledOperations,
    events: [],
    exposure,
    namespace: toCamel(definition.connector),
  };

  // Stable because every array above is sorted and object keys are written in a
  // fixed order — the same JSON.stringify-over-a-built-object convention the
  // manifest checksum uses.
  const checksum = createHash("sha256").update(JSON.stringify(contract)).digest("hex");

  return { ...contract, checksum };
}
