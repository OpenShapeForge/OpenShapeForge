// SPDX-License-Identifier: BUSL-1.1
/**
 * Host side of the optional scripted-capability pilot. Both entry points share
 * one validated dispatch into the sandbox daemon: `evaluateFixture` runs a
 * script against structured data alone, `evaluateReadOnly` additionally brokers
 * the read-only bindings its trusted caller approved.
 *
 * This bridge is deliberately narrow. It does not resolve binding names, decide
 * who may use one, inspect the effect metadata of what a binding reads, open a
 * connection, or accept a runnable raw definition: the installed module that
 * calls it owns that policy and calls from inside its own verified invocation
 * session. What is enforced here is the execution boundary — a live verified
 * scoped session of the single enabled pilot tenant, an explicit and bounded
 * alias list, no binding outside it, re-verification of the session before each
 * callback, bounded JSON in both directions, cancellation propagation and
 * refusals reduced to a fixed code.
 */
import type {
  RuntimeScriptedCapabilityBinding,
  RuntimeScriptedCapabilityResult,
  RuntimeScriptedCapabilitySandbox,
} from "@openshapeforge/plugin-runtime";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { ALIAS_PATTERN, parseJson, serializeJson, DEFAULT_LIMITS, type JsonValue } from "../script-sandbox/protocol.js";
import { ScriptExecutionError, type ScriptRead } from "../script-sandbox/run-script.js";
import { createSandboxRunner } from "../script-sandbox/socket-channel.js";

const TENANT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** An explicit, reviewable ceiling on how many names one run may reach at all. */
const MAX_BINDINGS = DEFAULT_LIMITS.maxReads;

/** Carries no detail: the script only ever learns the fixed denial code. */
class BrokeredReadRefused extends Error {
  constructor() {
    super("Brokered read refused");
    this.name = "BrokeredReadRefused";
  }
}

type SessionVerifier = (session: TrustedSessionContext) => boolean;

export function createScriptedCapabilitySandbox(
  acceptsSession: SessionVerifier,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeScriptedCapabilitySandbox<TrustedSessionContext> | undefined {
  const socket = env.OPENSHAPEFORGE_SCRIPT_SANDBOX_SOCKET?.trim();
  const configuredTenants = env.OPENSHAPEFORGE_SCRIPT_SANDBOX_PILOT_TENANTS?.trim();
  if (!socket && !configuredTenants) return undefined;
  const tenantIds = configuredTenants?.split(",").map((id) => id.trim().toLowerCase()) ?? [];
  if (!socket || tenantIds.length !== 1 || tenantIds.some((id) => !TENANT_ID.test(id))) {
    throw new Error("Script sandbox pilot requires a private socket and one explicit pilot tenant UUID.");
  }
  const enabledTenants = new Set(tenantIds);
  const evaluate = createSandboxRunner(socket);
  const verified: SessionVerifier = (session) =>
    Boolean(session.tenantId && session.userId && enabledTenants.has(session.tenantId.toLowerCase()) && acceptsSession(session));

  async function dispatch(
    session: TrustedSessionContext,
    request: { source: string; input: Readonly<Record<string, unknown>>; bindings?: readonly RuntimeScriptedCapabilityBinding[] },
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeScriptedCapabilityResult> {
    // Checked before anything else, so a cross-tenant or detached session never
    // reaches a binding, the daemon or the pilot's own configuration.
    if (!verified(session)) return { ok: false, code: "sandbox_unavailable" };
    const input = boundedObject(request.input);
    if (!input) return { ok: false, code: "invalid_input" };
    const reads = request.bindings === undefined ? undefined : brokeredReads(request.bindings, session, verified);
    if (request.bindings !== undefined && !reads) return { ok: false, code: "invalid_request" };
    try {
      const value = await evaluate({
        ...(reads ? { limits: { deadlineMs: 12_000 } } : {}),
        source: request.source,
        input,
        ...(reads ? { reads } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: error instanceof ScriptExecutionError ? error.code : "worker_failed" };
    }
  }

  return {
    evaluateFixture: (session, { source, input }, options) => dispatch(session, { source, input }, options),
    evaluateReadOnly: (session, { source, input, bindings }, options) => dispatch(session, { source, input, bindings: bindings ?? [] }, options),
  };
}

/** Round-trips through bounded JSON, so no hook, getter or prototype travels. */
function boundedObject(value: unknown): Readonly<Record<string, JsonValue>> | null {
  const text = serializeJson(value, DEFAULT_LIMITS.maxInputBytes);
  const parsed = text === null ? null : parseJson(text, DEFAULT_LIMITS.maxInputBytes);
  if (!parsed?.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return null;
  return parsed.value as Readonly<Record<string, JsonValue>>;
}

/**
 * Builds the alias map of one run from the caller's explicit list. The whole
 * request is refused when the list is empty, longer than `MAX_BINDINGS`, or
 * carries a malformed, repeated or uncallable alias. The map has no prototype,
 * so nothing inherited can be reached as a binding and no alias can shadow one.
 */
function brokeredReads(
  bindings: readonly RuntimeScriptedCapabilityBinding[],
  session: TrustedSessionContext,
  verified: SessionVerifier,
): Readonly<Record<string, ScriptRead>> | null {
  if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > MAX_BINDINGS) return null;
  const reads: Record<string, ScriptRead> = Object.create(null);
  for (const binding of bindings) {
    const alias = binding?.alias;
    const read = binding?.read;
    if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias) || typeof read !== "function" || alias in reads) return null;
    reads[alias] = async (args, context) => {
      // Re-verified per call: a session detached or re-scoped since the run
      // started reaches no binding, however long the script holds the run open.
      context.signal.throwIfAborted();
      if (!verified(session)) throw new BrokeredReadRefused();
      const text = serializeJson(await read(args, { signal: context.signal }), DEFAULT_LIMITS.maxReadResultBytes);
      const parsed = text === null ? null : parseJson(text, DEFAULT_LIMITS.maxReadResultBytes);
      if (!parsed?.ok) throw new BrokeredReadRefused();
      return parsed.value;
    };
  }
  return reads;
}
