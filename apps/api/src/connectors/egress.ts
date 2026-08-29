// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector HTTP egress.
 *
 * Host allowlisting, address validation, connection selection and redirect
 * handling live in one path. Keeping those steps together matters: resolving a
 * public address and then giving a hostname back to an ordinary HTTP client
 * would let that client resolve the name again and reopen DNS rebinding.
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import type { IncomingHttpHeaders } from "node:http";
import type { ConnectorContract } from "./catalog.js";
import { ConnectorExecutionError } from "./errors.js";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ResolvedAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/**
 * A transport receives both the original URL and the already-approved address.
 * Production connects to that address while retaining the URL hostname for the
 * Host header, TLS SNI and certificate verification. Tests replace this seam
 * without doing DNS or network I/O.
 */
export type ResolvedFetchLike = (
  url: URL,
  init: RequestInit,
  address: ResolvedAddress,
) => Promise<Response>;

export const MAX_CONNECTOR_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
  "transfer-encoding",
] as const;

// Only ordinary representation negotiation may cross an origin automatically.
// An arbitrary connector-defined header can contain a credential even when its
// name is not one of the conventional Authorization/API-key spellings.
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "pragma",
  "range",
  "user-agent",
]);

function subnetList(entries: readonly [string, number, "ipv4" | "ipv6"][]): BlockList {
  const list = new BlockList();
  for (const [network, prefix, family] of entries) {
    list.addSubnet(network, prefix, family);
  }
  return list;
}

/** IANA special-purpose IPv4 blocks that are not globally reachable. */
const NON_PUBLIC_IPV4 = subnetList([
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
]);

// These two anycast addresses are the globally reachable exceptions inside
// the otherwise special-purpose 192.0.0.0/24 registry block.
const PUBLIC_IPV4_EXCEPTIONS = new Set(["192.0.0.9", "192.0.0.10"]);

const IPV6_GLOBAL_UNICAST = subnetList([["2000::", 3, "ipv6"]]);
const IPV6_NAT64_WELL_KNOWN = subnetList([["64:ff9b::", 96, "ipv6"]]);
const IPV6_IETF_PROTOCOL_ASSIGNMENTS = subnetList([["2001::", 23, "ipv6"]]);
const IPV6_PUBLIC_IETF_EXCEPTIONS = subnetList([
  ["2001:1::1", 128, "ipv6"],
  ["2001:1::2", 128, "ipv6"],
  ["2001:1::3", 128, "ipv6"],
  ["2001:3::", 32, "ipv6"],
  ["2001:4:112::", 48, "ipv6"],
  ["2001:20::", 28, "ipv6"],
  ["2001:30::", 28, "ipv6"],
]);
const NON_PUBLIC_IPV6_GLOBAL = subnetList([
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["3fff::", 20, "ipv6"],
]);

function ipv4FromIpv6Tail(address: string): string | undefined {
  const withoutZone = address.split("%", 1)[0]!;
  const [leftRaw, rightRaw, ...extra] = withoutZone.split("::");
  if (extra.length > 0) return undefined;

  const expandSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const parts = side.split(":");
    const words: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (part.includes(".")) {
        if (index !== parts.length - 1 || isIP(part) !== 4) return undefined;
        const octets = part.split(".").map(Number);
        words.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      const word = Number.parseInt(part, 16);
      if (!Number.isInteger(word) || word < 0 || word > 0xffff) return undefined;
      words.push(word);
    }
    return words;
  };

  const left = expandSide(leftRaw ?? "");
  const right = expandSide(rightRaw ?? "");
  if (!left || !right) return undefined;
  const omitted = rightRaw === undefined ? 0 : 8 - left.length - right.length;
  if (omitted < 0 || (rightRaw === undefined && left.length !== 8)) return undefined;
  const words = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (words.length !== 8) return undefined;
  return [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join(
    ".",
  );
}

/**
 * True only for an address that is globally reachable unicast according to the
 * IANA special-purpose registries. Being syntactically valid is not enough:
 * private, loopback, link-local, shared, documentation, benchmark, multicast,
 * translation-local and reserved ranges are all refused.
 */
