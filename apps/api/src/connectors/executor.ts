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
import { randomUUID } from "node:crypto";
import { ConnectorContractBoundary, ConnectorBoundaryError } from "./contract-boundary.js";
import type { ConnectorContract, ConnectorOperationContract } from "./catalog.js";
import {
  ProviderObservations,
  classifyProviderOutcome,
  providerOutcomeMessage,
  type ConnectorProviderOutcome,
  type ConnectorProviderOutcomeCode,
  type ObservableResponse,
} from "./provider-outcome.js";
import { mayRetry } from "./reliability.js";
import {
  fetchValidatedOutbound,
  hostAllowed,
  type ModuleEgressDispatch,
} from "../modules/egress.js";

export { hostAllowed } from "../modules/egress.js";

export type ConnectorExecutionErrorCode =
  | "CONNECTOR_PROVENANCE_REFUSED"
  | "CONNECTOR_EGRESS_DENIED"
  | "CONNECTOR_TIMEOUT"
  | "CONNECTOR_RATE_LIMITED"
  | "CONNECTOR_CIRCUIT_OPEN"
  | "CONNECTOR_OAUTH_FAILED"
  // Distinct from every other failure because it is the only one a retry can
  // never fix and a person can always fix: the refresh token is spent or
  // revoked, and somebody has to authorize the installation again.
  | "CONNECTOR_REAUTHORIZATION_REQUIRED"
  // What the provider answered, classified from the status the bound fetch
  // observed — including the CONNECTOR_UPSTREAM_ERROR fallback.
  | ConnectorProviderOutcomeCode;

export type ConnectorExecutionErrorDetails = {
  outcome?: ConnectorProviderOutcome;
  /** The observed provider status, for the audit trail. Never on the wire. */
  providerStatus?: number;
};

export class ConnectorExecutionError extends Error {
  readonly code: ConnectorExecutionErrorCode;
  readonly connector: string;
  readonly operation: string | undefined;
  readonly outcome: ConnectorProviderOutcome | undefined;
  readonly providerStatus: number | undefined;

  constructor(
    code: ConnectorExecutionErrorCode,
    connector: string,
    message: string,
    operation?: string,
    details: ConnectorExecutionErrorDetails = {},
  ) {
    super(message);
    this.name = "ConnectorExecutionError";
    this.code = code;
    this.connector = connector;
    this.operation = operation;
    this.outcome = details.outcome;
    this.providerStatus = details.providerStatus;
  }
}

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
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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

/**
 * Host matching for `network.egress`. Three forms, narrowest first:
 *
 * | Pattern | Matches |
 * | --- | --- |
 * | `example.com` | that host, exactly |
 * | `*.example.com` | exactly one extra label — `api.example.com`, not `a.b.example.com` |
 * | `**.example.com` | any depth — `api.example.com` AND `api.eu.example.com` |
 *
 * `**.` exists because some vendors do not put their API on a fixed host.
 * Twinfield reports a per-organisation cluster as `api.<cluster>.twinfield.com`,
 * and Dynamics sandboxes sit at `<env>.sandbox.operations.dynamics.com` — two
 * labels deep, where `*.` covers one. Without it a contract has to enumerate
 * every cluster a customer might land on, and an unlisted one presents as an
 * outage.
 *
 * It is a SEPARATE form rather than a widening of `*.`, deliberately. Changing
 * what `*.` means would silently broaden the egress of every contract already
 * written, which is the kind of security regression nobody reviews because no
 * diff shows it.
 *
 * Neither wildcard matches the bare apex, and neither matches a lookalike:
 * `**.example.com` is not `example.com` and not `evil-example.com`. Both
 * properties come from requiring the dot to be part of the suffix.
 */
/**
 * A `fetch` bound to the contract's egress allowlist.
 *
 * An empty allowlist means no outbound HTTP at all: the allowlist is the grant,
 * not a filter over an open door. Non-HTTP schemes are refused outright — a
 * `file:` URL is not egress, it is a filesystem read wearing a URL.
 *
 * `observe` sees every response the package receives, and is what the
 * executor classifies a failure from. It changes nothing about the response:
 * a package that absorbs a non-success probe and returns a result has
 * succeeded, and the observation is simply never read.
 */
