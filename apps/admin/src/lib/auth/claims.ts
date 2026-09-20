// SPDX-License-Identifier: BUSL-1.1
import { parseAuthorizationRoles, type JwtClaims } from "@openshapeforge/auth/session";

/**
 * The one role that means "may use the control plane".
 *
 * Authored in `packages/compiler/config/authoring/authorization.control.yaml`
 * as the control realm's only realm role. It carries no composites: the
 * authority to actually change anything lives on the far side of a server-side
 * call, not in this token. Holding it is permission to open the console.
 */
export const PLATFORM_OPERATOR_ROLE = "platform-operator";

/**
 * The authorization decision, in one place.
 *
 * apps/web's equivalent (`hasApplicationTenantContext`) tests for a tenant
 * context. Here it is a single role, and the difference is deliberate: the
 * control plane has exactly one kind of user. Finer distinctions extend this
 * function, not each call site.
 */
export function hasPlatformOperatorRole(roles: readonly string[]): boolean {
  return roles.includes(PLATFORM_OPERATOR_ROLE);
}

/**
 * A refresh that comes back without `platform-operator` means the role was
 * revoked while the operator was signed in, and the session must die rather
 * than coast on the roles captured at login. Control-realm tokens carry no
 * `tid`, so this is the invariant that means here what the tenant check
 * means in apps/web.
 */
export function operatorRefreshInvariant(accessClaims: JwtClaims): string | undefined {
  return hasPlatformOperatorRole(parseAuthorizationRoles(accessClaims))
    ? undefined
    : "refreshed token no longer carries the operator role";
}
