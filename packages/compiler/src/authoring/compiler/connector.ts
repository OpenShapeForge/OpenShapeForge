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
    network: { egress: [...(definition.network?.egress ?? [])].sort() },
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
