// SPDX-License-Identifier: BUSL-1.1
import { hostAllowed } from "@openshapeforge/plugin-runtime";
export { hostAllowed } from "@openshapeforge/plugin-runtime";
import { assertOutboundTls } from "./outbound-response.js";
import {
  OutboundAddressError,
  verifiedPublicAddresses,
  type AddressResolver,
} from "./outbound-addresses.js";
import { HttpError } from "../rest/http-error.js";
/** Canonical protocol/allowlist gate and optional runtime-module egress owner. */
import { withRuntimeSpan } from "@openshapeforge/observability";
import type {
  ModuleEgressFailureKind,
  ModuleEgressInvocationSource,
  RuntimeModule,
} from "./contract.js";

/** Startup diagnostic without blocking installations that intentionally make no outbound requests. */
export function missingEgressOwnerDiagnostic(environment: string | undefined, owner: unknown): { code: string; message: string } | undefined {
  if (owner) {
    return (owner as { pinsResolvedAddresses?: unknown }).pinsResolvedAddresses === true
      ? undefined
      : { code: "EGRESS_OWNER_REQUIRED", message: "The configured egress owner does not declare pinsResolvedAddresses. Outbound requests will be refused until it dials only the addresses core resolved." };
  }
  return environment === "production"
    ? { code: "EGRESS_OWNER_REQUIRED", message: "No outbound egress owner is configured. Production outbound requests will be refused until one is installed." }
    : undefined;
}

const trustedModuleEgressFailure = new WeakMap<
  TrustedModuleEgressError,
  { kind: ModuleEgressFailureKind; invocation: object }
>();
const moduleEgressInvocation = new WeakMap<ModuleEgressDispatch, object>();

class ModuleEgressError extends Error {
  readonly kind: ModuleEgressFailureKind;

  constructor(kind: ModuleEgressFailureKind) {
    super(
      kind === "policy_blocked"
        ? "Outbound policy blocked the request."
        : "Outbound request timed out.",
    );
    this.name = "ModuleEgressError";
    this.kind = kind;
    Object.freeze(this);
  }
}

const issuedModuleEgressFailures = new WeakSet<ModuleEgressError>();
const moduleEgressFailureIssuance = new WeakMap<
  ModuleEgressError,
  { kind: ModuleEgressFailureKind; invocation: object }
>();

/** Only this closure can issue a failure for the active invocation. */
function createModuleEgressFailureFactory(
  invocation: object | undefined,
): (kind: ModuleEgressFailureKind) => Error {
  const factory = (kind: ModuleEgressFailureKind): Error => {
    if (kind !== "policy_blocked" && kind !== "timeout") {
      throw new TypeError("Unsupported module egress failure kind.");
    }
    const error = new ModuleEgressError(kind);
    issuedModuleEgressFailures.add(error);
    if (invocation) {
      moduleEgressFailureIssuance.set(error, { kind, invocation });
    }
    return error;
  };
  return Object.freeze(factory);
}

class TrustedModuleEgressError extends Error {
  constructor() {
    super("Trusted module egress failed.");
    this.name = "TrustedModuleEgressError";
    Object.freeze(this);
  }
}

/** Only this closure can brand a failure as originating at the owner hook. */
function createTrustedModuleEgressError(
  kind: ModuleEgressFailureKind,
  invocation: object,
): TrustedModuleEgressError {
  const error = new TrustedModuleEgressError();
  trustedModuleEgressFailure.set(error, { kind, invocation });
  return error;
}

/** Preserve cancellation identity without letting it replay a trusted brand. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof TrustedModuleEgressError) {
    trustedModuleEgressFailure.delete(signal.reason);
  }
  signal.throwIfAborted();
}

class DeferredModuleEgressInputError extends Error {
  constructor() {
    super("Outbound request input failed.");
    this.name = "DeferredModuleEgressInputError";
    Object.freeze(this);
  }
}

/**
 * Keep package-controlled stream failures outside the trusted owner rejection
 * channel. One read per pull preserves backpressure; cancellation is forwarded
 * without forwarding an attacker-controlled reason.
 */
function sanitizeRequestBody(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = ReadableStream.prototype.getReader.call(body) as
    ReadableStreamDefaultReader<Uint8Array>;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          if (!(next.value instanceof Uint8Array)) {
            throw new DeferredModuleEgressInputError();
          }
          controller.enqueue(new Uint8Array(next.value));
        } catch {
          controller.error(new DeferredModuleEgressInputError());
        }
      },
      async cancel() {
        try {
          await reader.cancel();
        } catch {
          // The cancellation still reached the source. Its package-controlled
          // failure must not escape through the owner rejection channel.
        }
      },
    },
    { highWaterMark: 0 },
  );
}

