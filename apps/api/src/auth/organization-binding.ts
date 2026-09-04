// SPDX-License-Identifier: BUSL-1.1
/**
 * Binding a bearer token to one per-organization MCP resource.
 *
 * A request to `/api/mcp/organizations/<alias>` is accepted only when the
 * verified token, the path and the tenant registry all name the same
 * organization:
 *
 *   1. membership — the token's `organization` claim (Keycloak's Organization
 *      Membership mapper) carries an entry whose alias equals the path's and
 *      that entry has the Organization's immutable id;
 *   2. audience — `aud` contains the canonical URL of the resource being
 *      called, i.e. the token was minted FOR this resource (RFC 8707 §2 as
 *      Keycloak can express it: a per-organization client scope with an
 *      audience mapper, because Keycloak 26 does not fold the `resource`
 *      request parameter into `aud`);
 *   3. registry — `platform.tenants` links that Organization id (in the
 *      token's realm) to exactly one tenant, which becomes the session's
 *      tenant regardless of any other membership or `tid` the token carries.
 *
 * Every failure is answered identically. An unknown alias, an organization
 * the caller is not a member of and a token that was simply not requested
 * for this resource all produce the same refusal, so the endpoint cannot be
 * used to enumerate organizations or to learn who is a member of what. The
 * message names the scopes to request, which is the only actionable thing a
 * legitimate client needs to hear and reveals nothing it did not already
 * know (it chose the path).
 *
 * The audience alone is NOT authority: Keycloak mints the per-organization
 * audience for anyone who requests the scope, member or not. Membership is
 * what the identity provider actually asserts; the audience is what stops a
 * token minted for another resource — another organization, another origin —
 * from being replayed here.
 */
import type { AuthIdentity } from "@openshapeforge/auth";
import {
  organizationResourceScopes,
} from "../mcp/organization-resource.js";

export type OrganizationResourceBinding = {
  /** Keycloak Organization alias from the request path. */
  alias: string;
  /** Canonical resource URL of the request, as the token's `aud` must name it. */
  resource: string;
};

export class OrganizationBindingError extends Error {
  readonly code = "ORGANIZATION_RESOURCE_FORBIDDEN" as const;
  readonly status = 403 as const;
  /** Scopes the client should request to obtain a token for this resource. */
  readonly scopes: string[];
  /** Why, for the log only — never sent to the caller. */
  readonly reason: string;

  constructor(binding: OrganizationResourceBinding, reason: string) {
    super(organizationBindingRefusalMessage(binding));
    this.name = "OrganizationBindingError";
    this.reason = reason;
    this.scopes = organizationResourceScopes(binding.alias);
  }
}

export function organizationBindingRefusalMessage(
  binding: OrganizationResourceBinding,
): string {
  const scopes = organizationResourceScopes(binding.alias);
  return (
    `This token is not bound to the organization resource ${binding.resource}. ` +
    `Request a token for that resource with the scopes ${scopes.map((s) => `\`${s}\``).join(" and ")} ` +
    "(the caller must be a member of the organization)."
  );
}

function audienceList(aud: unknown): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Steps 1 and 2. Pure: no I/O, so every refusal shape is unit-testable.
 * Returns the Organization id to look up, or throws.
 */
export function selectBoundOrganization(
  identity: Pick<AuthIdentity, "organizations">,
  claims: { aud?: unknown },
  binding: OrganizationResourceBinding,
): { alias: string; id: string } {
  const membership = identity.organizations?.[binding.alias];
  if (!membership) {
    throw new OrganizationBindingError(
      binding,
      `token carries no membership of organization "${binding.alias}"`,
    );
  }
  if (typeof membership.id !== "string" || membership.id.length === 0) {
    throw new OrganizationBindingError(
      binding,
      `membership of "${binding.alias}" has no organization id (enable "add organization id" on the membership mapper)`,
    );
  }
  if (!audienceList(claims.aud).includes(binding.resource)) {
    throw new OrganizationBindingError(
      binding,
      `token audience does not name the resource ${binding.resource}`,
    );
  }
  return { alias: binding.alias, id: membership.id };
}

export type TenantForOrganization = (
  realm: string,
  organizationId: string,
) => Promise<string | null>;

/**
 * Steps 1–3 together. `tenantForOrganization` is the registry read
 * (`app.tenant_for_keycloak_organization`), injected so the composition is
 * testable without a database. Returns the tenant the session is pinned to.
 */
export async function bindOrganizationResource(
  identity: Pick<AuthIdentity, "organizations" | "tenantId">,
  claims: { aud?: unknown },
  binding: OrganizationResourceBinding,
  realm: string | undefined,
  tenantForOrganization: TenantForOrganization,
): Promise<{ tenantId: string; organizationId: string }> {
  const organization = selectBoundOrganization(identity, claims, binding);
  if (!realm) {
    throw new OrganizationBindingError(
      binding,
      "token issuer is not a Keycloak realm URL",
    );
  }
  const tenantId = await tenantForOrganization(realm, organization.id);
  if (!tenantId) {
    throw new OrganizationBindingError(
      binding,
      `no tenant is linked to organization "${binding.alias}" (${organization.id}) in realm "${realm}"`,
    );
  }
  // A realm that still mints `tid` must agree with the registry; two
  // authorities that disagree is a provisioning fault, not a choice to make.
  if (identity.tenantId && identity.tenantId !== tenantId) {
    throw new OrganizationBindingError(
      binding,
      `token tid ${identity.tenantId} disagrees with the tenant linked to organization "${binding.alias}"`,
    );
  }
  return { tenantId, organizationId: organization.id };
}