export function isPubliclyRoutableAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) {
    if (PUBLIC_IPV4_EXCEPTIONS.has(address)) return true;
    return !NON_PUBLIC_IPV4.check(address, "ipv4");
  }
  if (family !== 6) return false;

  if (IPV6_NAT64_WELL_KNOWN.check(address, "ipv6")) {
    const embedded = ipv4FromIpv6Tail(address);
    return embedded !== undefined && isPubliclyRoutableAddress(embedded);
  }
  if (!IPV6_GLOBAL_UNICAST.check(address, "ipv6")) return false;
  if (
    IPV6_IETF_PROTOCOL_ASSIGNMENTS.check(address, "ipv6") &&
    !IPV6_PUBLIC_IETF_EXCEPTIONS.check(address, "ipv6")
  ) {
    return false;
  }
  return !NON_PUBLIC_IPV6_GLOBAL.check(address, "ipv6");
}

function hostnameOf(url: URL): string {
  const unbracketed = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

export const resolveHostAddresses: HostResolver = async (hostname) => {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function headersFromIncoming(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function requestBodyBuffer(body: RequestInit["body"] | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError("The pinned connector transport requires a replayable request body.");
}

/**
 * The production transport. `agent: false` prevents a pooled connection from
 * bypassing this hop's selected address. The custom lookup binds the socket to
 * the approved address while the original hostname continues to drive Host,
 * SNI and certificate validation.
 */
export const fetchPinnedAddress: ResolvedFetchLike = async (url, init, address) =>
  new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init.headers);
    const body = requestBodyBuffer(init.body);

    for (const name of [
      "connection",
      "host",
      "keep-alive",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      headers.delete(name);
    }
    headers.set("host", url.host);
    // The standard fetch surface exposes decoded response bytes. Asking for
    // identity keeps the native HTTP transport's Response equivalent without
    // trusting or reimplementing content decoders here.
    headers.set("accept-encoding", "identity");
    headers.delete("content-length");
    if (body !== undefined) headers.set("content-length", String(body.byteLength));

    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: hostnameOf(url),
      ...(url.port ? { port: url.port } : {}),
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal ?? undefined,
      agent: false,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) {
          const callbackWithAll = callback as unknown as (
            error: Error | null,
            addresses: ResolvedAddress[],
          ) => void;
          callbackWithAll(null, [{ address: address.address, family: address.family }]);
          return;
        }
        callback(null, address.address, address.family);
      },
    });

    request.once("error", reject);
    request.once("response", (incoming) => {
      try {
        const status = incoming.statusCode ?? 500;
        const bodyless = status === 101 || status === 204 || status === 205 || status === 304;
        resolve(
          new Response(
            bodyless
              ? null
              : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>),
            {
              status,
              ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
              headers: headersFromIncoming(incoming.headers),
            },
          ),
        );
      } catch (error) {
        // Node accepts response metadata that the Fetch Response constructor
        // rejects (for example status 700). Never let upstream-controlled wire
        // values throw out of this event callback and terminate the process.
        incoming.destroy();
        reject(error);
      }
    });
    if (body === undefined) request.end();
    else request.end(body);
  });

/**
 * Host matching for `network.egress`. Three forms, narrowest first:
 *
 * | Pattern | Matches |
 * | --- | --- |
 * | `example.com` | that host, exactly |
 * | `*.example.com` | exactly one extra label |
 * | `**.example.com` | any subdomain depth |
 *
 * Neither wildcard matches the bare apex or a lookalike suffix.
 */
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

function deny(contract: ConnectorContract, message: string): never {
  throw new ConnectorExecutionError("CONNECTOR_EGRESS_DENIED", contract.slug, message);
}

async function approvedAddresses(
  contract: ConnectorContract,
  url: URL,
  signal: AbortSignal,
  resolver: HostResolver,
): Promise<readonly ResolvedAddress[]> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    deny(
      contract,
      `Connector "${contract.slug}" attempted a ${url.protocol} request; only http(s) is permitted.`,
    );
  }
  if (url.username || url.password) {
    deny(contract, `Connector "${contract.slug}" attempted a URL containing credentials.`);
  }

  const hostname = hostnameOf(url).toLowerCase();
  if (!hostAllowed(hostname, contract.network.egress)) {
    deny(
      contract,
      `Connector "${contract.slug}" attempted to reach ${hostname}, which its contract ` +
        "does not declare in network.egress.",
    );
  }

  const answers = await withAbort(Promise.resolve().then(() => resolver(hostname)), signal);
  if (answers.length === 0) {
    deny(contract, `Connector "${contract.slug}" resolved an egress host to no addresses.`);
  }

  const approved: ResolvedAddress[] = [];
  const seen = new Set<string>();
  for (const answer of answers) {
    const actualFamily = isIP(answer.address);
    if (
      (actualFamily !== 4 && actualFamily !== 6) ||
      actualFamily !== answer.family ||
      !isPubliclyRoutableAddress(answer.address)
    ) {
      deny(
        contract,
        `Connector "${contract.slug}" resolved an egress host to a non-public address.`,
      );
    }
    const key = `${answer.family}:${answer.address}`;
    if (!seen.has(key)) {
      approved.push(Object.freeze({ address: answer.address, family: answer.family }));
      seen.add(key);
    }
  }
  return approved;
}

