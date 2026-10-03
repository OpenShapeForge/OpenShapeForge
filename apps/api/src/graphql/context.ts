// SPDX-License-Identifier: BUSL-1.1
import { GraphQLError } from "graphql";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { resolveSessionContext } from "../auth/identity.js";
import { HttpError } from "../rest/http-error.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";

/**
 * The session a GraphQL resolver sees: the resolved session itself, arrays
 * copied, so a field the resolver establishes (the credential, the scope,
 * the acting Relation, the issuer) reaches every resolver as REST and MCP
 * see it.
 */
export type GraphqlSessionContext = TrustedSessionContext;

export type GraphqlContext = Record<string, unknown> & {
  session: GraphqlSessionContext;
  db?: OpenShapeForgeDatabase | undefined;
};

export type CreateGraphqlContextOptions = {
  db?: OpenShapeForgeDatabase | undefined;
  /** Host-verified identity avoids repeating API-key or bearer verification. */
  resolvedSession?: TrustedSessionContext | undefined;
};

export async function createGraphqlContext(
  headers: Headers,
  options: CreateGraphqlContextOptions = {},
): Promise<GraphqlContext> {
  const resolved = options.resolvedSession ??
    await resolveSessionContext(headers, { db: options.db }).catch((error: unknown) => {
      // A refusal or an unavailability the resolver already classified (403
      // NOT_INVITED, 403 ORGANIZATION_RESOURCE_FORBIDDEN, 503
      // AUTHENTICATION_UNAVAILABLE) is an answer, not an internal fault:
      // carried as an expected GraphQL error rather than masked.
      if (error instanceof HttpError) {
        throw new GraphQLError(error.message, {
          extensions: { code: error.code, status: error.status, http: { status: error.status } },
        });
      }
      throw error;
    });
  // The whole resolved session, arrays copied: what the resolver established
  // — the credential, the scope, the acting Relation — reaches every resolver
  // as REST and MCP see it, so no field can go missing here the way `scope`
  // once did.
  const session: GraphqlSessionContext = {
    ...resolved,
    roles: [...resolved.roles],
    oauthScopes: [...(resolved.oauthScopes ?? [])],
    groups: [...resolved.groups],
    relationGroupIds: [...(resolved.relationGroupIds ?? [])],
  };
  return {
    ...(options.db ? { db: options.db } : {}),
    session,
  };
}
