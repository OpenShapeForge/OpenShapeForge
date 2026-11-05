// SPDX-License-Identifier: BUSL-1.1
/**
 * One finite HTTPS POST on behalf of a resolved Connection.
 *
 * `fetchValidatedOutbound` stays the only outbound gate: this module adds what
 * a module-initiated request needs in front of it, and nothing that decides
 * differently. The destination allow-list is the one core read off the
 * Adapter when it minted the grant (`socket-egress.ts`), so a module names a
 * URL but never the policy that admits it, and a grant only works for the
 * session, and the short while, it was minted for.
 *
 * Hostname matching cannot see where a name points. Core therefore resolves
 * the host itself, refuses anything that is not a public address, and hands
 * the verified answers to the egress owner, which dials only those: only the
 * dialling side can close DNS rebinding. Every environment refuses an owner
 * that does not declare `pinsResolvedAddresses`.
 *
 * A POST may write, so it is sent exactly once. Nothing retries it, and no
 * redirect is followed: a 3xx is a refusal, because every way of following one
 * either replays the write or quietly turns it into a different request.
 *
 * The response is buffered and finite. An SSE body is returned whole once the
 * upstream closes it, and a stream still open at the deadline is a timeout and
 * yields nothing, so this does not deliver streaming notifications.
 *
 * Failures carry fixed messages. Upstream errors routinely quote the URL or
 * the request, and neither may reach a log or a caller through this path.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { ambientConnectionControls, assertConnectionControls } from "../mcp/connection-expectation.js";
import { HttpError } from "../rest/http-error.js";
import type {
  ModuleConnectionHttpRequest,
  ModuleConnectionHttpResponse,
  ModuleSocketGrant,
  RuntimeModule,
} from "./contract.js";
import {
  boundedAbortSignal,
  createModuleEgressInvocation,
  fetchValidatedOutbound,
  hostAllowed,
} from "./egress.js";
import { readBoundedResponse } from "./outbound-response.js";
import { socketGrantState } from "./socket-egress.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const consumedGrants = new WeakSet<ModuleSocketGrant>();

const NON_PUBLIC_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const;
// Inside global unicast, but reserved or a tunnel to an embedded IPv4 address.
const NON_PUBLIC_V6 = [["2001::", 23], ["2001:db8::", 32], ["2002::", 16]] as const;

function ipv4Bits(address: string): bigint {
  return address.split(".").reduce((bits, octet) => (bits << 8n) | BigInt(octet), 0n);
}

/** Expects a validated address without a zone or an embedded dotted quad. */
function ipv6Bits(address: string): bigint {
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const elided = new Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...elided, ...right].reduce(
    (bits, group) => (bits << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function inNetwork(bits: bigint, network: bigint, prefix: number, width: 32 | 128): boolean {
  const host = BigInt(width - prefix);
  return bits >> host === network >> host;
}

/**
 * IPv6 is an allow-list on purpose: loopback, link-local, unique-local,
 * multicast, NAT64 and every IPv4-mapped form sit outside 2000::/3. Anything
 * that does not parse as a plain address is not public.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bits = ipv4Bits(address);
    return !NON_PUBLIC_V4.some(([network, prefix]) => inNetwork(bits, ipv4Bits(network), prefix, 32));
  }
  if (family !== 6 || /[.%]/.test(address)) return false;
  const bits = ipv6Bits(address);
  return inNetwork(bits, ipv6Bits("2000::"), 3, 128) &&
    !NON_PUBLIC_V6.some(([network, prefix]) => inNetwork(bits, ipv6Bits(network), prefix, 128));
}

// Framing and routing belong to the transport. `Host` in particular would
// separate what the allow-list checked from what the server is asked for.
const RESERVED_REQUEST_HEADER = /^(?:host|content-length|transfer-encoding|connection|keep-alive|te|trailer|upgrade|expect|proxy-.*)$/;
const UNEXPOSABLE_RESPONSE_HEADER = /^set-cookie2?$/;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.!#$&^_-]+\+)?json$/;

type ConnectionHttpDependencies = {
  owner?: RuntimeModule["egress"] | undefined;
  /** Injectable for tests; only `fetchValidatedOutbound`'s fallback calls it. */
  transport?: typeof fetch;
  /** Injectable for tests; answers every address a name resolves to. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
  production?: boolean;
  now?: () => number;
};

const denied = (message: string) => new HttpError(403, "EGRESS_DENIED", message);
const grantRefusal = (adapterKey: string) =>
  denied(`The "${adapterKey}" Adapter does not grant this outbound host.`);
const unavailable = () =>
  new HttpError(502, "PROVIDER_ERROR", "The provider could not be reached.");
const timedOut = () =>
  new HttpError(504, "PROVIDER_TIMEOUT", "The provider did not answer in time.");
const cancelled = () => new DOMException("Outbound request cancelled.", "AbortError");

async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function parseTarget(target: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(target));
  } catch {
    throw denied("The outbound URL is not valid.");
  }
  if (url.protocol !== "https:") throw denied("Connection requests require HTTPS.");
  if (url.username || url.password) {
    throw denied("An outbound URL cannot carry credentials.");
  }
  return url;
}

function requestHeaders(input: ModuleConnectionHttpRequest["headers"]): Headers {
  let headers: Headers;
  try {
    headers = new Headers(input ?? {});
  } catch {
    throw denied("The outbound headers are not valid.");
  }
  for (const name of headers.keys()) {
    if (RESERVED_REQUEST_HEADER.test(name)) {
      throw denied("The outbound headers include one the platform owns.");
    }
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  return headers;
}

function serializedBody(json: unknown): string {
  let body: string | undefined;
  try {
    body = JSON.stringify(json);
  } catch {
    body = undefined;
  }
  if (body === undefined) throw denied("The outbound body is not valid JSON.");
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    throw denied("The outbound body exceeds the supported size.");
  }
  return body;
}

/** Stop waiting at cancellation even if the awaited side ignores the signal. */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
  discard?: (late: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) discard?.(value);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Every answer must be public: a client may dial any of them. */
async function publicAddresses(
  url: URL,
  resolve: NonNullable<ConnectionHttpDependencies["resolve"]>,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = await untilAborted(resolve(hostname), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw unavailable();
    }
    if (addresses.length === 0) throw unavailable();
  }
  if (!addresses.every(isPublicAddress)) {
    throw denied("The outbound host does not resolve to a public address.");
  }
  return [...new Set(addresses)];
}

function responseFormat(response: Response): ModuleConnectionHttpResponse["format"] {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type && JSON_CONTENT_TYPE.test(type)) return "json";
  return type === "text/event-stream" ? "sse" : null;
}

