// SPDX-License-Identifier: BUSL-1.1
/**
 * OAuth metadata discovery for a remote MCP server, as one step that decides
 * nothing else.
 *
 * `entity-oauth-profile.ts` validates metadata an Adapter's author DECLARED and
 * deliberately fetches nothing: no request or callback may name a URL core will
 * believe. This module is the other half — reading the documents a live MCP
 * server publishes — and keeps the same discipline by never holding a transport
 * of its own. The caller injects `MetadataFetch`; there is no `fetch` in scope
 * here, so a derived URL can only ever be dialled through whatever gate the
 * caller already owns (egress allow-list, address pinning, timeout, byte
 * budget). This module contributes the specification's URL derivation and the
 * identity checks, and nothing about where bytes may travel.
 *
 * What it returns is a validated pair of documents, which is exactly the shape
 * `oauthClientProfile` consumes as `auth.serverMetadata` and
 * `auth.protectedResourceMetadata`. Runtime wiring must provide these verified
 * values to that profile without requiring per-tool publication or exposing
 * provider-controlled metadata as trusted authoring configuration.
 *
 * The division of labour with `oauthClientProfile` is deliberate. Here:
 * identity (does this document describe the resource and the issuer it was
 * found under?), transport (is every endpoint https?) and shape (is it bounded,
 * JSON, an object?). There: capability (does the server offer this client
 * authentication, the `authorization_code` grant, PKCE `S256`?). Duplicating
 * the capability rules would give two places that can disagree about whether a
 * server is usable, so this module does not judge capability at all.
 *
 * Client registration, the authorization request and the token exchange are
 * out of scope. Nothing here mints, stores or sends a credential.
 *
 * Unsupported specification cases, refused rather than ignored:
 *
 *   - `signed_metadata`. Both RFC 8414 §2.1 and RFC 9728 §3 let a server ship a
 *     signed JWT copy that TAKES PRECEDENCE over the plain fields. Reading the
 *     plain fields while a signed copy exists means ignoring the authoritative
 *     document, so a document carrying one is refused until the signature is
 *     verified here.
 *   - Multiple authorization servers. Selection is the client's call (RFC 9728
 *     §7.6). This module reports every entry and discovers the one the caller
 *     names, or the first listed when it names none; it never merges two
 *     servers' metadata, and credentials are never shared across them.
 */
import { HttpError } from "../rest/http-error.js";

type JsonRecord = Record<string, unknown>;

/**
 * Both documents are small — a realm's OpenID configuration is a few kilobytes
 * — so this budget is generous and still finite. It is passed to the injected
 * fetch, which is the side that can stop reading, and re-checked on what comes
 * back: a caller that ignores the budget must not be able to hand this module
 * an unbounded document.
 */
export const MAX_METADATA_BYTES = 256 * 1024;

const PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_WELL_KNOWN = "/.well-known/oauth-authorization-server";
const OPENID_CONFIGURATION_WELL_KNOWN = "/.well-known/openid-configuration";

const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9.!#$&^_-]+\+)?json$/;

/**
 * RFC 8414 and RFC 9728 endpoints. Documentation, policy and terms URIs are
 * human-facing rather than endpoints and are not checked. Anchored on the whole
 * name for two reasons: registered metadata parameters are lower snake_case, so
 * nothing conforming is missed, and the name is then safe to quote in a refusal
 * — an unregistered key is attacker-chosen text that nothing reads anyway.
 */
const ENDPOINT_KEY = /^[a-z0-9_]+_endpoint$|^jwks_uri$/;

export type MetadataFetchRequest = {
  /** An absolute https URL derived here from a resource or issuer identity. */
  url: string;
  /**
   * The caller must stop reading past this many bytes rather than buffer the
   * whole body and report its size afterwards.
   */
  maxResponseBytes: number;
};

/**
 * What the injected fetch must return. The caller owns the request; these are
 * the facts this module needs to decide whether the answer may be believed.
 *
 * A caller must NOT follow redirects: a metadata document is trusted because of
 * the identity its URL was derived from, and a followed redirect severs the
 * document from that identity. A caller that cannot suppress redirect
 * following must report `redirected` or a final `url`, and the answer is then
 * refused here.
 */
export type MetadataFetchResponse = {
  status: number;
  /** Media type without parameters, or null when the answer carried none. */
  contentType: string | null;
  /** The decoded body, already held to `maxResponseBytes`. */
  body: string;
  /** The URL the body came from, when it is not the one that was requested. */
  url?: string;
  /** Whether a redirect was followed to produce this answer. */
  redirected?: boolean;
};

