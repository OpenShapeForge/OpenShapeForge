// SPDX-License-Identifier: BUSL-1.1
/**
 * Per-organization MCP resources.
 *
 * Beside the legacy `/api/mcp` mount — one resource for every tenant of a
 * deployment, tenant taken from the token alone — the MCP server also answers
 * on one resource PER Keycloak Organization:
 *
 *   /api/mcp/organizations/<alias>
 *
 * The path names the Organization by its Keycloak alias, which is what the
 * Organization Membership mapper keys the `organization` claim by and what the
 * built-in `organization:<alias>` scope selects. It is deliberately not the
 * tenant slug or id: a tenant id never appears in a token, and the alias is
 * the only name for the organization that a client, Keycloak and this server
 * all agree on without a registry read.
 *
 * Why a resource per organization at all: RFC 8707 binds a token to the
 * resource it was minted for through `aud`. With a single resource, a user
 * who is a member of several organizations holds one token that is valid for
 * every one of them and the server has to trust a scope to pick; with one
 * resource per organization the token is only good on the path it names, so
 * a Zerocopter credential presented to Hubble's endpoint is refused before
 * any tenant is resolved — by accident or otherwise. The checks themselves
 * live in auth/organization-binding.ts.
 *
 * Only the path vocabulary lives here so both the metadata module and the
 * server can import it without importing each other.
 */

export const MCP_MOUNT_PATH = "/api/mcp";

export const ORGANIZATION_MCP_PATH_PREFIX = `${MCP_MOUNT_PATH}/organizations`;

/**
 * Keycloak Organization aliases are URL-safe by construction (the admin
 * console refuses anything else). The same shape is enforced here so a path
 * segment can never smuggle a separator into a scope name, an audience value
 * or a log line. Case-sensitive: Keycloak treats `Acme` and `acme` as two
 * aliases and so does this server.
 */
const ORGANIZATION_ALIAS = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export function isOrganizationAlias(value: unknown): value is string {
  return typeof value === "string" && ORGANIZATION_ALIAS.test(value);
}

export function organizationMcpPath(alias: string): string {
  return `${ORGANIZATION_MCP_PATH_PREFIX}/${alias}`;
}

/**
 * The built-in Keycloak scope that selects one Organization membership for
 * the token (`organization.<alias>.id` in the claim, echoed in `scope`).
 */
export function organizationScope(alias: string): string {
  return `organization:${alias}`;
}

/**
 * The deployment-managed client scope whose audience mapper puts the
 * per-organization resource URL into `aud`. It cannot share the
 * `organization:` prefix: a static client scope named `organization:<alias>`
 * shadows Keycloak's dynamic `organization:*` scope, and the token then
 * carries the audience but no membership claim (verified on Keycloak 26.5).
 */
export function organizationResourceScope(alias: string): string {
  return `mcp-resource:${alias}`;
}

/** The scopes a client should request for `/api/mcp/organizations/<alias>`. */
export function organizationResourceScopes(alias: string): string[] {
  return [organizationScope(alias), organizationResourceScope(alias)];
}

/**
 * The REALM CLIENT SCOPE that `organization:<alias>` is an instance of.
 *
 * Keycloak 26 does not store `organization:<alias>` anywhere: the alias is a
 * parameter resolved per authorization request against the one built-in
 * `organization` client scope. So wherever a *stored* configuration has to name
 * the organization scope — a client's optional scopes, the realm defaults, the
 * client-registration allow-list — the name is this one, never the instance.
 */
export const ORGANIZATION_CLIENT_SCOPE = "organization";

/**
 * {@link organizationResourceScopes}, as the names of the client scopes those
 * requested scopes resolve to in the realm.
 *
 * Derived from the advertised list rather than written out again, so a scope
 * added to what the protected-resource metadata advertises is automatically
 * one the registration allow-list has to carry. Only the dynamic member is
 * rewritten; a literal scope IS its own client scope and passes through.
 */
export function organizationResourceScopeNames(alias: string): string[] {
  return organizationResourceScopes(alias).map((scope) =>
    scope === organizationScope(alias) ? ORGANIZATION_CLIENT_SCOPE : scope,
  );
}

/**
 * The organization a request path names, or null for the legacy mount and
 * anything else. Fastify already split the alias into `params`; it is read
 * from the URL here so the metadata route, the challenge builder and the MCP
 * handler agree on one parser. The query string is not part of the resource.
 */
export function organizationAliasFromPath(url: string | undefined): string | null {
  const path = typeof url === "string" ? (url.split("?")[0] ?? "") : "";
  if (!path.startsWith(`${ORGANIZATION_MCP_PATH_PREFIX}/`)) return null;
  const rest = path.slice(ORGANIZATION_MCP_PATH_PREFIX.length + 1);
  if (!isOrganizationAlias(rest)) return null;
  return rest;
}
