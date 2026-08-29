// SPDX-License-Identifier: BUSL-1.1
/**
 * GraphQL surface for API key provisioning.
 *
 * A mirror of the REST surface, not a second implementation: every field here
 * calls the same `service.ts` functions, so the privilege ceiling and the
 * tenant containment are enforced once. The reason it exists at all is that
 * `apps/web` talks to the API over GraphQL only — adding a REST client for one
 * screen would give the web app two ways to reach the same backend.
 *
 * `grantableApiKeyRoles` has no REST counterpart. It exists for the create
 * form's role picker, which needs to show something. It is a convenience, NOT
 * a control: the ceiling re-derives the caller's roles server-side on every
 * mutation, so a client that ignores this list gains nothing.
 */
import { GraphQLError } from "graphql";
import type { GraphqlContext } from "../../graphql/context.js";
import {
  API_KEY_MANAGE_ROLE,
  ApiKeyAuthorizationError,
  assertMayManageApiKeys,
} from "./ceiling.js";
import type { ApiKeyProvisioningConfig } from "./runtime-config.js";
import {
  ApiKeyNotFoundError,
  ApiKeyProvisioningError,
  createIntegration,
  disableIntegration,
  issueKey,
  listKeys,
  revokeKey,
  type ApiKeyServiceDeps,
  type ProvisioningSession,
} from "./service.js";
import { ApiKeyRolePolicyError } from "./role-subset.js";

export const apiKeyTypeDefs = /* GraphQL */ `
  """
  One provisioned credential. The secret itself is returned exactly once, by
  the mutation that mints it, and is never readable again.
  """
  type ApiKey {
    id: ID!
    integrationId: ID!
    """The external party this key belongs to."""
    integrationName: String!
    displayName: String!
    """
    Null means the key carries whatever its integration's service account
    holds. A non-null list is intersected with those roles, never unioned.
    """
    roleSubset: [String!]
    createdAt: String!
    expiresAt: String
    revokedAt: String
    """Null until the key is used for the first time."""
    lastUsedAt: String
  }

  """The credential, returned once at creation. Store it now or lose it."""
  type MintedApiKey {
    integrationId: ID!
    keyId: ID!
    token: String!
    expiresAt: String
  }

  input CreateApiKeyIntegrationInput {
    displayName: String!
    """Roles for the integration's service account. Bounded by the caller's own roles."""
    roles: [String!]!
    """Omit for the default lifetime; null for a key that never expires."""
    expiresInDays: Int
    roleSubset: [String!]
  }

  input IssueApiKeyInput {
    integrationId: ID!
    displayName: String!
    expiresInDays: Int
    roleSubset: [String!]
  }
`;

export const apiKeyQueryFields = /* GraphQL */ `
    """Every key in the caller's tenant. Requires ${API_KEY_MANAGE_ROLE}."""
    apiKeys: [ApiKey!]!
    """
    Roles the caller may grant to a key — their own, minus the management role
    itself. For populating a picker; the ceiling is enforced server-side.
    """
    grantableApiKeyRoles: [String!]!
`;

export const apiKeyMutationFields = /* GraphQL */ `
    """Create an external party's integration and its first key."""
    createApiKeyIntegration(input: CreateApiKeyIntegrationInput!): MintedApiKey!
    """Issue an additional key against an existing integration — the rotation primitive."""
    issueApiKey(input: IssueApiKeyInput!): MintedApiKey!
    """Revoke one key. Idempotent; the row is kept as evidence."""
    revokeApiKey(keyId: ID!): Boolean!
    """Disable an integration and revoke every key under it."""
    disableApiKeyIntegration(integrationId: ID!): Boolean!
`;

function toGraphqlError(error: unknown): GraphQLError {
  if (error instanceof ApiKeyAuthorizationError) {
    return new GraphQLError(error.message, {
      extensions: { code: "FORBIDDEN", status: 403 },
    });
  }
  if (error instanceof ApiKeyNotFoundError) {
    return new GraphQLError(error.message, {
      extensions: { code: "NOT_FOUND", status: 404 },
    });
  }
  if (error instanceof ApiKeyProvisioningError) {
    return new GraphQLError(error.message, {
      extensions: { code: "API_KEY_PROVISIONING_FAILED", status: 502 },
    });
  }
  if (error instanceof ApiKeyRolePolicyError) {
    return new GraphQLError(error.message, {
      extensions: { code: error.code, status: error.status },
    });
  }
  throw error;
}

/**
 * The session shape the service takes, carrying `credential` through untouched
 * — the ceiling reads it to refuse an api-key session, so dropping it here
 * would silently disable that control.
 */