type RequestState = {
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer> | undefined;
  redirect: "error" | "follow" | "manual";
};

async function requestState(
  input: string | URL | Request,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<RequestState> {
  throwIfAborted(signal);
  // The operation signal deliberately replaces a package-supplied signal, so a
  // connector cannot opt out of its attempt budget.
  const request =
    input instanceof Request
      ? new Request(input, { ...init, signal })
      : new Request(typeof input === "string" ? input : input.href, { ...init, signal });
  const url = new URL(request.url);
  url.hash = "";
  const body =
    request.body === null
      ? undefined
      : new Uint8Array(await withAbort(request.arrayBuffer(), signal));
  return {
    url,
    method: request.method,
    headers: new Headers(request.headers),
    body,
    redirect: request.redirect,
  };
}

function requestInit(state: RequestState, signal: AbortSignal): RequestInit {
  return {
    method: state.method,
    headers: new Headers(state.headers),
    redirect: "manual",
    signal,
    ...(state.body === undefined ? {} : { body: state.body }),
  };
}

function nextRequestState(state: RequestState, status: number, url: URL): RequestState {
  const switchToGet =
    ((status === 301 || status === 302) && state.method === "POST") ||
    (status === 303 && state.method !== "GET" && state.method !== "HEAD");
  if (!switchToGet) return { ...state, url };

  const headers = new Headers(state.headers);
  for (const name of BODY_HEADERS) headers.delete(name);
  return { ...state, url, method: "GET", headers, body: undefined };
}

function carriesCrossOriginMaterial(state: RequestState): boolean {
  if (state.body !== undefined || state.url.search !== "") return true;
  for (const [name] of state.headers) {
    if (!CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())) return true;
  }
  return false;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The policy failure remains the useful error if a synthetic response body
    // was already consumed or locked.
  }
}

/**
 * A fetch bound to the contract's allowlist and the operation's abort signal.
 * Redirects are always obtained manually, then each destination is allowlisted,
 * resolved, address-checked and connected through the same pinned transport.
 */
export function createBoundFetch(
  contract: ConnectorContract,
  signal: AbortSignal,
  transport: ResolvedFetchLike = fetchPinnedAddress,
  resolver: HostResolver = resolveHostAddresses,
): FetchLike {
  return async (input, init) => {
    let state = await requestState(input, init, signal);
    let redirectCount = 0;
    const visited = new Set<string>();

    while (true) {
      throwIfAborted(signal);
      const visitKey = `${state.method} ${state.url.href}`;
      if (visited.has(visitKey)) {
        deny(contract, `Connector "${contract.slug}" encountered a redirect loop.`);
      }
      visited.add(visitKey);

      const addresses = await approvedAddresses(contract, state.url, signal, resolver);
      const response = await transport(
        state.url,
        requestInit(state, signal),
        addresses[0]!,
      );
      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
      if (state.redirect === "manual") return response;

      if (state.redirect === "error") {
        await discard(response);
        deny(contract, `Connector "${contract.slug}" refused an upstream redirect.`);
      }
      if (redirectCount >= MAX_CONNECTOR_REDIRECTS) {
        await discard(response);
        deny(contract, `Connector "${contract.slug}" exceeded its redirect limit.`);
      }

      let destination: URL;
      try {
        destination = new URL(location, state.url);
      } catch {
        await discard(response);
        deny(contract, `Connector "${contract.slug}" received an invalid redirect target.`);
      }
      destination.hash = "";
      if (state.url.protocol === "https:" && destination.protocol === "http:") {
        await discard(response);
        deny(
          contract,
          `Connector "${contract.slug}" refused to follow an HTTPS-to-HTTP redirect.`,
        );
      }
      if (destination.origin !== state.url.origin && carriesCrossOriginMaterial(state)) {
        await discard(response);
        deny(
          contract,
          `Connector "${contract.slug}" refused to forward request material across origins.`,
        );
      }

      await discard(response);
      state = nextRequestState(state, response.status, destination);
      redirectCount += 1;
    }
  };
}