/** Give the owner cancellation timing, never a package-controlled reason. */
function sanitizeAbortSignal(signal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    controller.abort(new DOMException("Outbound request cancelled.", "AbortError"));
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export type ModuleEgressDispatch = {
  owner?: RuntimeModule["egress"] | undefined;
  purpose: "provider" | "oauth" | "discovery" | "probe";
  scope: {
    tenantId: string | null;
    actorId: string | null;
    provider: string;
    operation: string;
    kind: "query" | "mutation";
  };
  source?: ModuleEgressInvocationSource | undefined;
};

/**
 * Bind one core-owned classification capability to one invocation. The bound
 * dispatch may span redirect hops, but neither it nor the private identity is
 * exposed to the package or registered owner.
 */
export function createModuleEgressInvocation(
  dispatch: ModuleEgressDispatch | undefined,
): Readonly<{
  dispatch: ModuleEgressDispatch | undefined;
  consumeFailure(error: unknown): ModuleEgressFailureKind | undefined;
}> {
  const identity = Object.freeze({});
  const boundDispatch = dispatch
    ? Object.freeze({ ...dispatch })
    : undefined;
  if (boundDispatch) moduleEgressInvocation.set(boundDispatch, identity);
  return Object.freeze({
    dispatch: boundDispatch,
    consumeFailure(error: unknown) {
      if (!(error instanceof TrustedModuleEgressError)) return undefined;
      const failure = trustedModuleEgressFailure.get(error);
      if (!failure) return undefined;
      // Every classification attempt consumes the brand. A mismatched
      // invocation therefore fails closed and cannot replay it later.
      trustedModuleEgressFailure.delete(error);
      return failure.invocation === identity ? failure.kind : undefined;
    },
  });
}

/** Derive lifecycle traffic without exposing or changing invocation identity. */
export function deriveModuleEgressDispatch(
  dispatch: ModuleEgressDispatch | undefined,
  purpose: ModuleEgressDispatch["purpose"],
): ModuleEgressDispatch | undefined {
  if (!dispatch) return undefined;
  const derived = Object.freeze({
    owner: dispatch.owner,
    purpose,
    scope: dispatch.scope,
    ...(purpose === "provider" && dispatch.source
      ? { source: dispatch.source }
      : {}),
  });
  const identity = moduleEgressInvocation.get(dispatch);
  if (identity) moduleEgressInvocation.set(derived, identity);
  return derived;
}

/** Keep the platform budget binding when a caller also supplies cancellation. */
export function boundedAbortSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}



let addressResolverForTests: AddressResolver | undefined;

/**
 * Test seam only: suites that drive an egress owner through layers that cannot
 * carry a resolver replace the lookup here. Returns the restore function.
 */
export function __setOutboundAddressResolverForTests(
  resolve: AddressResolver | undefined,
): () => void {
  const previous = addressResolverForTests;
  addressResolverForTests = resolve;
  return () => { addressResolverForTests = previous; };
}

/**
 * The addresses the owner must dial. A caller that already resolved them (a
 * Connection request) passes them in; for every other caller core resolves
 * here, so no path reaches an owner with only a hostname to go on.
 */
async function addressesForOwner(
  url: URL,
  supplied: readonly string[] | undefined,
  resolve: AddressResolver | undefined,
  signal: AbortSignal | undefined,
  denied: (url: URL, reason: "address") => Error,
): Promise<readonly string[]> {
  if (supplied) return supplied;
  const work = verifiedPublicAddresses(url.hostname, resolve ?? addressResolverForTests);
  let onAbort: (() => void) | undefined;
  try {
    return await (signal
      ? Promise.race([
          work,
          new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ])
      : work);
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof OutboundAddressError && error.reason === "non_public") {
      throw denied(url, "address");
    }
    throw new HttpError(502, "PROVIDER_ERROR", "The provider could not be reached.");
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // A lookup that loses the race must not surface as an unhandled rejection.
    work.catch(() => {});
  }
}

