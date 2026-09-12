// SPDX-License-Identifier: BUSL-1.1
import type { TrustedSessionContext } from "../auth/trusted-context.js";

export type StatefulMcpAuthorization = Pick<
  TrustedSessionContext,
  | "tenantId"
  | "userId"
  | "roles"
  | "oauthScopes"
  | "groups"
  | "scope"
  | "credential"
  | "loginSessionBinding"
>;

function sameClaims(left: readonly string[] = [], right: readonly string[] = []): boolean {
  const sortedLeft = [...new Set(left)].sort();
  const sortedRight = [...new Set(right)].sort();
  if (sortedLeft.length !== sortedRight.length) return false;
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

/**
 * A stateful MCP session may survive access-token renewal, but not a change of
 * login session or effective authorization. Both absent login bindings retain
 * compatibility for API-key and trusted-context sessions.
 */
export function sameStatefulMcpAuthorization(
  established: StatefulMcpAuthorization,
  current: StatefulMcpAuthorization,
): boolean {
  return (
    established.tenantId === current.tenantId &&
    established.userId === current.userId &&
    sameClaims(established.roles, current.roles) &&
    sameClaims(established.oauthScopes, current.oauthScopes) &&
    sameClaims(established.groups, current.groups) &&
    established.scope === current.scope &&
    established.credential === current.credential &&
    established.loginSessionBinding === current.loginSessionBinding
  );
}
