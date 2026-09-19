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
 * Carry only server-derived, request-fresh state into the live session: the
 * domain memberships, and the identity ↔ Relation link (which Relation the
 * person acts as, and their roles here — auth/identity-link.ts). Both are
 * intentionally excluded from the token-claim equality tuple: a membership
 * revocation or an administrator re-linking the person must take effect on
 * the next request without forcing the MCP transport to reinitialize. A link
 * snapshot taken at initialize would outlive exactly those changes.
 */
type RequestScope = {
  active: boolean;
  ids: readonly string[];
  relation: TrustedSessionContext["relation"];
};

const freshRequestScope = new AsyncLocalStorage<RequestScope>();
const NO_RELATION_GROUPS = Object.freeze([]) as readonly string[];

/**
 * One stable session object for the lifetime of an MCP transport. Its domain
 * memberships and its Relation link are request-scoped accessors, so two
 * concurrent requests cannot overwrite each other's authority by mutating a
 * shared captured session.
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
      const request = freshRequestScope.getStore();
      return request?.active ? request.ids : NO_RELATION_GROUPS;
    },
  });
  Object.defineProperty(stateful, "relation", {
    enumerable: true,
    configurable: false,
    get: () => {
      const request = freshRequestScope.getStore();
      return request?.active ? request.relation : null;
    },
    // The identity-link tools update the session's link after confirm_my_link
    // and link_identity so the rest of THAT request sees it; the next request
    // resolves it afresh from the row (the cache entry was invalidated).
    set: (value: TrustedSessionContext["relation"]) => {
      const request = freshRequestScope.getStore();
      if (request?.active) request.relation = value;
    },
  });
  return stateful;
}

/** Run one transport request with its freshly resolved memberships and link. */
export async function withFreshRelationGroupMemberships<T>(
  current: TrustedSessionContext,
  work: () => Promise<T> | T,
): Promise<T> {
  const request: RequestScope = {
    active: true,
    ids: Object.freeze([...(current.relationGroupIds ?? [])]),
    relation: current.relation ?? null,
  };
  return freshRequestScope.run(request, async () => {
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
