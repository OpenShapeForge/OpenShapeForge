// SPDX-License-Identifier: BUSL-1.1
/**
 * Where an API key may be used from, and what a browser key may call.
 *
 * - An optional network allowlist on both key kinds (`allowedIps`). The
 *   address is the one the API derived through its configured trusted proxy
 *   hops (Fastify `trustProxy`), stamped by the server into
 *   {@link CLIENT_ADDRESS_HEADER} on every request and never taken from the
 *   client. A leaked key is useless outside the listed networks.
 *
 * - Browser keys: an integration with web sites (`allowedOrigins`). A key in
 *   a web page is public — anyone who opens the page can read it and replay it
 *   with any `Origin` they like from outside a browser. Origins therefore do
 *   not protect the key; they stop OTHER web sites from using it in their
 *   visitors' browsers, and let the REST surface answer the CORS handshake.
 *   What protects the organization is that a browser key is DENY BY DEFAULT:
 *   it may call only the endpoints listed in `allowedEndpoints`
 *   (`GET /api/rest/v1/relations`, `POST /api/rest/v1/relations/:id`), each
 *   matched against the request the server itself stamped into
 *   {@link REQUEST_TARGET_HEADER}. An empty list means it can call nothing.
 *   The key's roles still apply on top.
 *
 * - Every other key (an integration without web sites, and every personal key)
 *   is a server credential and is refused whenever a browser presents it.
 *
 * The rules, in the order they are checked:
 *   1. A non-empty `allowedIps` refuses any other address, and a request
 *      whose address the server could not establish.
 *   2. A browser key needs an `Origin` naming one of its sites, and a request
 *      matching one of its endpoints.
 *   3. Any other key is refused when the request carries an `Origin` header.
 */
import { BlockList, isIP } from "node:net";
import { HttpError } from "../../rest/http-error.js";

/**
 * The client address as the API derived it, stamped by the server's own
 * `onRequest` hook from `request.ip` and deleted from whatever the client
 * sent (roles/api.ts). Same pattern as the organization-address header.
 */
export const CLIENT_ADDRESS_HEADER = "x-openshapeforge-client-address";

/**
 * `<METHOD> <path>` of the request as the server routes it (after the
 * organization short-address rewrite, without the query), stamped by the same
 * hook and likewise never the client's.
 */
export const REQUEST_TARGET_HEADER = "x-openshapeforge-request-target";

export const MAX_ALLOWED_IPS = 20;
export const MAX_ALLOWED_ORIGINS = 10;
export const MAX_ALLOWED_ENDPOINTS = 50;

const ENDPOINT_METHODS = new Set(["GET", "POST"]);

/**
 * Surfaces a browser key can never be granted: GraphQL and MCP are not REST
 * endpoints with a fixed effect, the control plane is not a tenant's, and a
 * key never manages keys.
 */
const UNLISTABLE_PREFIXES = [
  "/api/graphql", "/api/mcp", "/api/control", "/api/entity-configuration", "/api/browser-client",
  "/api/api-keys", "/api/api-key-integrations", "/api/personal-api-keys",
];

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

export type KeyRestrictions = {
  allowedIps: readonly string[];
  allowedOrigins: readonly string[];
  allowedEndpoints: readonly string[];
};

export type KeyRequestContext = {
  /** The server-derived client address, or null when none was established. */
  clientAddress: string | null;
  /** The browser's `Origin` header, or null when the request carried none. */
  origin: string | null;
  /** The server-stamped `<METHOD> <path>`, or null when none was stamped. */
  target: string | null;
};

/** What the server knows about the request that presented a key. */
export function keyRequestContext(headers: Headers): KeyRequestContext {
  const address = headers.get(CLIENT_ADDRESS_HEADER)?.trim();
  const origin = headers.get("origin")?.trim();
  const target = headers.get(REQUEST_TARGET_HEADER)?.trim();
  return {
    clientAddress: address ? address : null,
    origin: origin ? origin : null,
    target: target ? target : null,
  };
}

/** The value of {@link REQUEST_TARGET_HEADER} for a routed request. */
export function requestTarget(method: string, url: string): string {
  const query = url.indexOf("?");
  return `${method.toUpperCase()} ${query === -1 ? url : url.slice(0, query)}`;
}

/** `::ffff:192.0.2.1` and `192.0.2.1` are the same caller. */
function canonicalAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return (mapped ? mapped[1]! : address).toLowerCase();
}

function listInput(input: unknown, name: string, max: number): string[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) throw new ApiKeyRestrictionInputError(`${name} must be a list.`);
  if (input.length > max) throw new ApiKeyRestrictionInputError(`${name} can hold at most ${max} entries.`);
  return input.map((entry) => {
    if (typeof entry !== "string") throw new ApiKeyRestrictionInputError(`Every ${name} entry must be a string.`);
    return entry.trim();
  });
}

/**
 * Validate and normalize an allowlist from a create or edit request. Accepts
 * single addresses and CIDR ranges, IPv4 and IPv6. Undefined, null or an
 * empty list all mean "any address" and normalize to an empty list.
 */
