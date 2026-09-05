// SPDX-License-Identifier: BUSL-1.1
/**
 * What a request to a short address is asking for, and the two things it is
 * never allowed to be.
 *
 * `https://hubble.com/zerocopter` is one URL serving two protocols: a person
 * opens it in a browser and gets the app; an MCP client posts JSON-RPC to it
 * and gets the MCP server. Deciding between them is not a heuristic and must
 * not become one — HTTP already has the field for it, and using anything else
 * (a user-agent sniff, a body peek, "does it look like JSON") is how a browser
 * tab ends up being served the MCP endpoint.
 *
 *   GET  + `Accept: text/html`         -> the app
 *   POST + `content-type: application/json` with a JSON-RPC body -> MCP
 *   GET  + `Accept: text/event-stream` -> the MCP stream
 *
 * Because one URL has two representations, every answer on a short address
 * carries `Vary: Accept`: without it a shared cache that saw the HTML answer
 * would hand it to the next MCP client, and vice versa.
 *
 * ── THE TWO BOLTS ───────────────────────────────────────────────────────────
 *
 * Both exist because the app and the MCP endpoint now share an ORIGIN. That is
 * the point of the short address, and it is also what makes these two failures
 * possible for the first time, so they are written down as code rather than
 * left as a property of how the endpoint happens to be built today.
 *
 * 1. {@link withoutCookieIdentity} + {@link assertBearerCredential} — the MCP
 *    endpoint never accepts a cookie as an
 *    identity. The browser attaches the app's session cookie to every request
 *    to this origin, including one made by a page the person did not write. If
 *    the MCP endpoint ever read that cookie, any malicious tab would be a fully
 *    authorized MCP client: no token, no consent, no audience check. So the
 *    cookie header is REMOVED before session resolution rather than merely
 *    ignored, and a request with no bearer token is refused even when it
 *    carries a perfectly valid session cookie.
 *
 * 2. {@link assertJsonRpcContentType} — a JSON-RPC body is accepted only under
 *    `application/json`. `text/plain`, `application/x-www-form-urlencoded` and
 *    `multipart/form-data` are exactly the three content-types the browser
 *    sends WITHOUT a CORS preflight, so a form auto-submitted from any origin
 *    reaches the endpoint with the cookie attached and no preflight to refuse
 *    it. They are named in the refusal so the reason survives the next reader.
 *    The CORS policy is already fail-closed; this is the second bolt, and it
 *    holds even where CORS is configured by someone else.
 *
 * Bolt 1 makes bolt 2 redundant for identity, and bolt 2 makes bolt 1
 * redundant for reachability. That redundancy is deliberate: each one is a
 * single edit away from being removed by someone who can see only the other.
 */

/** Media type of a header value, lowercased, without parameters. */
export function mediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The one content-type a JSON-RPC body may arrive under. */
export const JSON_RPC_CONTENT_TYPE = "application/json";

/**
 * Content-types a browser can send cross-origin with no CORS preflight
 * (Fetch, "CORS-safelisted request-header"). Named rather than derived so the
 * refusal can say WHY these three and not some other list.
 */
export const PREFLIGHT_EXEMPT_CONTENT_TYPES = [
  "text/plain",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
] as const;

export class McpTransportError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "McpTransportError";
    this.status = status;
    this.code = code;
  }
}

/**
 * BOLT 2. A body that carries a JSON-RPC call is read only under
 * `application/json`.
 *
 * 415 rather than 400: the request is well-formed, the media type is the
 * problem, and a client that guessed wrong can fix it from the status alone.
 */
export function assertJsonRpcContentType(
  method: string,
  contentTypeHeader: string | undefined,
): void {
  if (method !== "POST") return;
  const type = mediaType(contentTypeHeader);
  if (type === JSON_RPC_CONTENT_TYPE) return;
  const named = PREFLIGHT_EXEMPT_CONTENT_TYPES.includes(
    type as (typeof PREFLIGHT_EXEMPT_CONTENT_TYPES)[number],
  );
  throw new McpTransportError(
    415,
    "UNSUPPORTED_MEDIA_TYPE",
    `A JSON-RPC body is accepted only as \`${JSON_RPC_CONTENT_TYPE}\`; this request said \`${
      type || "(nothing)"
    }\`.` +
      (named
        ? " That content-type reaches this origin without a CORS preflight, which is precisely why it is refused here."
        : ""),
  );
}

