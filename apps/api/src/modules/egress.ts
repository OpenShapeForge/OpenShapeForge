// SPDX-License-Identifier: BUSL-1.1
/** Canonical protocol/allowlist gate and optional runtime-module egress owner. */
import type {
  ModuleEgressFailureKind,
  ModuleEgressInvocationSource,
  RuntimeModule,
} from "./contract.js";

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

/** Exact, single-label and arbitrary-depth host grants. */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const candidate = host.toLowerCase();
  return allowlist.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("**.")) {
      const suffix = pattern.slice(2);
      return candidate.endsWith(suffix) && candidate.length > suffix.length;
    }
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      if (!candidate.endsWith(suffix)) return false;
      const prefix = candidate.slice(0, -suffix.length);
      return prefix.length > 0 && !prefix.includes(".");
    }
    return candidate === pattern;
  });
}

export async function fetchValidatedOutbound(input: {
  target: string | URL | Request;
  init: RequestInit;
  allowlist: readonly string[];
  fallback: (target: string | URL | Request, init: RequestInit) => Promise<Response>;
  dispatch?: ModuleEgressDispatch | undefined;
  denied(url: URL, reason: "protocol" | "host"): Error;
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
  if (!hostAllowed(url.hostname, input.allowlist)) {
    throw input.denied(url, "host");
  }
  throwIfAborted(input.init.signal ?? undefined);
  if (!input.dispatch?.owner) {
    return input.fallback(input.target, input.init);
  }

  const allowlist = Object.freeze([...input.allowlist]);
  const scope = Object.freeze({ ...input.dispatch.scope });
  const source = input.dispatch.purpose === "provider" && input.dispatch.source
    ? Object.freeze({ ...input.dispatch.source })
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
  const invocation = moduleEgressInvocation.get(input.dispatch);
  const createFailure = createModuleEgressFailureFactory(invocation);
  try {
    const response = await input.dispatch.owner.fetch({
      url: new URL(url),
      init,
      allowlist,
      purpose: input.dispatch.purpose,
      scope,
      ...(source ? { source } : {}),
      ...(ownerSignal ? { signal: ownerSignal } : {}),
      createFailure,
    });
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
