// SPDX-License-Identifier: BUSL-1.1
/**
 * The one path from a surface into a connector package.
 *
 * GraphQL, REST and MCP all call `invokeConnectorOperation`, the same discipline
 * that has the entity surfaces delegating to `generated-crud.ts`: three
 * protocols must not be able to disagree about who may invoke what, under which
 * policy, with which credentials.
 *
 * The order below is the whole security argument, and it is deliberate:
 *
 *   1. authorize          — before anything else, so an unauthorized caller
 *                           executes no package code and touches no secret
 *   2. resolve package    — refused provenance and failed handshakes never load
 *   3. resolve installation — tenant-scoped, must be enabled and not in repair
 *   4. decrypt secrets    — only now, only this connector's, only this tenant's
 *   5. governor           — rate limit, breaker, concurrency, retries
 *   6. execute            — input validated, output validated, errors redacted
 */
import { randomUUID } from "node:crypto";
import { Counter, getProcessPrometheusRegistry } from "@openshapeforge/observability";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { recordConnectorAudit } from "./audit.js";
import type { ConnectorContract, ConnectorOperationContract } from "./catalog.js";
import {
  ConnectorExecutionError,
  createBoundFetch,
  invokeOperation,
  type FetchLike,
} from "./executor.js";
import {
  PROVIDER_FAILURE_METRIC_LABELS,
  providerFailureAuditFields,
  providerFailureMetricLabels,
  type ConnectorProviderOutcome,
} from "./provider-outcome.js";
import {
  ensureAccessToken,
  toExecutionError,
  withOAuthAuthorization,
} from "./oauth.js";
import type { ConnectorRegistry } from "./loader.js";
import { ConnectorGovernor } from "./reliability.js";
import { describeContractDrift, isUsable } from "./status.js";
import { contractSecrets, type SecretKeyring } from "./secrets.js";
import { listInstallations, readSecrets } from "./store.js";

export class ConnectorInvocationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectorInvocationError";
    this.code = code;
  }
}

