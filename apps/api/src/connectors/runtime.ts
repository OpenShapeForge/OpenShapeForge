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
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import type { ConnectorContract, ConnectorOperationContract } from "./catalog.js";
import { ConnectorExecutionError, invokeOperation } from "./executor.js";
import type { ConnectorRegistry } from "./loader.js";
import { ConnectorGovernor } from "./reliability.js";
import { describeContractDrift, isUsable } from "./status.js";
import type { SecretKeyring } from "./secrets.js";
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

  // 4. Secrets, last and narrowest: only now, only this installation's.
  if (!context.keyring) {
    throw new ConnectorInvocationError(
      "CONNECTOR_SECRETS_NOT_CONFIGURED",
      "Connector secret encryption is not configured on this deployment.",
    );
  }
  const secrets = await readSecrets(
    context.db,
    context.session,
    context.keyring,
    installation.id,
  );

  // 5 + 6. Policy around a validated, redacted execution.
  return context.governor.run(
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
        ...(context.log ? { log: context.log } : {}),
      }),
  );
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

  const secrets = await readSecrets(
    context.db,
    context.session,
    context.keyring,
    installation.id,
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