function sessionFrom(context: GraphqlContext): ProvisioningSession {
  const session = context.session;
  if (!session.tenantId || !session.userId) {
    throw new GraphQLError("Authentication is required to manage API keys.", {
      extensions: { code: "UNAUTHENTICATED", status: 401 },
    });
  }
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    roles: session.roles,
    groups: session.groups,
    credential: session.credential,
  };
}

export type ApiKeyGraphqlOptions = {
  config?: ApiKeyProvisioningConfig | undefined;
};

/**
 * Build the resolvers. When provisioning is not configured the fields stay in
 * the schema and fail with a clear message rather than vanishing: a schema that
 * changed shape per deployment would break the web client's queries depending
 * on which environment it hit.
 */
export function createApiKeyResolvers(options: ApiKeyGraphqlOptions = {}) {
  function deps(context: GraphqlContext): ApiKeyServiceDeps {
    if (!options.config || !context.db) {
      throw new GraphQLError(
        "API key provisioning is not configured on this deployment.",
        { extensions: { code: "NOT_CONFIGURED", status: 503 } },
      );
    }
    return {
      db: context.db,
      keyring: options.config.keyring,
      admin: options.config.admin,
      entityRoleClientId: options.config.entityRoleClientId,
    };
  }

  return {
    Query: {
      apiKeys: async (_parent: unknown, _args: unknown, context: GraphqlContext) => {
        try {
          const keys = await listKeys(deps(context), sessionFrom(context));
          return keys.map((key) => ({
            ...key,
            createdAt: key.createdAt.toISOString(),
            expiresAt: key.expiresAt?.toISOString() ?? null,
            revokedAt: key.revokedAt?.toISOString() ?? null,
            lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
          }));
        } catch (error) {
          throw toGraphqlError(error);
        }
      },

      grantableApiKeyRoles: (
        _parent: unknown,
        _args: unknown,
        context: GraphqlContext,
      ) => {
        const session = sessionFrom(context);
        try {
          assertMayManageApiKeys(session);
        } catch (error) {
          throw toGraphqlError(error);
        }
        // The management role is excluded: granting it to a key would be
        // inert (a key is refused key management anyway) while reading, to
        // whoever configures the integration, as though it were not.
        return [...session.roles].filter((role) => role !== API_KEY_MANAGE_ROLE).sort();
      },
    },

    Mutation: {
      createApiKeyIntegration: async (
        _parent: unknown,
        args: {
          input: {
            displayName: string;
            roles: string[];
            expiresInDays?: number | null;
            roleSubset?: string[] | null;
          };
        },
        context: GraphqlContext,
      ) => {
        try {
          const created = await createIntegration(deps(context), sessionFrom(context), {
            displayName: args.input.displayName,
            roles: args.input.roles,
            ...(args.input.expiresInDays === undefined
              ? {}
              : { expiresInDays: args.input.expiresInDays }),
            ...(args.input.roleSubset === undefined
              ? {}
              : { roleSubset: args.input.roleSubset }),
          });
          return { ...created, expiresAt: created.expiresAt?.toISOString() ?? null };
        } catch (error) {
          throw toGraphqlError(error);
        }
      },

      issueApiKey: async (
        _parent: unknown,
        args: {
          input: {
            integrationId: string;
            displayName: string;
            expiresInDays?: number | null;
            roleSubset?: string[] | null;
          };
        },
        context: GraphqlContext,
      ) => {
        try {
          const created = await issueKey(deps(context), sessionFrom(context), {
            integrationId: args.input.integrationId,
            displayName: args.input.displayName,
            ...(args.input.expiresInDays === undefined
              ? {}
              : { expiresInDays: args.input.expiresInDays }),
            ...(args.input.roleSubset === undefined
              ? {}
              : { roleSubset: args.input.roleSubset }),
          });
          return { ...created, expiresAt: created.expiresAt?.toISOString() ?? null };
        } catch (error) {
          throw toGraphqlError(error);
        }
      },

      revokeApiKey: async (
        _parent: unknown,
        args: { keyId: string },
        context: GraphqlContext,
      ) => {
        try {
          await revokeKey(deps(context), sessionFrom(context), args.keyId);
          return true;
        } catch (error) {
          throw toGraphqlError(error);
        }
      },

      disableApiKeyIntegration: async (
        _parent: unknown,
        args: { integrationId: string },
        context: GraphqlContext,
      ) => {
        try {
          await disableIntegration(deps(context), sessionFrom(context), args.integrationId);
          return true;
        } catch (error) {
          throw toGraphqlError(error);
        }
      },
    },
  };
}
