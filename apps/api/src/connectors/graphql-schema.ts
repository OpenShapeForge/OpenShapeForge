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
import type { RuntimeModule } from "../modules/contract.js";
import {
  ConnectorAuthorizationError,
  requireConnectorAdmin,
  requireConnectorRead,
} from "./authorization.js";
import { listConnectorContracts, type ConnectorContract } from "./catalog.js";
import { connectorGovernor, connectorKeyring, connectorRegistry } from "./dispatch.js";
import {
  ConnectorInvocationError,
  invokeConnectorOperation,
  verifyConnectorInstallation,
} from "./runtime.js";
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
    "Whether the contract declares a connectivity check, so a surface knows to offer one."
    supportsVerify: Boolean!
    "Whether the contract declares OAuth, so a surface offers Connect rather than a credential field."
    usesOAuth: Boolean!
    "Whether a person must complete a consent screen. False for client credentials, which needs none."
    requiresAuthorization: Boolean!
    installations: [ConnectorInstallation!]!
  }

  input ConfigureConnectorInput {
    slug: ID!
    instanceKey: String
    displayName: String
    configuration: JSON!
  }

  type ConnectorVerifyResult {
    ok: Boolean!
    message: String
  }
`;

/**
 * Per-connector operation namespaces, generated from the compiled contracts.
 *
 * Namespaced so the root schema stays clean and a connector can never collide
 * with an entity query. Input and output are JSON scalars on purpose: the
 * authoritative shape is the generated JSON Schema the boundary enforces on
 * both sides of the call, and mirroring it into SDL would create a second
 * definition that must then be kept in agreement with the first.
 */
function namespaceTypeDefs(contracts: ConnectorContract[]): string {
  const blocks: string[] = [];
  for (const contract of contracts) {
    if (!contract.exposure.graphql) continue;
    const queries = contract.operations.filter((operation) => operation.kind === "query");
    const mutations = contract.operations.filter(
      (operation) => operation.kind === "mutation",
    );
    if (queries.length > 0) {
      blocks.push(
        `type ${contract.connector}Queries {\n` +
          queries.map((op) => `  ${op.key}(input: JSON): JSON`).join("\n") +
          "\n}",
      );
    }
    if (mutations.length > 0) {
      blocks.push(
        `type ${contract.connector}Mutations {\n` +
          mutations.map((op) => `  ${op.key}(input: JSON): JSON`).join("\n") +
          "\n}",
      );
    }
  }
  return blocks.join("\n\n");
}

function namespaceFields(
  contracts: ConnectorContract[],
  kind: "query" | "mutation",
): string {
  return contracts
    .filter(
      (contract) =>
        contract.exposure.graphql &&
        contract.operations.some((operation) => operation.kind === kind),
    )
    .map(
      (contract) =>
        `  ${contract.namespace}: ${contract.connector}${kind === "query" ? "Queries" : "Mutations"}!`,
    )
    .join("\n");
}

export const connectorNamespaceTypeDefs = namespaceTypeDefs(listConnectorContracts());
export const connectorNamespaceQueryFields = namespaceFields(
  listConnectorContracts(),
  "query",
);
export const connectorNamespaceMutationFields = namespaceFields(
  listConnectorContracts(),
  "mutation",
);

export const connectorQueryFields = `
  connectors: [Connector!]!
  connector(slug: ID!): Connector
`;

export const connectorMutationFields = `
  configureConnector(input: ConfigureConnectorInput!): ConnectorInstallation!
  setConnectorSecret(slug: ID!, instanceKey: String, field: String!, value: String!): Boolean!
  enableConnector(slug: ID!, instanceKey: String): Boolean!
  disableConnector(slug: ID!, instanceKey: String): Boolean!
  verifyConnector(slug: ID!, instanceKey: String): ConnectorVerifyResult!
`;

/**
 * Runtime configuration is injected rather than read from the environment here,
 * so tests exercise the real resolvers with a real license and keyring instead
 * of a mocked service.
 */
export type ConnectorGraphqlOptions = {
  config: ConnectorRuntimeConfig;
  egressOwner?: RuntimeModule["egress"] | undefined;
  /** Injectable for tests; production passes Date.now. */
  now?: () => number;
  /** Resolver-wiring seam; production uses the canonical runtime verifier. */
  verifyInstallation?: typeof verifyConnectorInstallation;
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
  if (error instanceof ConnectorInvocationError) {
    throw new GraphQLError(error.message, { extensions: { code: error.code } });
  }
  if (
    error instanceof Error &&
    (error.name === "ConnectorExecutionError" || error.name === "ConnectorBoundaryError")
  ) {
    throw new GraphQLError(error.message, {
      extensions: { code: (error as Error & { code: string }).code },
    });
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

  /** One resolver per connector operation, under its namespace type. */
  function namespaceResolvers(kind: "query" | "mutation") {
    const resolvers: Record<string, Record<string, unknown>> = {};
    for (const contract of listConnectorContracts()) {
      if (!contract.exposure.graphql) continue;
      const operations = contract.operations.filter((entry) => entry.kind === kind);
      if (operations.length === 0) continue;
      const typeName = `${contract.connector}${kind === "query" ? "Queries" : "Mutations"}`;
      resolvers[typeName] = Object.fromEntries(
        operations.map((operation) => [
          operation.key,
          async (_parent: unknown, args: { input?: unknown }, context: GraphqlContext) => {
            try {
              const catalog = catalogContext(context);
              return await invokeConnectorOperation(
                {
                  db: catalog.db,
                  session: catalog.session,
                  registry: await connectorRegistry(),
                  governor: connectorGovernor(),
                  keyring: connectorKeyring(),
                  roles: context.session.roles,
                  egressOwner: options.egressOwner,
                },
                contract,
                operation,
                args.input ?? {},
              );
            } catch (error) {
              return toServiceError(error);
            }
          },
        ]),
      );
    }
    return resolvers;
  }

  /** The namespace fields themselves resolve to an empty parent object. */
  function namespaceRootFields(kind: "query" | "mutation") {
    return Object.fromEntries(
      listConnectorContracts()
        .filter(
          (contract) =>
            contract.exposure.graphql &&
            contract.operations.some((operation) => operation.kind === kind),
        )
        .map((contract) => [contract.namespace, () => ({})]),
    );
  }

  return {
    ...namespaceResolvers("query"),
    ...namespaceResolvers("mutation"),
    Query: {
      ...namespaceRootFields("query"),
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
      ...namespaceRootFields("mutation"),
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
      setConnectorSecret: async (
        _parent: unknown,
        args: { slug: string; instanceKey?: string | null; field: string; value: string },
        context: GraphqlContext,
      ) => {
        try {
          requireConnectorAdmin(context.session);
          await configureConnector(catalogContext(context), {
            slug: args.slug,
            ...(args.instanceKey ? { instanceKey: args.instanceKey } : {}),
            // Only the one secret; every other field keeps its stored value.
            configuration: { [args.field]: args.value },
          });
          return true;
        } catch (error) {
          return toServiceError(error);
        }
      },
      verifyConnector: async (
        _parent: unknown,
        args: { slug: string; instanceKey?: string | null },
        context: GraphqlContext,
      ) => {
        try {
          requireConnectorAdmin(context.session);
          const catalog = catalogContext(context);
          const contract = catalog.contracts.find((entry) => entry.slug === args.slug);
          if (!contract) {
            throw new ConnectorServiceError(
              "CONNECTOR_NOT_FOUND",
              `Unknown connector "${args.slug}".`,
            );
          }
          return await (options.verifyInstallation ?? verifyConnectorInstallation)(
            {
              db: catalog.db,
              session: catalog.session,
              registry: await connectorRegistry(),
              governor: connectorGovernor(),
              keyring: connectorKeyring(),
              roles: context.session.roles,
              egressOwner: options.egressOwner,
              ...(args.instanceKey ? { instanceKey: args.instanceKey } : {}),
            },
            contract,
          );
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
