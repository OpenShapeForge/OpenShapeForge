// SPDX-License-Identifier: BUSL-1.1
/**
 * Admission of a request to an MCP resource. Split out of
 * generated-mcp-server.ts, verbatim.
 */
import type { FastifyRequest } from "fastify";
import { resolveSessionContext } from "../auth/identity.js";
import { OrganizationBindingError } from "../auth/organization-binding.js";
import { hostMcpResource, usesHostOrganizationContext } from "../config/host-organization.js";
import { canonicalResourceUri, resourcePathOf } from "./protected-resource-metadata.js";
import { organizationAliasFromPath } from "./organization-resource.js";
import {
  assertBearerCredential,
  assertJsonRpcContentType,
  withoutCookieIdentity,
} from "./address.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import { HttpError } from "../rest/http-error.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { rememberSessionIdentity } from "./session-info.js";
import type { McpRegistrationOptions, McpRouteContext } from "./route-context.js";
/**
 * How a request is admitted to an MCP resource, bound to the registration's
 * database: the function every MCP route and the authenticated configuration
 * API call first.
 */
export function createMcpSessionAdmission(
  options: McpRegistrationOptions,
): McpRouteContext["requireMcpSession"] {
  /**
   * The resource a request is addressed to. `/api/mcp` resolves the tenant
   * from the token alone. `/<alias>` binds the session to that
   * organization: the token must be a member of it, carry
   * this resource's URL in `aud` and link to a tenant through the registry
   * (auth/organization-binding.ts). A refusal there is a 403 with the same
   * body for every cause, so the path cannot enumerate organizations.
   */
  return async function requireMcpSession(request: FastifyRequest): Promise<{
    db: OpenShapeForgeDatabase;
    session: TrustedSessionContext;
    resource: string;
  }> {
    const routed = (request.params as { alias?: unknown } | undefined)?.alias;
    if (usesHostOrganizationContext() && routed !== undefined) {
      throw new HttpError(404, "NOT_FOUND", "Unknown MCP resource.");
    }
    // The parametric route also matches a reserved first segment and a
    // malformed alias; the one path parser decides, not the route table.
    const alias = routed === undefined ? undefined : organizationAliasFromPath(request.url);
    if (routed !== undefined && (alias === null || alias !== routed)) {
      throw new HttpError(404, "NOT_FOUND", "Unknown MCP resource.");
    }
    const resource = resourcePathOf(request, alias ?? null);
    const binding = alias
      ? { alias, resource: canonicalResourceUri(request, alias) }
      : null;
    // BOLT 1 (mcp/address.ts). The cookie header is dropped rather than
    // ignored on every MCP path — the app shares this origin, so the browser
    // sends its session cookie here whether or not the page meant to — and an
    // organization resource additionally requires a bearer token, which is the
    // one credential a page cannot obtain by merely being open.
    // Order matters twice. The bearer check reads the ORIGINAL headers,
    // because "you sent a cookie and no token" is the case worth naming in
    // the answer and it is invisible once the cookie has been dropped. And it
    // runs BEFORE the media-type check: a client with no credential yet must
    // receive the 401 challenge (RFC 9728) whatever it sent — hosted clients
    // open with a bare POST to discover where to authenticate — and answering
    // that probe with 415 leaves the resource undiscoverable. Nothing is
    // authenticated by this ordering: the credential is only verified after
    // the media type has been accepted below.
    if (binding || usesHostOrganizationContext()) assertBearerCredential(request.headers);
    // BOLT 2 (mcp/address.ts): a JSON-RPC body only under `application/json`.
    // Checked before anything reads the body or verifies the credential, so a
    // refused media type never becomes an authenticated request.
    assertJsonRpcContentType(request.method, request.headers["content-type"]);
    const mcpHeaders = withoutCookieIdentity(request.headers);

    let resolved: TrustedSessionContext;
    try {
      resolved = await resolveSessionContext(headersFromFastify(mcpHeaders), {
        db: options.db,
        ...(binding ? { organization: binding } : {}),
        ...(usesHostOrganizationContext() ? { requiredAudience: hostMcpResource() } : {}),
      });
    } catch (error) {
      if (error instanceof OrganizationBindingError) {
        throw new HttpError(error.status, error.code, error.message);
      }
      throw error;
    }
    if (!resolved.tenantId || !resolved.userId) {
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "MCP access requires an authenticated session.",
      );
    }
    if (!options.db) {
      throw new HttpError(
        503,
        "DATABASE_NOT_CONFIGURED",
        "Database is not configured for MCP access.",
      );
    }
    // session-info (whoami / osf://session): keep the credential's display
    // facts (name, client, expiry, memberships) beside the verified session,
    // and the organization this endpoint bound it to, when it did.
    rememberSessionIdentity(resolved, headersFromFastify(mcpHeaders), binding);
    return {
      db: options.db,
      session: resolved,
      resource,
    };
  }
}