export type InvocationContext = {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  registry: ConnectorRegistry;
  governor: ConnectorGovernor;
  keyring?: SecretKeyring | undefined;
  /** Roles the caller holds; the same list every surface passes. */
  roles: readonly string[];
  instanceKey?: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * Fail closed, and fail first. An operation with no declared roles is invocable
 * by nobody; a caller without one of them never reaches a package, a secret, or
 * an upstream.
 */
export function assertMayInvoke(
  operation: ConnectorOperationContract,
  roles: readonly string[],
): void {
  const required = operation.roles.invoke;
  const granted = new Set(roles);
  if (required.length === 0 || !required.some((role) => granted.has(role))) {
    throw new ConnectorInvocationError(
      "FORBIDDEN",
      `Not authorized to invoke "${operation.key}".`,
    );
  }
}

export async function invokeConnectorOperation(
  context: InvocationContext,
  contract: ConnectorContract,
  operation: ConnectorOperationContract,
  input: unknown,
): Promise<unknown> {
  // 1. Authorization, before any state is touched.
  assertMayInvoke(operation, context.roles);

  // 2. The package, if this deployment may and can run it.
  const loaded = context.registry.loaded.get(contract.slug);
  if (!loaded) {
    const failure = context.registry.failures.find((entry) => entry.slug === contract.slug);
    throw new ConnectorInvocationError(
      "CONNECTOR_NOT_EXECUTABLE",
      failure?.message ??
        `Connector "${contract.slug}" has no loaded implementation package.`,
    );
  }

  // 3. This tenant's installation.
  const instanceKey = context.instanceKey ?? "default";
  const installations = await listInstallations(context.db, context.session);
  const installation = installations.find(
    (candidate) =>
      candidate.connectorSlug === contract.slug && candidate.instanceKey === instanceKey,
  );
  if (!installation) {
    throw new ConnectorInvocationError(
      "CONNECTOR_NOT_CONFIGURED",
      `Connector "${contract.slug}" has no installation "${instanceKey}" for this tenant.`,
    );
  }
  if (!installation.enabled) {
    throw new ConnectorInvocationError(
      "CONNECTOR_DISABLED",
      `Connector "${contract.slug}" is disabled for this tenant.`,
    );
  }
  const drift = describeContractDrift(
    contract,
    installation,
    installation.storedSecretFields,
  );
  if (!isUsable(drift.state)) {
    // Configuration that no longer satisfies the contract must not reach a
    // package: it would fail upstream in a way nobody can attribute.
    throw new ConnectorInvocationError(
      "CONNECTOR_NEEDS_REPAIR",
      `Connector "${contract.slug}" needs repair: ${drift.reason ?? "its contract changed."}`,
    );
  }

  // 4. Secrets, last and narrowest: only now, only this installation's, and
  // only the fields THIS contract declares. The store answers with every row —
  // which is what rotation needs — so the narrowing is applied here, on the one
  // path that hands values to package code.
  if (!context.keyring) {
    throw new ConnectorInvocationError(
      "CONNECTOR_SECRETS_NOT_CONFIGURED",
      "Connector secret encryption is not configured on this deployment.",
    );
  }
  const secrets = contractSecrets(
    await readSecrets(context.db, context.session, context.keyring, installation.id),
    contract.configuration.secretFields,
  );

  // 4b. OAuth, when the contract declares it: the PLATFORM holds the tokens,
  // refreshes them, and hands the package a fetch already carrying the access
  // token. The package is never given a refresh token, so it cannot fail to
  // persist a rotated one. Inside the governor, so a refresh storm against a
  // failing token endpoint is rate-limited and broken like any other call.
  // One correlation id spans token lifecycle, package execution and outcome.
  const correlationId = randomUUID();
  const wrapFetch = await oauthFetchWrapper({
    ...context,
    contract,
    installation,
    secrets,
    correlationId,
  });

  // 5 + 6. Policy around a validated, redacted execution. One correlation id
  // spans every attempt, so the answer, the audit record and the log line for
  // one call can be joined without any of them naming the tenant or the
  // installation.
  try {
    return await context.governor.run(
      {
        connector: contract.slug,
        operationKey: operation.key,
        kind: operation.kind,
        tenantId: String(context.session.tenantId),
        reliability: operation.reliability,
      },
      () =>
        invokeOperation({
          contract,
          operation,
          boundary: loaded.boundary,
          pkg: loaded.pkg,
          config: installation.config,
          secrets,
          input,
          correlationId,
          ...(wrapFetch ? { wrapFetch } : {}),
          ...(context.log ? { log: context.log } : {}),
        }),
    );
  } catch (error) {
    if (error instanceof ConnectorExecutionError && error.outcome) {
      await recordProviderFailure(
        context,
        contract,
        operation,
        instanceKey,
        error.outcome,
        error.providerStatus,
      );
    }
    throw error;
  }
}

const PROVIDER_FAILURE_METRIC = "openshapeforge_connector_provider_failures_total";

type ProviderFailureCounter = Counter<(typeof PROVIDER_FAILURE_METRIC_LABELS)[number]>;

/**
 * Registered on first use against the process registry, and found again
 * rather than re-registered on a module reload — prom-client refuses a second
 * metric under the same name.
 */
function providerFailureCounter(): ProviderFailureCounter {
  const registry = getProcessPrometheusRegistry();
  const existing = registry.getSingleMetric(PROVIDER_FAILURE_METRIC);
  if (existing) return existing as ProviderFailureCounter;
  return new Counter({
    name: PROVIDER_FAILURE_METRIC,
    help: "Connector invocations the provider answered with a failure, by normalized outcome.",
    labelNames: PROVIDER_FAILURE_METRIC_LABELS,
    registers: [registry],
  });
}

/**
 * What the platform keeps of a provider failure: a counter under bounded
 * labels, and a journal entry carrying the classification and the status the
 * bound fetch observed. Neither may replace the answer — a journal that
 * cannot be written is logged and the provider failure is still what the
 * caller hears.
 */
async function recordProviderFailure(
  context: InvocationContext,
  contract: ConnectorContract,
  operation: ConnectorOperationContract,
  instanceKey: string,
  outcome: ConnectorProviderOutcome,
  providerStatus: number | undefined,
): Promise<void> {
  providerFailureCounter().inc(
    providerFailureMetricLabels(contract.slug, operation.key, outcome),
  );
  try {
    await withDbSession(context.db, context.session, (trx) =>
      recordConnectorAudit(trx, {
        tenantId: String(context.session.tenantId),
        userId: context.session.userId ?? null,
        connectorSlug: contract.slug,
        instanceKey,
        event: "connector.provider_failed",
        providerFailure: providerFailureAuditFields(operation.key, outcome, providerStatus),
      }),
    );
  } catch {
    context.log?.("Connector provider failure could not be journalled.", {
      connector: contract.slug,
      operation: operation.key,
      correlationId: outcome.correlationId,
    });
  }
}

/**
 * Obtain an access token and return the wrapper that attaches it, or undefined
 * for a contract that does not use OAuth.
 *
 * The token is resolved BEFORE the package runs rather than lazily inside the
 * wrapper: a refresh needs its own transaction, and starting one underneath a
 * package's `fetch` would nest it inside whatever the caller already holds.
 */
async function oauthFetchWrapper(input: {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  keyring?: SecretKeyring | undefined;
  contract: ConnectorContract;
  installation: { id: string; instanceKey: string; config: Record<string, unknown> };
  secrets: Record<string, string>;
  correlationId: string;
  log?: ((message: string, fields?: Record<string, unknown>) => void) | undefined;
}): Promise<((bound: FetchLike) => FetchLike) | undefined> {
  if (!input.contract.auth) return undefined;
  if (!input.keyring) {
    throw new ConnectorInvocationError(
      "CONNECTOR_SECRETS_NOT_CONFIGURED",
      "Connector secret encryption is not configured on this deployment.",
    );
  }

  // The refresh reaches the provider's token endpoint through the connector's
  // OWN egress allowlist. The compiler already refused a contract whose token
  // URL has no egress to reach it, so a denial here is a misconfigured
  // installation rather than an unreachable design.
  const controller = new AbortController();
  const refreshFetch = createBoundFetch(input.contract, controller.signal);

  try {
    const accessToken = await ensureAccessToken({
      db: input.db,
      session: input.session,
      keyring: input.keyring,
      contract: input.contract,
      installationId: input.installation.id,
      instanceKey: input.installation.instanceKey,
      config: input.installation.config,
      secrets: input.secrets,
      boundFetch: refreshFetch,
      correlationId: input.correlationId,
    });
    return (bound) => withOAuthAuthorization(bound, accessToken);
  } catch (error) {
    const mapped = toExecutionError(input.contract, error);
    if (mapped) throw mapped;
    throw error;
  }
}

/**
 * Run a connector's own connectivity check.
 *
 * Separate from invoking an operation because it answers a different question —
 * "is this configuration usable?" — and because a package may implement it
 * without exposing it as an operation anybody can call.
 */
export async function verifyConnectorInstallation(
  context: InvocationContext,
  contract: ConnectorContract,
): Promise<{ ok: boolean; message?: string }> {
  const loaded = context.registry.loaded.get(contract.slug);
  if (!loaded) {
    throw new ConnectorInvocationError(
      "CONNECTOR_NOT_EXECUTABLE",
      `Connector "${contract.slug}" has no loaded implementation package.`,
    );
  }
  const verify = (loaded.pkg as { verify?: unknown }).verify;
  if (typeof verify !== "function") {
    throw new ConnectorInvocationError(
      "CONNECTOR_VERIFY_UNSUPPORTED",
      `Connector "${contract.slug}" does not implement a connectivity check.`,
    );
  }

  const instanceKey = context.instanceKey ?? "default";
  const installations = await listInstallations(context.db, context.session);
  const installation = installations.find(
    (candidate) =>
      candidate.connectorSlug === contract.slug && candidate.instanceKey === instanceKey,
  );
  if (!installation) {
    throw new ConnectorInvocationError(
      "CONNECTOR_NOT_CONFIGURED",
      `Connector "${contract.slug}" has no installation "${instanceKey}" for this tenant.`,
    );
  }
  if (!context.keyring) {
    throw new ConnectorInvocationError(
      "CONNECTOR_SECRETS_NOT_CONFIGURED",
      "Connector secret encryption is not configured on this deployment.",
    );
  }

  // Narrowed exactly as the invocation path narrows it: verify runs the same
  // package code with the same context, so it must not be the looser door.
  const secrets = contractSecrets(
    await readSecrets(context.db, context.session, context.keyring, installation.id),
    contract.configuration.secretFields,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const result = await (
      verify as (ctx: unknown) => Promise<{ ok: boolean; message?: string }>
    )({
      config: Object.freeze({ ...installation.config }),
      secrets: Object.freeze({ ...secrets }),
      fetch: (await import("./executor.js")).createBoundFetch(contract, controller.signal),
      signal: controller.signal,
      log: context.log ?? (() => {}),
    });
    return { ok: result?.ok === true, ...(result?.message ? { message: result.message } : {}) };
  } catch (error) {
    if (error instanceof ConnectorExecutionError) throw error;
    // A verify failure is an answer, not an exception: the operator asked
    // whether it works, and "no" is a valid reply. The reason is redacted.
    return { ok: false, message: "Connectivity check failed." };
  } finally {
    clearTimeout(timer);
  }
}
