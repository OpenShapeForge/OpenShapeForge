// SPDX-License-Identifier: BUSL-1.1
import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * Carry only server-derived, request-fresh domain memberships into the live
 * session. They are intentionally excluded from the token-claim equality
 * tuple: membership revocation must take effect without forcing the MCP
 * transport to reinitialize.
 */
type RelationGroupRequestScope = {
  active: boolean;
  ids: readonly string[];
};

const freshRelationGroups = new AsyncLocalStorage<RelationGroupRequestScope>();
const NO_RELATION_GROUPS = Object.freeze([]) as readonly string[];

/**
 * One stable session object for the lifetime of an MCP transport. Its domain
 * memberships are a request-scoped getter, so two concurrent requests cannot
 * overwrite each other's authority by mutating a shared captured session.
 */
export function createStatefulMcpSessionContext(
  established: TrustedSessionContext,
): TrustedSessionContext {
  const stateful = { ...established };
  Object.defineProperty(stateful, "relationGroupIds", {
    enumerable: true,
    configurable: false,
    // Outside an actively authenticated transport request there is no domain
    // group authority. In particular, callbacks cannot retain the initializer's
    // memberships after a later revocation.
    get: () => {
      const request = freshRelationGroups.getStore();
      return request?.active ? request.ids : NO_RELATION_GROUPS;
    },
  });
  return stateful;
}

/** Run one transport request with its freshly resolved domain memberships. */
export async function withFreshRelationGroupMemberships<T>(
  current: TrustedSessionContext,
  work: () => Promise<T> | T,
): Promise<T> {
  const request = {
    active: true,
    ids: Object.freeze([...(current.relationGroupIds ?? [])]),
  };
  return freshRelationGroups.run(request, async () => {
    try {
      return await work();
    } finally {
      // Async resources created by `work` retain their ALS store. Marking the
      // store inactive ensures an undrained callback cannot keep stale group
      // authority after the authenticated HTTP request has settled.
      request.active = false;
    }
  });
}