/**
 * BOLT 1, half one: the `cookie` header never reaches session resolution on an
 * MCP path.
 *
 * Nothing in this server reads a cookie as identity today. That is a property
 * of how the credential paths happen to be written (bearer JWT, API key,
 * signed trusted-context headers), not a rule anyone stated — and it stops
 * being safe by accident the moment the app and the MCP endpoint share an
 * origin, which is exactly what the short address does. Removing the header is
 * what makes it a rule: a path added later cannot consult what is not there.
 */
export function withoutCookieIdentity(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  if (headers["cookie"] === undefined) return headers;
  const stripped = { ...headers };
  delete stripped["cookie"];
  return stripped;
}

/**
 * BOLT 1, half two: on an organization resource, only a bearer token is a
 * credential.
 *
 * The browser attaches this origin's cookies to any request a page makes to
 * it, including a page the person did not write. A bearer token is not
 * ambient: it has to be fetched, consented to and attached deliberately, and
 * its `aud` names this exact resource. So the endpoint that serves an
 * organization's data refuses a request that brings no token — and says so
 * differently when a cookie WAS present, because that is the case worth
 * recognising in a log.
 *
 * The legacy `/api/mcp` mount keeps its signed trusted-context path: those
 * headers carry an HMAC over a server-side secret, so a browser page cannot
 * produce them however many cookies it holds.
 */
export function assertBearerCredential(
  headers: Record<string, string | string[] | undefined>,
): void {
  const authorization = headers["authorization"];
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof value === "string" && /^bearer\s+\S/i.test(value.trim())) return;
  throw new McpTransportError(
    401,
    "UNAUTHENTICATED",
    headers["cookie"] !== undefined
      ? "This endpoint authenticates with an `Authorization: Bearer` token. A session cookie is never " +
        "an identity here: the app is served from this same origin, so any page in the browser could " +
        "otherwise call it as you."
      : "This endpoint requires an `Authorization: Bearer` token.",
  );
}

export type ShortAddressIntent = "app" | "mcp" | "mcp-stream" | "unacceptable";

/**
 * What `Accept`, the method and the content-type say a request to `/<alias>`
 * is for. Pure, so the front door (an ingress locally: scripts/dev-proxy.ts)
 * and this server classify identically.
 */
export function classifyShortAddressRequest(input: {
  method: string;
  accept: string | undefined;
  contentType: string | undefined;
}): ShortAddressIntent {
  const accepts = (input.accept ?? "")
    .split(",")
    .map((part) => mediaType(part))
    .filter((part) => part.length > 0);
  const method = input.method.toUpperCase();

  if (method === "POST") {
    return mediaType(input.contentType) === JSON_RPC_CONTENT_TYPE ? "mcp" : "unacceptable";
  }
  if (method === "GET" || method === "HEAD") {
    if (accepts.includes("text/event-stream")) return "mcp-stream";
    if (accepts.includes("text/html")) return "app";
    // No usable Accept at all is the browser-ish default; `*/*` is what curl
    // and most HTTP libraries send, and an MCP client that means the stream
    // says so. Neither is a licence to guess, so the app answers: it is the
    // representation a person gets by typing the address, and an MCP client
    // that arrives here learns from `Vary: Accept` that it must ask.
    if (accepts.length === 0 || accepts.includes("*/*")) return "app";
    return "unacceptable";
  }
  // DELETE ends an MCP session; it carries no representation to negotiate.
  if (method === "DELETE") return "mcp";
  return "unacceptable";
}

/** Every answer on a short address is content-negotiated. */
export const SHORT_ADDRESS_VARY = "Accept";