export function createBoundFetch(
  contract: ConnectorContract,
  signal: AbortSignal,
  underlying: FetchLike = fetch,
  observe?: (response: ObservableResponse) => void,
  egress?: ModuleEgressDispatch,
): FetchLike {
  const allowlist = contract.network.egress;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    // The caller's own signal is replaced, not merged: a package must not be
    // able to opt out of the operation's budget by passing its own.
    let target: string | URL | Request =
      input instanceof Request
        ? new Request(input, { ...init, signal })
        : input;
    let requestInit: RequestInit & { duplex?: "half" } = {
      ...init,
      signal,
      redirect: "manual",
    };
    if (target instanceof Request) {
      requestInit = {
        method: target.method,
        headers: target.headers,
        ...(target.body ? { body: target.body, duplex: "half" } : {}),
        signal,
        redirect: "manual",
      };
    }

    for (let hop = 0; hop <= 5; hop += 1) {
      const response = await fetchValidatedOutbound({
        target,
        init: requestInit,
        allowlist,
        fallback: underlying,
        ...(egress ? { dispatch: egress } : {}),
        denied: (deniedUrl, reason) =>
          new ConnectorExecutionError(
            "CONNECTOR_EGRESS_DENIED",
            contract.slug,
            reason === "protocol"
              ? `Connector "${contract.slug}" attempted a ${deniedUrl.protocol} request; only http(s) is permitted.`
              : `Connector "${contract.slug}" attempted to reach ${deniedUrl.hostname}, which its contract does not declare in network.egress.`,
          ),
      });
      observe?.(response);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (hop === 5) {
        throw new ConnectorExecutionError(
          "CONNECTOR_EGRESS_DENIED",
          contract.slug,
          `Connector "${contract.slug}" exceeded the outbound redirect limit.`,
        );
      }
      const currentUrl =
        target instanceof Request
          ? new URL(target.url)
          : new URL(target instanceof URL ? target.href : target);
      const nextUrl = new URL(location, currentUrl);
      const becomesGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          requestInit.method?.toUpperCase() === "POST");
      if (becomesGet) {
        const headers = new Headers(requestInit.headers);
        headers.delete("content-type");
        headers.delete("content-length");
        requestInit = { method: "GET", headers, signal, redirect: "manual" };
      }
      if (nextUrl.origin !== currentUrl.origin) {
        const method = requestInit.method?.toUpperCase() ?? "GET";
        if (
          requestInit.body !== undefined ||
          (method !== "GET" && method !== "HEAD")
        ) {
          throw new ConnectorExecutionError(
            "CONNECTOR_EGRESS_DENIED",
            contract.slug,
            `Connector "${contract.slug}" cannot forward a request body or non-read method across origins.`,
          );
        }
        const headers = new Headers(requestInit.headers);
        for (const name of [...headers.keys()]) {
          headers.delete(name);
        }
        requestInit = { ...requestInit, headers };
      }
      target = nextUrl;
    }
    throw new ConnectorExecutionError(
      "CONNECTOR_EGRESS_DENIED",
      contract.slug,
      `Connector "${contract.slug}" exceeded the outbound redirect limit.`,
    );
  }) as FetchLike;
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
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  /**
   * Wraps the egress-bound fetch before the package receives it.
   *
   * The seam OAuth uses to attach an access token the package never sees.
   * Applied OUTSIDE the egress binding rather than inside, so a wrapper cannot
   * widen where a connector may reach — it decorates a fetch that is already
   * refusing every host the contract does not declare.
   */
  wrapFetch?: (bound: FetchLike) => FetchLike;
  /**
   * Platform-minted id that ties a failure's outcome, its audit record and the
   * caller's answer together. Minted here when the caller has none.
   */
  correlationId?: string;
  egress?: ModuleEgressDispatch;
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

  const correlationId = input.correlationId ?? randomUUID();
  const observations = new ProviderObservations(correlationId);
  const boundFetch = createBoundFetch(
    contract,
    controller.signal,
    input.fetchImpl,
    (response) => observations.observe(response),
    input.egress,
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
    // The classification rests on what the platform saw for itself — the
    // status of the last non-success response and a Retry-After it could
    // parse. A validated package hint may narrow that; nothing in the thrown
    // error itself is trusted.
    const observation = observations.last();
    const outcome = classifyProviderOutcome({
      correlationId,
      observation,
      hint: boundary.providerFailureHint(error),
      retryAllowed: mayRetry(operation.kind, operation.reliability),
      now: Date.now(),
    });
    throw new ConnectorExecutionError(
      outcome.code,
      contract.slug,
      providerOutcomeMessage(
        outcome.code,
        `Connector "${contract.slug}" operation "${operation.key}"`,
      ),
      operation.key,
      { outcome, ...(observation ? { providerStatus: observation.status } : {}) },
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
