// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector execution.
 *
 * THE TRUST SCOPE THIS DEPLOYMENT RUNS UNDER: reviewed packages only, executed
 * in-process, as an explicit accepted risk. `thirdParty` provenance is refused
 * at load time — see `assertExecutable`.
 *
 * That choice is not a formality. A module loaded into this process runs with
 * the API's privileges: it can read `process.env`, open files, and reach the
 * network regardless of what this file hands it. The capability-shaped context
 * below is good API design and a real guardrail against MISTAKES; it is not a
 * security boundary against hostile code, and calling it one would be worse
 * than having none, because it would invite loading packages nobody reviewed.
 *
 * The failure mode is not hypothetical. n8n's community nodes run with the same
 * access as n8n itself — env, filesystem, network, decrypted credentials — and
 * in January 2026 a malicious npm package used exactly that to exfiltrate OAuth
 * tokens. Their own guidance is to prefer official integrations and disable
 * community packages. Refusing `thirdParty` here is that guidance, enforced in
 * code rather than written in a doc.
 *
 * WHAT IN-PROCESS CANNOT DO: enforce a timeout. Cancellation here is
 * COOPERATIVE — the abort signal is honoured by a well-behaved package and by
 * `fetch`, and ignored entirely by `while (true) {}` or a pathological regex,
 * because JavaScript is single-threaded and nothing can preempt it. Naming this
 * `timeout` without qualification would be a lie the tests could not catch.
 * Enforceable termination needs an out-of-process (or worker-thread) executor,
 * where the host can terminate the isolate — the second executor behind this
 * same interface, for when third-party packages are on the table.
 */
import { ConnectorContractBoundary, ConnectorBoundaryError } from "./contract-boundary.js";
import { ConnectorExecutionError } from "./errors.js";
import {
  createBoundFetch,
  type FetchLike,
  type HostResolver,
  type ResolvedFetchLike,
} from "./egress.js";
import type { ConnectorContract, ConnectorOperationContract } from "./catalog.js";

export { ConnectorExecutionError } from "./errors.js";
export type { ConnectorExecutionErrorCode } from "./errors.js";
export { createBoundFetch, hostAllowed } from "./egress.js";
export type { FetchLike, HostResolver, ResolvedAddress, ResolvedFetchLike } from "./egress.js";

/**
 * What a connector package receives. Deliberately small: resolved
 * configuration, a bound fetch, a redacting logger, an abort signal. No
 * database handle, no session, no filesystem helper, no `process`.
 *
 * Only the secrets this connector's own contract declares are present — the
 * platform never hands over a bag of every credential it holds.
 */
/**
 * The subset of `fetch` a connector gets. Deliberately not `typeof fetch`: the
 * bound version carries no `preconnect` and no other host affordances, and
 * saying so in the type keeps a package from reaching for them.
 *
 * Spelled `string | URL | Request` rather than `RequestInfo`, for the reason
 * the example package already states about its own structural copy:
 * `RequestInfo` is an ambient global that exists only once a DOM or host lib is
 * loaded. Naming it here made this module unimportable from any program without
 * one — which the examples project is, so a connector test could not reach the
 * executor it is testing.
 */
export type ConnectorContext = {
  config: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
  fetch: FetchLike;
  signal: AbortSignal;
  log: (message: string, fields?: Record<string, unknown>) => void;
};

export type ConnectorPackage = {
  slug: string;
  contractVersion: number;
  contractChecksum?: string;
  operations: string[];
  invoke(
    operationKey: string,
    context: ConnectorContext,
    input: unknown,
  ): Promise<unknown>;
};

/**
 * The trust gate. Called before a package is loaded, not after.
 *
 * `thirdParty` is refused because this executor cannot contain it. When the
 * isolated executor exists, it lifts this refusal for itself rather than
 * loosening it here — so the scope a deployment runs under stays a property of
 * WHICH executor is installed, and cannot drift.
 */