export type MetadataFetch = (
  request: MetadataFetchRequest,
) => Promise<MetadataFetchResponse>;

export type DiscoveredProtectedResource = {
  /** The resource identifier the document agrees on, in the form it was discovered under. */
  resource: string;
  /** Which of the derived well-known URLs answered. */
  metadataUrl: string;
  /** Every `authorization_servers` entry, in the order the resource listed them. */
  authorizationServers: string[];
  /** The resource's own document, validated as described above. */
  protectedResourceMetadata: Readonly<JsonRecord>;
};

export type DiscoveredAuthorizationServer = {
  /** The issuer the document agrees on; identical to the one discovery used. */
  issuer: string;
  metadataUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** The server's own document, validated as described above. */
  serverMetadata: Readonly<JsonRecord>;
};

export type DiscoveredMcpOAuth = DiscoveredProtectedResource & {
  authorizationServer: DiscoveredAuthorizationServer;
};

/** The caller handed this module something that cannot be discovered. */
function misconfigured(message: string): HttpError {
  return new HttpError(400, "PROVIDER_MISCONFIGURED", message);
}

/** The remote server published something that cannot be believed. */
function undiscoverable(message: string): HttpError {
  return new HttpError(502, "DISCOVERY_FAILED", message);
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function parsedUrl(value: unknown): URL | undefined {
  try {
    return typeof value === "string" ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * RFC 8707 §2 and the specification's canonical-URI guidance: an absolute https
 * URI with no fragment. A query is refused on top of that, because the
 * well-known URL derived below can only carry the path — a document found that
 * way is not known to describe a query-bearing resource, and accepting it would
 * be exactly the silent mismatch this module exists to prevent.
 */
function resourceUrl(value: unknown, label: string, fault: (message: string) => HttpError): URL {
  const url = parsedUrl(value);
  if (url?.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw fault(`${label} must be an absolute https URI without a query or fragment.`);
  }
  return url;
}

/**
 * The one normalization applied before comparing two resource identifiers:
 * WHATWG parsing writes a bare origin as `https://host/`, so the string a
 * caller passed and the string a document published may differ by that one
 * artificial slash while naming the same resource. Nothing else is normalized —
 * RFC 9728 §3.3 wants the values identical, and the specification asks
 * implementations to use one spelling consistently.
 */
function resourceIdentifier(url: URL): string {
  return url.pathname === "/" ? url.origin : url.href;
}

/** RFC 8414 §2: an https URL with no query or fragment, compared as written. */
function issuerUrl(value: unknown, label: string, fault: (message: string) => HttpError): URL {
  const url = parsedUrl(value);
  if (url?.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw fault(`${label} must be an https URL without a query or fragment.`);
  }
  return url;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

/** A path component for well-known insertion; the root path contributes none. */
function identityPath(url: URL): string {
  return url.pathname === "/" ? "" : url.pathname;
}

/**
 * RFC 9728 §3.1 inserts the well-known segment between host and resource path,
 * so `https://example.com/public/mcp` is described at
 * `https://example.com/.well-known/oauth-protected-resource/public/mcp`. The
 * specification also permits the root form, and has clients try the inserted
 * spelling first and fall back to the root. A resource at the root has only the
 * one spelling. The path is inserted exactly as named: neither spelling of a
 * trailing slash is invented or removed here.
 */
export function protectedResourceMetadataUrls(resource: URL): string[] {
  const root = `${resource.origin}${PROTECTED_RESOURCE_WELL_KNOWN}`;
  const path = identityPath(resource);
  return path ? [`${root}${path}`, root] : [root];
}

/**
 * The ordered list the specification requires a client to try for an issuer.
 * For `https://auth.example.com/tenant1`, in priority order: RFC 8414 path
 * insertion, OpenID Connect Discovery path insertion, then OpenID Connect
 * Discovery path APPENDING — the last being the spelling Keycloak and most
 * OpenID providers actually serve. An issuer at the root has no third form,
 * because appending and inserting produce the same URL.
 *
 * A trailing slash is dropped from the issuer path before insertion: it would
 * otherwise produce an empty path segment, and RFC 8414 issuer identifiers do
 * not carry one. The issuer itself is still compared as written.
 */
export function authorizationServerMetadataUrls(issuer: URL): string[] {
  const path = identityPath(issuer).replace(/\/+$/, "");
  if (!path) {
    return [
      `${issuer.origin}${AUTHORIZATION_SERVER_WELL_KNOWN}`,
      `${issuer.origin}${OPENID_CONFIGURATION_WELL_KNOWN}`,
    ];
  }
  return [
    `${issuer.origin}${AUTHORIZATION_SERVER_WELL_KNOWN}${path}`,
    `${issuer.origin}${OPENID_CONFIGURATION_WELL_KNOWN}${path}`,
    `${issuer.origin}${path}${OPENID_CONFIGURATION_WELL_KNOWN}`,
  ];
}

/**
 * Read the first candidate that answers, and believe only a well-formed answer.
 *
 * A 404 or 410 means this spelling is not where the document lives, so the next
 * candidate is tried; other failures are refused, and a server that DID answer 200 is either believed or
 * refused, never bypassed in favour of a different URL — falling through on a
 * malformed document would let a server hide a mismatch behind a second
 * spelling. A 3xx is a refusal everywhere, see `MetadataFetchResponse`.
 *
 * Upstream-controlled text never reaches a message: the derived URLs are safe
 * to name because this module built them, but a redirect target or a response
 * body is the remote server's own text and is only ever described.
 */
async function metadataDocument(
  fetchMetadata: MetadataFetch,
  candidates: readonly string[],
  what: string,
): Promise<{ metadataUrl: string; document: JsonRecord }> {
  const statuses: number[] = [];
  for (const url of candidates) {
    const response = await fetchMetadata({ url, maxResponseBytes: MAX_METADATA_BYTES });
    if (response.redirected === true || (response.url !== undefined && response.url !== url)) {
      throw undiscoverable(`${what} was answered from another URL after a redirect.`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw undiscoverable(`${what} answered with a redirect, which is never followed.`);
    }
    if (response.status !== 200) {
      // A temporary failure or authorization refusal is not evidence that a
      // document is absent. Do not silently downgrade to a broader candidate.
      if (response.status !== 404 && response.status !== 410) {
        throw undiscoverable(`${what} is unavailable (answered ${response.status}).`);
      }
      statuses.push(response.status);
      continue;
    }
    if (Buffer.byteLength(response.body) > MAX_METADATA_BYTES) {
      throw undiscoverable(`${what} exceeds the supported size.`);
    }
    const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== undefined && !JSON_MEDIA_TYPE.test(mediaType)) {
      throw undiscoverable(`${what} is not a JSON document.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw undiscoverable(`${what} is not valid JSON.`);
    }
    const document = asRecord(parsed);
    if (!document) throw undiscoverable(`${what} is not a JSON object.`);
    if (document.signed_metadata !== undefined) {
      throw undiscoverable(
        `${what} carries signed_metadata, which takes precedence and is not verified here.`,
      );
    }
    return { metadataUrl: url, document };
  }
  throw undiscoverable(
    `${what} was not published at any well-known URL (answered ${statuses.join(", ")}).`,
  );
}

/** Every endpoint the document names must be reachable over TLS, named or not. */
function assertEndpointsOverTls(document: JsonRecord, what: string): void {
  for (const [key, value] of Object.entries(document)) {
    if (!ENDPOINT_KEY.test(key) || value === undefined || value === null) continue;
    const url = parsedUrl(value);
    if (url?.protocol !== "https:" || url.username || url.password || url.hash) {
      throw undiscoverable(`${what} names ${key} as something other than an absolute https URL.`);
    }
  }
}

/**
 * The resource's RFC 9728 document. `resource` must name the resource the
 * document was looked up for — the confused-deputy check the field exists for —
 * and `authorization_servers` must list at least one usable issuer, which the
 * specification requires of every participating MCP server.
 */
export async function discoverProtectedResource(
  resource: string,
  fetchMetadata: MetadataFetch,
  options: { resourceMetadataUrl?: string } = {},
): Promise<DiscoveredProtectedResource> {
  const url = resourceUrl(resource, "The MCP resource URL", misconfigured);
  const what = "The protected resource metadata";
  // Only pass a pointer obtained from the resource's authenticated TLS response.
  // The injected transport must still apply the configured egress boundary.
  const pointer = options.resourceMetadataUrl === undefined ? undefined : parsedUrl(options.resourceMetadataUrl);
  if (options.resourceMetadataUrl !== undefined && (!pointer || pointer.protocol !== "https:" || pointer.username || pointer.password || pointer.hash)) {
    throw misconfigured("The resource metadata pointer must be an absolute https URL without credentials or a fragment.");
  }
  const { metadataUrl, document } = await metadataDocument(
    fetchMetadata,
    pointer ? [pointer.href] : protectedResourceMetadataUrls(url),
    what,
  );
  assertEndpointsOverTls(document, what);

  const published = resourceUrl(
    document.resource,
    "The resource the protected resource metadata names",
    undiscoverable,
  );
  if (resourceIdentifier(published) !== resourceIdentifier(url)) {
    throw new HttpError(
      502,
      "OAUTH_RESOURCE_MISMATCH",
      `${what} names another resource than the one it describes.`,
    );
  }

  const entries = document.authorization_servers;
  const listed = stringList(entries);
  if (!listed?.length) {
    throw undiscoverable(`${what} must list at least one authorization server.`);
  }
  if (listed.length !== (entries as unknown[]).length) {
    throw undiscoverable(`${what} lists an authorization server that is not a string.`);
  }
  for (const entry of listed) {
    issuerUrl(entry, "An authorization server the protected resource lists", undiscoverable);
  }

  return {
    resource: resourceIdentifier(published),
    metadataUrl,
    authorizationServers: listed,
    protectedResourceMetadata: Object.freeze(document),
  };
}

/**
 * The authorization server's RFC 8414 (or OpenID Connect Discovery) document.
 *
 * `issuer` must be IDENTICAL to the identifier the well-known URL was built
 * from (RFC 8414 §3.3, OpenID Connect Discovery §4.3). Without that check a
 * server could answer one issuer's well-known URL with another issuer's
 * endpoints, which is how a token ends up minted by something the resource
 * never named.
 */
export async function discoverAuthorizationServer(
  issuer: string,
  fetchMetadata: MetadataFetch,
): Promise<DiscoveredAuthorizationServer> {
  const url = issuerUrl(issuer, "The authorization server issuer", misconfigured);
  const what = "The authorization server metadata";
  const { metadataUrl, document } = await metadataDocument(
    fetchMetadata,
    authorizationServerMetadataUrls(url),
    what,
  );
  assertEndpointsOverTls(document, what);

  if (document.issuer !== issuer) {
    throw new HttpError(
      502,
      "OAUTH_ISSUER_MISMATCH",
      `${what} names another issuer than the one it was discovered under.`,
    );
  }

  // Capability — grants, PKCE, client authentication — is `oauthClientProfile`'s
  // to judge once a client is known. Only the two endpoints every
  // authorization-code flow needs are required to be present and https here.
  const authorizationEndpoint = document.authorization_endpoint;
  const tokenEndpoint = document.token_endpoint;
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    throw undiscoverable(`${what} names no authorization and token endpoints.`);
  }
  const registrationEndpoint = document.registration_endpoint;

  return {
    issuer,
    metadataUrl,
    authorizationEndpoint,
    tokenEndpoint,
    ...(typeof registrationEndpoint === "string" ? { registrationEndpoint } : {}),
    serverMetadata: Object.freeze(document),
  };
}

/**
 * Both documents for one MCP resource, in the order the specification reads
 * them: the resource names its authorization servers, and only then is an
 * issuer's metadata fetched.
 *
 * `authorizationServer` selects among several listed servers and must appear in
 * the resource's list exactly as the resource spelled it — the resource is the
 * authority on which issuers may mint tokens for it, so a caller's hint can
 * only choose from that list, never add to it. With none named, the first
 * listed is used and `authorizationServers` reports the alternatives for a
 * caller that wants to choose differently.
 */
export async function discoverMcpOAuthMetadata(
  input: { resource: string; authorizationServer?: string; resourceMetadataUrl?: string },
  fetchMetadata: MetadataFetch,
): Promise<DiscoveredMcpOAuth> {
  const resource = await discoverProtectedResource(input.resource, fetchMetadata,
    input.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: input.resourceMetadataUrl });
  const requested = input.authorizationServer;
  if (requested !== undefined && !resource.authorizationServers.includes(requested)) {
    throw new HttpError(
      502,
      "OAUTH_ISSUER_MISMATCH",
      "The protected resource does not name the requested authorization server.",
    );
  }
  const issuer = requested ?? resource.authorizationServers[0]!;
  return {
    ...resource,
    authorizationServer: await discoverAuthorizationServer(issuer, fetchMetadata),
  };
}
