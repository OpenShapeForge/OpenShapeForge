// SPDX-License-Identifier: BUSL-1.1
/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint.
 *
 * The MCP specification makes authorization OPTIONAL and conformance a SHOULD
 * for HTTP transports — so serving none of this was a deviation rather than a
 * violation. But a server that participates at all MUST publish protected
 * resource metadata, and clients MUST use it to discover the authorization
 * server. Without it a spec-following MCP client has no way to learn how to
 * authenticate here: it receives a bare 401 with nothing to act on.
 *
 * Two pieces, and both are needed — the document alone is undiscoverable:
 *
 *   - `/.well-known/oauth-protected-resource`, describing this resource and
 *     naming the Keycloak realm as its authorization server;
 *   - a `WWW-Authenticate: Bearer resource_metadata="…"` header on every 401
 *     from the MCP endpoint, which is the pointer clients follow to find it.
 *
 * The audience requirement of the same spec is already satisfied elsewhere:
 * `OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE` pins the expected `aud` and is
 * fatal in production when unset (see config/production-guard.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MCP_MOUNT_PATH } from "./generated-mcp-server.js";

export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * The canonical resource identifier, per RFC 8707 §2: absolute URI, no
 * fragment, and — by this spec's guidance — no trailing slash. It must be the
 * value clients pass as `resource` when requesting a token, and the value this
 * server expects to find in the token's audience, so it is derived from the
 * request rather than configured separately: a mismatch between the two is
 * exactly the confused-deputy case the parameter exists to prevent.
 */
export function canonicalResourceUri(request: FastifyRequest): string {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto =
    (typeof forwardedProto === "string" ? forwardedProto.split(",")[0]?.trim() : undefined) ??
    request.protocol;
  const host = request.headers.host ?? "localhost";
  return `${proto}://${host}${MCP_MOUNT_PATH}`;
}

/**
 * The `WWW-Authenticate` challenge for an unauthenticated MCP request.
 *
 * `scope` is deliberately absent. The spec permits it and recommends it where
 * a server knows which scopes an operation needs — but this deployment
 * authorizes by ROLE, resolved per entity from the compiled manifest, not by
 * OAuth scope. Advertising a scope the authorization server does not issue
 * would send clients to request something meaningless and make the failure
 * harder to read, not easier.
 */
export function buildAuthenticateChallenge(request: FastifyRequest): string {
  const resource = canonicalResourceUri(request);
  const origin = resource.slice(0, resource.length - MCP_MOUNT_PATH.length);
  return `Bearer resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PATH}"`;
}

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers?: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
};

export function buildProtectedResourceMetadata(
  request: FastifyRequest,
  issuer: string | undefined,
): ProtectedResourceMetadata {
  return {
    resource: canonicalResourceUri(request),
    // Omitted rather than empty when the deployment has no bearer verifier
    // configured: an empty list would assert "this resource has no
    // authorization server", which is a different and false claim.
    ...(issuer ? { authorization_servers: [issuer] } : {}),
    // Header only. The spec forbids access tokens in query strings, and this
    // server never reads one from a body.
    bearer_methods_supported: ["header"],
  };
}

/**
 * Register the metadata document.
 *
 * Public and unauthenticated by construction — it is the document a client
 * reads precisely because it cannot yet authenticate. It discloses only the
 * realm URL, which is already public in every token this deployment issues.
 */
export function registerProtectedResourceMetadata(app: FastifyInstance): void {
  app.get(
    PROTECTED_RESOURCE_METADATA_PATH,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER?.trim();
      return reply
        .header("cache-control", "public, max-age=3600")
        .send(buildProtectedResourceMetadata(request, issuer || undefined));
    },
  );

  // RFC 9728 §3.1 also permits the path-suffixed form, which is what a client
  // that already knows the resource path will try first for a resource served
  // below the root. Both spellings answer identically.
  app.get(
    `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_MOUNT_PATH}`,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER?.trim();
      return reply
        .header("cache-control", "public, max-age=3600")
        .send(buildProtectedResourceMetadata(request, issuer || undefined));
    },
  );
}

/**
 * RFC 8414 spells authorization-server metadata URLs by INSERTING the
 * well-known segment between host and issuer path:
 *
 *   https://host/.well-known/oauth-authorization-server/auth/realms/example
 *
 * Keycloak only serves the OIDC-style APPENDED form
 * (`<issuer>/.well-known/openid-configuration`), and because everything under
 * `/.well-known/` routes to this app rather than to Keycloak, a spec-following
 * client that tries the inserted form gets a bare 404 and reports the whole
 * server as unreachable. Standards-compliant clients may try exactly these
 * two spellings before giving up.
 */
export const AUTHORIZATION_SERVER_METADATA_PREFIXES = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
] as const;

type IssuerMetadataFetcher = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

let cachedIssuerMetadata: { body: string; expiresAt: number } | null = null;
const ISSUER_METADATA_TTL_MS = 60 * 60 * 1000;

/** Test seam: drop the memoised upstream document. */
export function resetIssuerMetadataCache(): void {
  cachedIssuerMetadata = null;
}

/**
 * The upstream copy of the issuer's discovery document is fetched over the
 * same in-cluster base the JWKS already comes from — the pod may not be able
 * to reach its own public hostname, and the verifier's JWKS URI is proof that
 * this base is reachable. Keycloak still writes public URLs into the document
 * (endpoint URLs come from its hostname configuration, not from the request),
 * which is exactly what the calling client needs. Falls back to the issuer
 * itself when no JWKS URI is configured.
 */
function issuerMetadataUpstreamUrl(issuer: string): string {
  const jwksUri = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI?.trim();
  const jwksSuffix = "/protocol/openid-connect/certs";
  const base =
    jwksUri?.endsWith(jwksSuffix) === true
      ? jwksUri.slice(0, jwksUri.length - jwksSuffix.length)
      : issuer;
  return `${base}/.well-known/openid-configuration`;
}

/**
 * Serve the RFC 8414 path-inserted spellings for the configured issuer, by
 * returning Keycloak's own document. A proxy for two static documents, not
 * for traffic: tokens, registration and MCP requests still go direct.
 *
 * The wildcard suffix must be exactly the configured issuer's path — this is
 * a mirror of one known document, not an open relay for arbitrary upstreams.
 */
export function registerAuthorizationServerMetadataAliases(
  app: FastifyInstance,
  fetchMetadata: IssuerMetadataFetcher = fetch,
): void {
  for (const prefix of AUTHORIZATION_SERVER_METADATA_PREFIXES) {
    app.get(`${prefix}/*`, async (request: FastifyRequest, reply: FastifyReply) => {
      const issuer = process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER?.trim();
      if (!issuer) {
        return reply.code(404).send({ error: "authorization server metadata not configured" });
      }
      const suffix = `/${(request.params as { "*": string })["*"]}`;
      if (suffix !== new URL(issuer).pathname) {
        return reply.code(404).send({ error: "unknown issuer path" });
      }

      if (!cachedIssuerMetadata || cachedIssuerMetadata.expiresAt < Date.now()) {
        const upstream = await fetchMetadata(issuerMetadataUpstreamUrl(issuer)).catch(() => null);
        if (!upstream?.ok) {
          return reply
            .code(502)
            .send({ error: `authorization server metadata unavailable from ${issuer}` });
        }
        cachedIssuerMetadata = {
          body: await upstream.text(),
          expiresAt: Date.now() + ISSUER_METADATA_TTL_MS,
        };
      }

      return reply
        .header("cache-control", "public, max-age=3600")
        .header("content-type", "application/json")
        .send(cachedIssuerMetadata.body);
    });
  }
}
