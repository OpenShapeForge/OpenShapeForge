// SPDX-License-Identifier: BUSL-1.1
/**
 * GraphQL surface for the connector catalog and configuration.
 *
 * The catalog types are STATIC — they describe connectors, they are not
 * generated per connector. That keeps the schema identical across deployments
 * regardless of which connectors are compiled or licensed, so a locked
 * connector is a row with `status: NOT_LICENSED` rather than a missing field.
 * (Per-connector operation namespaces are a later stage and are generated.)
 *
 * `configFields` is deliberately a JSON scalar: it is the compiled field
 * contract, rendered by a generic configuration form. Mirroring the whole field
 * vocabulary into SDL would freeze it into two places that must then agree.
 */
import { GraphQLError } from "graphql";
import type { GraphqlContext } from "../graphql/context.js";
import {
  ConnectorAuthorizationError,
  requireConnectorAdmin,
  requireConnectorRead,
} from "./authorization.js";
import { listConnectorContracts } from "./catalog.js";
import {
  configureConnector,
  describeConnector,
  listConnectors,
  setConnectorEnabled,
  ConnectorServiceError,
  type CatalogContext,
  type ConnectorRuntimeConfig,
} from "./service.js";

export const connectorTypeDefs = /* GraphQL */ `
  enum ConnectorStatus {
    AVAILABLE
    NOT_LICENSED
    NOT_INSTALLED
    NOT_CONFIGURED
    DISABLED
  }

  enum ConnectorProvenance {
    firstParty
    reviewed
    thirdParty
  }

  enum ConnectorContractState {
    CURRENT
    CONTRACT_CHANGED
    NEEDS_REPAIR
    INCOMPATIBLE
  }

  type ConnectorLicense {
    spdx: String!
    url: String
    notice: String
  }

  type ConnectorContractHealth {
    state: ConnectorContractState!
    missingRequiredFields: [String!]!
    removedFields: [String!]!
    reason: String
    requiresReverification: Boolean!
  }

  type ConnectorInstallation {
    instanceKey: String!
    displayName: String
    enabled: Boolean!
    "Secret values are never returned; a set secret appears as __set__."
    configuration: JSON!
    contract: ConnectorContractHealth!
  }

  type Connector {
    slug: ID!
    name: String!
    title: String!
    category: String
    license: ConnectorLicense!
    provenance: ConnectorProvenance!
    requiredEntitlement: String
    status: ConnectorStatus!
    "Compiled configuration field contract; the configuration form renders from this."
    configFields: JSON!
    instances: String!
    installations: [ConnectorInstallation!]!
  }

  input ConfigureConnectorInput {
    slug: ID!
    instanceKey: String
    displayName: String
    configuration: JSON!
  }
`;

export const connectorQueryFields = `
  connectors: [Connector!]!
  connector(slug: ID!): Connector
`;

export const connectorMutationFields = `
  configureConnector(input: ConfigureConnectorInput!): ConnectorInstallation!
  enableConnector(slug: ID!, instanceKey: String): Boolean!
  disableConnector(slug: ID!, instanceKey: String): Boolean!
`;

/**
 * Runtime configuration is injected rather than read from the environment here,
 * so tests exercise the real resolvers with a real license and keyring instead
 * of a mocked service.
 */
export type ConnectorGraphqlOptions = {
  config: ConnectorRuntimeConfig;
  /** Injectable for tests; production passes Date.now. */
  now?: () => number;
};

/**
 * Coded errors must be GraphQLError instances: yoga masks anything else as
 * INTERNAL_SERVER_ERROR, which would swallow both the code and the reason and
 * leave every connector refusal indistinguishable from a crash. Mirrors how the
 * generated CRUD resolvers raise FORBIDDEN.
 */
function toServiceError(error: unknown): never {
  if (error instanceof ConnectorAuthorizationError) {
    throw new GraphQLError(error.message, { extensions: { code: error.code } });
  }
  if (error instanceof ConnectorServiceError) {
    throw new GraphQLError(error.message, { extensions: { code: error.code } });
  }
  if (error instanceof Error && error.name === "ConnectorConfigurationError") {
    throw new GraphQLError(error.message, {
      extensions: { code: "CONNECTOR_INVALID_CONFIGURATION" },
    });
  }
  throw error;
}

export function createConnectorResolvers(options: ConnectorGraphqlOptions) {
  const now = options.now ?? (() => Date.now());

  function catalogContext(context: GraphqlContext): CatalogContext {
    if (!context.db) {
      throw new GraphQLError("Database is not configured.", {
        extensions: { code: "DATABASE_NOT_CONFIGURED" },
      });
    }
    return {
      db: context.db,
      session: {
        tenantId: context.session.tenantId ?? "",
        userId: context.session.userId ?? "",
        roles: context.session.roles,
        groups: context.session.groups,
        scope: context.session.scope,
      },
      config: options.config,
      now: now(),
      contracts: listConnectorContracts(),
    };
  }

  return {
    Query: {
      connectors: async (_parent: unknown, _args: unknown, context: GraphqlContext) => {
        try {
          requireConnectorRead(context.session);
          return await listConnectors(catalogContext(context));
        } catch (error) {
          return toServiceError(error);
        }
      },
      connector: async (
        _parent: unknown,
        args: { slug: string },
        context: GraphqlContext,
      ) => {
        try {
          requireConnectorRead(context.session);
          return (await describeConnector(catalogContext(context), args.slug)) ?? null;
        } catch (error) {
          return toServiceError(error);
        }
      },
    },
    Mutation: {
      configureConnector: async (
        _parent: unknown,
        args: {
          input: {
            slug: string;
            instanceKey?: string | null;
            displayName?: string | null;
            configuration: unknown;
          };
        },
        context: GraphqlContext,
      ) => {
        try {
          requireConnectorAdmin(context.session);
          return await configureConnector(catalogContext(context), {
            slug: args.input.slug,
            ...(args.input.instanceKey ? { instanceKey: args.input.instanceKey } : {}),
            ...(args.input.displayName !== undefined
              ? { displayName: args.input.displayName }
              : {}),
            configuration: args.input.configuration,
          });
        } catch (error) {
          return toServiceError(error);
        }
      },
      enableConnector: async (
        _parent: unknown,
        args: { slug: string; instanceKey?: string | null },
        context: GraphqlContext,
      ) => {
        try {
          requireConnectorAdmin(context.session);
          return await setConnectorEnabled(
            catalogContext(context),
            args.slug,
            args.instanceKey ?? "default",
            true,
          );
        } catch (error) {
          return toServiceError(error);
        }
      },
      disableConnector: async (
        _parent: unknown,
        args: { slug: string; instanceKey?: string | null },
        context: GraphqlContext,
      ) => {
        try {
          requireConnectorAdmin(context.session);
          return await setConnectorEnabled(
            catalogContext(context),
            args.slug,
            args.instanceKey ?? "default",
            false,
          );
        } catch (error) {
          return toServiceError(error);
        }
      },
    },
  };
}
