// SPDX-License-Identifier: BUSL-1.1
/**
 * Where an API key may be used from.
 *
 * - An optional network allowlist on both key kinds (`allowedIps`). The
 *   address is the one the API derived through its configured trusted proxy
 *   hops (Fastify `trustProxy`), stamped by the server into
 *   {@link CLIENT_ADDRESS_HEADER} on every request and never taken from the
 *   client. A leaked key is useless outside the listed networks.
 *
 * - Never from a web browser. An API key is a server credential: one shipped
 *   to a web page is public, and anyone can read it. A request that carries an
 *   `Origin` header is a browser presenting the key, and is refused for every
 *   key kind. (A non-browser client can omit the header; that is the point —
 *   this stops keys being embedded in pages, it does not authenticate.)
 *
 * The rules, in the order they are checked:
 *   1. A non-empty `allowedIps` refuses any other address, and a request
 *      whose address the server could not establish.
 *   2. A request that carries an `Origin` header is refused.
 */
import { BlockList, isIP } from "node:net";
import { HttpError } from "../../rest/http-error.js";

/**
 * The client address as the API derived it, stamped by the server's own
 * `onRequest` hook from `request.ip` and deleted from whatever the client
 * sent (roles/api.ts). Same pattern as the organization-address header.
 */
export const CLIENT_ADDRESS_HEADER = "x-openshapeforge-client-address";

export const MAX_ALLOWED_IPS = 20;

/** A refusal the caller should see as a 403 naming the rule, not a 401. */
export class ApiKeyRestrictionError extends HttpError {
  constructor(message: string) {
    super(403, "API_KEY_RESTRICTED", message);
    this.name = "ApiKeyRestrictionError";
  }
}

/** A bad allowlist in a create or edit request: the caller's 400. */
export class ApiKeyRestrictionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyRestrictionInputError";
  }
}

export type KeyRequestContext = {
  /** The server-derived client address, or null when none was established. */
  clientAddress: string | null;
  /** The browser's `Origin` header, or null when the request carried none. */
  origin: string | null;
};

/** What the server knows about the request that presented a key. */
export function keyRequestContext(headers: Headers): KeyRequestContext {
  const address = headers.get(CLIENT_ADDRESS_HEADER)?.trim();
  const origin = headers.get("origin")?.trim();
  return {
    clientAddress: address ? address : null,
    origin: origin ? origin : null,
  };
}

/** `::ffff:192.0.2.1` and `192.0.2.1` are the same caller. */
function canonicalAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return (mapped ? mapped[1]! : address).toLowerCase();
}

/**
 * Validate and normalize an allowlist from a create or edit request. Accepts
 * single addresses and CIDR ranges, IPv4 and IPv6. Undefined, null or an
 * empty list all mean "any address" and normalize to an empty list.
 */
export function normalizeAllowedIps(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ApiKeyRestrictionInputError("allowedIps must be a list of IP addresses or CIDR ranges.");
  if (input.length > MAX_ALLOWED_IPS) {
    throw new ApiKeyRestrictionInputError(`allowedIps can hold at most ${MAX_ALLOWED_IPS} entries.`);
  }
  const normalized: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") throw new ApiKeyRestrictionInputError("Every allowedIps entry must be a string.");
    const value = entry.trim();
    const [address, prefix, ...rest] = value.split("/");
    const family = address ? isIP(address) : 0;
    if (!address || family === 0 || rest.length > 0) {
      throw new ApiKeyRestrictionInputError(`"${value}" is not an IP address or CIDR range.`);
    }
    const canonical = canonicalAddress(address);
    const canonicalFamily = isIP(canonical);
    if (prefix !== undefined) {
      const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
      const max = family === 4 ? 32 : 128;
      if (!Number.isInteger(bits) || bits < 0 || bits > max) {
        throw new ApiKeyRestrictionInputError(`"${value}" has an invalid prefix length (0-${max}).`);
      }
      // A mapped IPv6 range is not rewritten: only plain addresses are.
      normalized.push(`${family === 4 ? canonical : address.toLowerCase()}/${bits}`);
    } else {
      normalized.push(canonicalFamily ? canonical : address.toLowerCase());
    }
  }
  return [...new Set(normalized)];
}

/** A stored jsonb list as strings; anything malformed reads as no entries. */
export function storedList(value: unknown): string[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** Whether `address` falls inside any entry of `allowed`. */
export function addressAllowed(allowed: readonly string[], address: string | null): boolean {
  if (allowed.length === 0) return true;
  if (!address) return false;
  const candidate = canonicalAddress(address);
  const family = isIP(candidate);
  if (family === 0) return false;
  const list = new BlockList();
  for (const entry of allowed) {
    const [base, prefix] = entry.split("/");
    const entryFamily = base ? isIP(base) : 0;
    if (!base || entryFamily === 0) continue;
    const type = entryFamily === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(base, type);
    else list.addSubnet(base, Number(prefix), type);
  }
  return list.check(candidate, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Apply the rules in this module's header to one request; throws
 * {@link ApiKeyRestrictionError} when it is refused. `kind` names the key in
 * the log line.
 */
export function assertKeyUsableHere(
  allowedIps: readonly string[],
  request: KeyRequestContext,
  kind: "integration" | "personal",
): void {
  const label = kind === "integration" ? "An integration" : "A personal";
  if (!addressAllowed(allowedIps, request.clientAddress)) {
    console.warn(`[auth] ${label} API key was presented from an address outside its allowlist. Refusing.`);
    throw new ApiKeyRestrictionError("This API key is not allowed from this network address.");
  }
  if (request.origin) {
    console.warn(`[auth] ${label} API key was presented by a web browser. Refusing.`);
    throw new ApiKeyRestrictionError(
      "API keys cannot be used from a web browser: a key in a web page is visible to everyone who opens it. Call the API from a server.",
    );
  }
}
