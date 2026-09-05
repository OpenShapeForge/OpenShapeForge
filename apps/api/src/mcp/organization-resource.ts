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
 * The built-in Keycloak scope VALUE that selects one Organization membership
 * for the token (`organization.<alias>.id` in the claim, echoed in `scope`).
 *
 * NOT what this server advertises — see {@link organizationResourceScopes}.
 * Kept because it is still the narrowest thing a client that already knows
 * the alias may request at the AUTHORIZATION endpoint, and because the
 * distinction between the value and {@link ORGANIZATION_CLIENT_SCOPE} is the
 * whole reason the advertised list looks the way it does.
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

/**
 * Client scopes this DEPLOYMENT's tokens need that are not implied by the
 * resource: the realm scope carrying the API audience, the role mappings and
 * the person claims. Comma-separated, empty by default.
 *
 * It has to be advertised, not merely configured in the realm, because of a
 * second Keycloak 26 behaviour that a preregistered client hides. A realm
 * applies its DEFAULT client scopes to a newly registered client only when
 * the RFC 7591 request carries no `scope` member at all; the moment it names
 * one, the request is treated as exhaustive and the new client is left with
 * `basic` plus exactly what it asked for. Measured on 26.5:
 *
 *   registration without `scope` -> default: acr basic email hubble-mcp-claims
 *                                            organization profile roles web-origins
 *   registration with any `scope` -> default: basic
 *
 * A client that discovers this server therefore MUST ask for these by name or
 * it authorizes successfully and then holds a token with no audience and no
 * roles — a 401 at the MCP endpoint after a login that looked like it worked.
 *
 * Deployment-specific by nature (Hubble's is `hubble-mcp-claims`), so it is
 * configuration rather than a constant, and the same value belongs on the
 * realm's client-registration allow-list — see organization-scopes.ts.
 */
export const MCP_CLIENT_SCOPES_ENV = "OPENSHAPEFORGE_MCP_CLIENT_SCOPES";

export function deploymentMcpScopes(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string[] {
  const seen = new Set<string>();
  for (const raw of (env[MCP_CLIENT_SCOPES_ENV] ?? "").split(",")) {
    const name = raw.trim();
    if (name.length > 0) seen.add(name);
  }
  return [...seen];
}

/**
 * The scopes a client should request for `/api/mcp/organizations/<alias>` —
 * and, because a client that discovers this server registers ITSELF first,
 * the scopes it will put in its RFC 7591 registration request.
 *
 * That second use is why the membership member is the plain client scope
 * `organization` and not `organization:<alias>`. Keycloak's `Allowed Client
 * Scopes` client-registration policy compares the registration request's
 * scope tokens LITERALLY against the names of client scopes in the realm,
 * before any of them are resolved. `organization:<alias>` is not a name: it
 * is a value resolved per authorization request against the one built-in
 * `organization` client scope (see {@link ORGANIZATION_CLIENT_SCOPE}), so no
 * allow-list can ever hold it and no realm can be configured to accept it.
 * Advertising it made every self-registering client — Claude Code among them
 * — fail at the first step with
 *
 *   403 insufficient_scope, Policy 'Allowed Client Scopes' rejected request
 *
 * leaving `--client-id` on a preregistered client as the only way in. So the
 * advertised list names what a realm can actually allow.
 *
 * Nothing is given up by that. `organization` yields the same Organization
 * Membership claim, keyed by alias, for every organization the caller belongs
 * to; `organization:<alias>` merely narrows it to one. What binds a token to
 * one resource is not the membership claim but `aud`, minted by
 * {@link organizationResourceScope} and checked in auth/organization-binding.ts
 * — which reads the membership of the alias IN THE PATH and never trusts the
 * scope to pick. A multi-organization caller therefore gets a wider claim and
 * exactly the same authority: a token minted for another organization's
 * resource is still refused here, by audience.
 */
export function organizationResourceScopes(
  alias: string,
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string[] {
  return [
    ...deploymentMcpScopes(env),
    ORGANIZATION_CLIENT_SCOPE,
    organizationResourceScope(alias),
  ];
}

/**
 * {@link organizationResourceScopes}, as the names of the client scopes those
 * requested scopes resolve to in the realm — what the control plane puts on
 * the client-registration allow-list and on the realm's optional scopes.
 *
 * The two lists are now IDENTICAL, and that is the invariant rather than a
 * coincidence: a scope this server advertises must be one a realm can allow,
 * or a client that registers with the advertised list is refused before it
 * ever reaches the authorization endpoint. The mapping is kept as the place
 * that would have to translate a dynamic scope value if one were ever
 * advertised again, and asserts the invariant in the meantime.
 */
export function organizationResourceScopeNames(
  alias: string,
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string[] {
  return organizationResourceScopes(alias, env).map((scope) => {
    if (scope === organizationScope(alias)) return ORGANIZATION_CLIENT_SCOPE;
    return scope;
  });
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