function exposedHeaders(
  response: Response,
  names: readonly string[] | undefined,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const candidate of names ?? []) {
    const name = String(candidate).toLowerCase();
    if (UNEXPOSABLE_RESPONSE_HEADER.test(name)) continue;
    try {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    } catch {
      // An invalid header name is simply a header the response does not have.
    }
  }
  return Object.freeze(headers);
}

/**
 * Decide, then send once. The caller has already established that `session` is
 * live; this binds the grant to that session and to nothing else.
 */
export async function requestConnectionHttp(
  session: TrustedSessionContext,
  grant: ModuleSocketGrant,
  request: ModuleConnectionHttpRequest,
  dependencies: ConnectionHttpDependencies = {},
): Promise<ModuleConnectionHttpResponse> {
  const { owner, transport = fetch, resolve = resolveAddresses } = dependencies;
  const state = socketGrantState(grant);
  if (!state?.binding) {
    throw denied("This outbound request carries no egress grant from the platform.");
  }
  const { binding } = state;
  if (binding.session !== session) {
    throw denied("This egress grant belongs to another session.");
  }
  if ((dependencies.now ?? Date.now)() >= binding.expiresAtMs) {
    throw denied("This egress grant has expired. Resolve the Connection again.");
  }
  if (consumedGrants.has(grant)) {
    throw denied("This egress grant was already used. Resolve the Connection again.");
  }
  // A grant minted before a declarative invocation began still answers to it.
  assertConnectionControls({
    controls: ambientConnectionControls(),
    session,
    connectionTable: binding.connectionTable,
    connection: { id: binding.connectionId, ownerUserId: binding.ownerUserId },
  });

  // Read once: a value validated here is the value sent.
  const { url: target, headers: rawHeaders, json, exposeHeaders, signal } = request;
  const url = parseTarget(target);
  if (!hostAllowed(url.hostname, state.allowlist)) throw grantRefusal(state.adapterKey);
  const headers = requestHeaders(rawHeaders);
  const body = serializedBody(json);
  const timeoutMs = boundedOption(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxBytes = boundedOption(request.maxResponseBytes, DEFAULT_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
  if (owner?.pinsResolvedAddresses !== true) {
    throw new HttpError(
      503,
      "EGRESS_OWNER_REQUIRED",
      "Connection requests require an egress owner that pins resolved addresses.",
    );
  }
  if (signal?.aborted) throw cancelled();
  // A single use forces the next exchange through live Connection resolution,
  // including revocation and owner checks, even within one long session.
  consumedGrants.add(grant);

  const invocation = createModuleEgressInvocation({
    owner,
    purpose: "provider",
    scope: {
      tenantId: session.tenantId,
      actorId: session.userId,
      provider: state.adapterKey,
      operation: "connection.http",
      kind: "mutation",
    },
  });
  const bounded = boundedAbortSignal(signal, timeoutMs);
  try {
    const resolvedAddresses = await publicAddresses(url, resolve, bounded);
    const response = await untilAborted(
      fetchValidatedOutbound({
        target: url,
        init: { method: "POST", headers, body, signal: bounded, redirect: "manual" },
        allowlist: state.allowlist,
        fallback: (next, init) => transport(next, init),
        resolvedAddresses,
        ...(invocation.dispatch ? { dispatch: invocation.dispatch } : {}),
        denied: () => grantRefusal(state.adapterKey),
      }),
      bounded,
      (late) => void late.body?.cancel().catch(() => {}),
    );
    if ((response.status >= 300 && response.status < 400) || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw denied("The provider answered with a redirect, which is never followed.");
    }
    const format = responseFormat(response);
    if (format === null) void response.body?.cancel().catch(() => {});
    const text = format === null ? "" : await readBoundedResponse(response, maxBytes, bounded);
    return Object.freeze({
      status: response.status,
      format,
      body: text,
      headers: exposedHeaders(response, exposeHeaders),
    });
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (bounded.aborted) throw timedOut();
    if (error instanceof HttpError) throw error;
    const failure = invocation.consumeFailure(error);
    if (failure === "timeout") throw timedOut();
    if (failure === "policy_blocked") throw denied("Outbound policy blocked the request.");
    throw unavailable();
  }
}