export async function fetchValidatedOutbound(input: {
  target: string | URL | Request;
  init: RequestInit;
  allowlist: readonly string[];
  fallback: (target: string | URL | Request, init: RequestInit) => Promise<Response>;
  dispatch?: ModuleEgressDispatch | undefined;
  /**
   * Core-verified public addresses the owner must dial; see `ModuleEgressRequest`.
   * Omitted, core resolves and verifies them here before the owner is called.
   */
  resolvedAddresses?: readonly string[] | undefined;
  /** Injectable for tests; answers every address a name resolves to. */
  resolve?: AddressResolver | undefined;
  /** "address": the host is allow-listed but does not resolve to a public address. */
  denied(url: URL, reason: "protocol" | "host" | "address"): Error;
}): Promise<Response> {
  const url = new URL(
    typeof input.target === "string"
      ? input.target
      : input.target instanceof URL
        ? input.target.href
        : input.target.url,
  );
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw input.denied(url, "protocol");
  }
  assertOutboundTls(url);
  if (!hostAllowed(url.hostname, input.allowlist)) {
    throw input.denied(url, "host");
  }
  throwIfAborted(input.init.signal ?? undefined);
  const provider = input.dispatch?.scope.provider;
  const owner = input.dispatch?.owner;
  if (!input.dispatch || !owner) {
    // Hostname matching alone cannot stop private addresses or DNS rebinding.
    // Production network admission belongs to the selected hardened owner.
    if (process.env.NODE_ENV === "production") {
      throw new HttpError(503, "EGRESS_OWNER_REQUIRED", "Production outbound requests require a configured egress owner.");
    }
    return withRuntimeSpan("external.headers", () => input.fallback(input.target, input.init), { ...(provider ? { provider } : {}) });
  }

  // An owner that calls `fetch` on the URL connects wherever the allow-listed
  // name points. Core cannot see inside the owner, so it only hands requests to
  // one that promised to dial the addresses core checked.
  if (owner.pinsResolvedAddresses !== true) {
    throw new HttpError(
      503,
      "EGRESS_OWNER_REQUIRED",
      "Outbound requests require an egress owner that pins resolved addresses.",
    );
  }

  const dispatch = input.dispatch;
  const allowlist = Object.freeze([...input.allowlist]);
  const scope = Object.freeze({ ...dispatch.scope });
  const source = dispatch.purpose === "provider" && dispatch.source
    ? Object.freeze({ ...dispatch.source })
    : undefined;
  const normalizedInit = { ...input.init } as RequestInit & {
    duplex?: "half";
  };
  if (normalizedInit.body instanceof ReadableStream) {
    normalizedInit.duplex = "half";
  }
  // Request eagerly normalizes every RequestInit field except the body stream
  // and abort reason. Those two deferred inputs are wrapped below.
  const normalized =
    input.target instanceof Request
      ? new Request(input.target, normalizedInit)
      : new Request(
          input.target instanceof URL ? input.target.href : input.target,
          normalizedInit,
        );
  const hasCallerSignal =
    input.target instanceof Request || normalizedInit.signal != null;
  const callerSignal = hasCallerSignal ? normalized.signal : undefined;
  throwIfAborted(callerSignal);
  const resolvedAddresses = await addressesForOwner(
    url,
    input.resolvedAddresses,
    input.resolve,
    callerSignal,
    input.denied,
  );
  const ownerSignal = callerSignal
    ? sanitizeAbortSignal(callerSignal)
    : undefined;
  const body = normalized.body
    ? sanitizeRequestBody(normalized.body)
    : undefined;
  const hookInit: RequestInit & { duplex?: "half" } = {
    method: normalized.method,
    headers: normalized.headers,
    ...(body ? { body, duplex: "half" } : {}),
    cache: normalized.cache,
    credentials: normalized.credentials,
    integrity: normalized.integrity,
    keepalive: normalized.keepalive,
    mode: normalized.mode,
    redirect: normalized.redirect,
    referrer: normalized.referrer,
    referrerPolicy: normalized.referrerPolicy,
    ...(ownerSignal ? { signal: ownerSignal } : {}),
  };
  const init = Object.freeze(hookInit);
  const invocation = moduleEgressInvocation.get(dispatch);
  const createFailure = createModuleEgressFailureFactory(invocation);
  try {
    const response = await withRuntimeSpan("external.headers", () => owner.fetch({
      url: new URL(url),
      init,
      allowlist,
      purpose: dispatch.purpose,
      scope,
      ...(source ? { source } : {}),
      resolvedAddresses: Object.freeze([...resolvedAddresses]),
      ...(ownerSignal ? { signal: ownerSignal } : {}),
      createFailure,
    }), { ...(provider ? { provider } : {}) });
    // A buggy or hostile owner can ignore AbortSignal. Core still owns the
    // cancellation outcome and must not accept a response that arrived after
    // the caller or bounded request cancelled.
    throwIfAborted(callerSignal);
    return response;
  } catch (error) {
    // Cancellation is core-owned and wins over anything the owner or a
    // deferred package input rejected with at the same boundary.
    throwIfAborted(callerSignal);
    // Trust only a factory-issued failure bound to this invocation, and consume
    // its issuance at this boundary so reconstruction and replay fail closed.
    if (
      error instanceof ModuleEgressError &&
      issuedModuleEgressFailures.has(error)
    ) {
      const issuance = moduleEgressFailureIssuance.get(error);
      moduleEgressFailureIssuance.delete(error);
      if (issuance && invocation && issuance.invocation === invocation) {
        throw createTrustedModuleEgressError(issuance.kind, invocation);
      }
    }
    throw error;
  }
}