export function normalizeAllowedIps(input: unknown): string[] {
  const entries = listInput(input, "allowedIps", MAX_ALLOWED_IPS);
  if (!entries) return [];
  const normalized: string[] = [];
  for (const value of entries) {
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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate and normalize browser origins. Each must be an exact origin:
 * scheme, host and optional port, no path, query, fragment, credentials or
 * wildcard. `https` is required except for loopback development origins.
 */
export function normalizeAllowedOrigins(input: unknown): string[] {
  const entries = listInput(input, "allowedOrigins", MAX_ALLOWED_ORIGINS);
  if (!entries) return [];
  const normalized: string[] = [];
  for (const value of entries) {
    if (value.includes("*")) {
      throw new ApiKeyRestrictionInputError(`"${value}": wildcards are not allowed; list each web site exactly.`);
    }
    let url: URL;
    try { url = new URL(value); }
    catch { throw new ApiKeyRestrictionInputError(`"${value}" is not a web site such as https://shop.example.com.`); }
    const loopback = LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new ApiKeyRestrictionInputError(`"${value}" must use https (http is only allowed for localhost).`);
    }
    if (url.username || url.password || url.search || url.hash ||
        (url.pathname !== "/" && url.pathname !== "") ||
        value.replace(/\/$/, "").toLowerCase() !== url.origin.toLowerCase()) {
      throw new ApiKeyRestrictionInputError(`"${value}" must be a web site only: no path, query or fragment.`);
    }
    normalized.push(url.origin);
  }
  return [...new Set(normalized)];
}

/**
 * Validate and normalize the endpoints a browser key may call:
 * `<GET|POST> /api/<path>`, where a segment written `:name` matches any one
 * path segment. No query, no wildcards, nothing under the unlistable surfaces.
 */
export function normalizeAllowedEndpoints(input: unknown): string[] {
  const entries = listInput(input, "allowedEndpoints", MAX_ALLOWED_ENDPOINTS);
  if (!entries) return [];
  const normalized: string[] = [];
  for (const value of entries) {
    const match = /^([A-Za-z]+)\s+(\S+)$/.exec(value);
    const method = match?.[1]?.toUpperCase();
    let path = match?.[2];
    if (!method || !path || !ENDPOINT_METHODS.has(method)) {
      throw new ApiKeyRestrictionInputError(`"${value}" must be an endpoint such as "GET /api/rest/v1/relations".`);
    }
    if (path.length > 1) path = path.replace(/\/+$/, "");
    if (!path.startsWith("/api/") || path.includes("?") || path.includes("*") || path.includes("//") ||
        path.split("/").some((segment) => segment === "." || segment === ".." || segment === ":")) {
      throw new ApiKeyRestrictionInputError(`"${value}" must name one path under /api/, without query or wildcards.`);
    }
    if (UNLISTABLE_PREFIXES.some((prefix) => path === prefix || path!.startsWith(`${prefix}/`))) {
      throw new ApiKeyRestrictionInputError(`"${value}" cannot be opened to a browser key.`);
    }
    normalized.push(`${method} ${path}`);
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

/** Whether a stamped `<METHOD> <path>` matches one listed endpoint. */
export function endpointAllowed(allowed: readonly string[], target: string | null): boolean {
  if (!target) return false;
  const [method, rawPath] = target.split(" ", 2);
  if (!method || !rawPath) return false;
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  const segments = path.split("/");
  return allowed.some((entry) => {
    const [entryMethod, entryPath] = entry.split(" ", 2);
    if (entryMethod !== method || !entryPath) return false;
    const pattern = entryPath.split("/");
    if (pattern.length !== segments.length) return false;
    return pattern.every((part, index) => {
      const actual = segments[index]!;
      return part.startsWith(":") ? actual.length > 0 : part === actual;
    });
  });
}

/**
 * Apply the rules in this module's header to one request. Returns whether
 * the key acted as a browser key; throws {@link ApiKeyRestrictionError} when
 * the request is refused.
 */
export function assertKeyUsableHere(
  restrictions: KeyRestrictions,
  request: KeyRequestContext,
  kind: "integration" | "personal",
): { browser: boolean } {
  const label = kind === "integration" ? "An integration" : "A personal";
  if (!addressAllowed(restrictions.allowedIps, request.clientAddress)) {
    console.warn(`[auth] ${label} API key was presented from an address outside its allowlist. Refusing.`);
    throw new ApiKeyRestrictionError("This API key is not allowed from this network address.");
  }
  if (kind === "integration" && restrictions.allowedOrigins.length > 0) {
    if (!request.origin || !restrictions.allowedOrigins.includes(request.origin)) {
      console.warn("[auth] A browser API key was presented without one of its allowed web sites. Refusing.");
      throw new ApiKeyRestrictionError("This API key is not allowed from this web site.");
    }
    if (!endpointAllowed(restrictions.allowedEndpoints, request.target)) {
      console.warn("[auth] A browser API key called an endpoint outside its allowlist. Refusing.");
      throw new ApiKeyRestrictionError("This browser API key may not call this endpoint.");
    }
    return { browser: true };
  }
  if (request.origin) {
    console.warn(`[auth] ${label} API key was presented by a web browser. Refusing.`);
    throw new ApiKeyRestrictionError(
      kind === "personal"
        ? "A personal API key cannot be used from a web browser."
        : "This API key cannot be used from a web browser. Add the web site and the endpoints it may call to the integration to make it a browser key.",
    );
  }
  return { browser: false };
}