export function assertExecutable(contract: ConnectorContract): void {
  if (contract.implementation.provenance === "thirdParty") {
    throw new ConnectorExecutionError(
      "CONNECTOR_PROVENANCE_REFUSED",
      contract.slug,
      `Connector "${contract.slug}" declares thirdParty provenance. This deployment executes ` +
        "connectors in-process, which cannot contain unreviewed code; it runs reviewed " +
        "packages only. Running third-party connectors requires the isolated executor.",
    );
  }
}

export type InvokeInput = {
  contract: ConnectorContract;
  operation: ConnectorOperationContract;
  boundary: ConnectorContractBoundary;
  pkg: ConnectorPackage;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  input: unknown;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Injectable transport and resolver seams for hermetic egress tests. */
  fetchImpl?: ResolvedFetchLike;
  resolveHost?: HostResolver;
  /**
   * Wraps the egress-bound fetch before the package receives it.
   *
   * The seam OAuth uses to attach an access token the package never sees.
   * Applied OUTSIDE the egress binding rather than inside, so a wrapper cannot
   * widen where a connector may reach — it decorates a fetch that is already
   * refusing every host the contract does not declare.
   */
  wrapFetch?: (bound: FetchLike) => FetchLike;
};

/**
 * Invoke one operation: validate in, call, validate out, redact on failure.
 *
 * Authorization is NOT checked here — it is checked by the caller before this
 * function is reached, so that an unauthorized request executes no package code
 * at all rather than being stopped after the fact.
 */
export async function invokeOperation(input: InvokeInput): Promise<unknown> {
  const { contract, operation, boundary, pkg } = input;

  assertExecutable(contract);
  boundary.assertValidInput(operation.key, input.input);

  const attemptMs = operation.reliability.timeouts.attemptMs;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), attemptMs);

  /**
   * Lateness is measured on the clock, NOT on the abort signal.
   *
   * A package that blocks the event loop prevents the abort timer from ever
   * running: timers are macrotasks, and the continuation after `await` is a
   * microtask, so the signal is still unaborted when the blocking call returns.
   * Trusting `signal.aborted` alone let a package overrun its budget by any
   * margin and be reported as a clean success.
   */
  const overran = () => Date.now() - startedAt > attemptMs;

  const boundFetch = createBoundFetch(
    contract,
    controller.signal,
    input.fetchImpl,
    input.resolveHost,
  );
  const context: ConnectorContext = {
    config: Object.freeze({ ...input.config }),
    secrets: Object.freeze({ ...input.secrets }),
    fetch: input.wrapFetch ? input.wrapFetch(boundFetch) : boundFetch,
    signal: controller.signal,
    log: input.log ?? (() => {}),
  };

  let result: unknown;
  try {
    result = await pkg.invoke(operation.key, context, input.input ?? {});
  } catch (error) {
    if (controller.signal.aborted || overran()) {
      throw new ConnectorExecutionError(
        "CONNECTOR_TIMEOUT",
        contract.slug,
        `Connector "${contract.slug}" operation "${operation.key}" exceeded its ` +
          `${attemptMs}ms attempt budget.`,
        operation.key,
      );
    }
    // Boundary and egress errors are ours and already safe to surface; anything
    // else came from the package or its upstream and is redacted, because it
    // can carry response bodies, credentials echoed back, and stack traces.
    if (error instanceof ConnectorExecutionError || error instanceof ConnectorBoundaryError) {
      throw error;
    }
    throw new ConnectorExecutionError(
      "CONNECTOR_UPSTREAM_ERROR",
      contract.slug,
      `Connector "${contract.slug}" operation "${operation.key}" failed.`,
      operation.key,
    );
  } finally {
    clearTimeout(timer);
  }

  // A package that resolves AFTER its budget expired still misses the budget:
  // the caller has already been told how long it may wait. Checked on the clock
  // so a package that blocked the event loop cannot slip through.
  if (controller.signal.aborted || overran()) {
    throw new ConnectorExecutionError(
      "CONNECTOR_TIMEOUT",
      contract.slug,
      `Connector "${contract.slug}" operation "${operation.key}" exceeded its ` +
        `${attemptMs}ms attempt budget.`,
      operation.key,
    );
  }

  boundary.assertValidOutput(operation.key, result);
  return result;
}
