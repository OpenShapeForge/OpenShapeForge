// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { resolveSessionContext } from "../auth/identity.js";
import type { SessionScope } from "../auth/trusted-context.js";

export type GraphqlSessionContext = {
  tenantId: string | null;
  userId: string | null;
  roles: string[];
  /**
   * Keycloak group paths from the trusted-context bundle. Empty array when
   * the caller did not propagate group claims (e.g. legacy callers, bearer
   * tokens without the group-membership protocol mapper).
   */
  groups: string[];
  /**
   * Effective access scope resolved upstream (tenant/group/self). Threaded
   * through to the DB session layer as `DbSessionInput.scope`, which sets the
   * `app.scope` GUC — without this field `normalizeScope(undefined)` always
   * yielded "self" and `app.has_scope('tenant')` never fired (F5).
   * `SessionScope` and `DbSessionScope` are the same "tenant"|"group"|"self".
   */
  scope: SessionScope;
};

export type GraphqlContext = Record<string, unknown> & {
  session: GraphqlSessionContext;
  db?: OpenShapeForgeDatabase | undefined;
};

export type CreateGraphqlContextOptions = {
  db?: OpenShapeForgeDatabase | undefined;
};

export async function createGraphqlContext(
  headers: Headers,
  options: CreateGraphqlContextOptions = {},
): Promise<GraphqlContext> {
  const resolved = await resolveSessionContext(headers);
  const session: GraphqlSessionContext = {
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    roles: [...resolved.roles],
    groups: [...resolved.groups],
    scope: resolved.scope,
  };
  return {
    ...(options.db ? { db: options.db } : {}),
    session,
  };
}
