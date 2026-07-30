// SPDX-License-Identifier: BUSL-1.1
/**
 * Minimal GraphQL schema for the generated-entity CRUD runtime.
 *
 * Composes the compiler-driven generated entity types/resolvers with a JSON
 * scalar and a Health query. The full apps/api service carries a much larger
 * schema (workflow, messaging, erp workspace, identity, realtime); those
 * domains are intentionally absent here.
 */
import { Kind, type ValueNode } from "graphql";
import { createSchema } from "graphql-yoga";
import {
  generatedEntityMutationFields,
  generatedEntityQueryFields,
  generatedEntityResolvers,
  generatedEntityTypeDefs,
} from "./generated-entity-schema.js";
import {
  connectorMutationFields,
  connectorNamespaceMutationFields,
  connectorNamespaceQueryFields,
  connectorNamespaceTypeDefs,
  connectorQueryFields,
  connectorTypeDefs,
  createConnectorResolvers,
} from "../connectors/graphql-schema.js";
import { readConnectorRuntimeConfig } from "../connectors/runtime-config.js";
import type { GraphqlContext } from "./context.js";

// The connector catalog types are static — identical across deployments — so a
// connector this deployment is not licensed for is a row with
// status: NOT_LICENSED rather than a hole in the schema.
const connectorResolvers = createConnectorResolvers({
  config: readConnectorRuntimeConfig(),
});

export const graphqlSchema = createSchema<GraphqlContext>({
  typeDefs: /* GraphQL */ `
    scalar JSON

    ${generatedEntityTypeDefs}

    ${connectorTypeDefs}

    ${connectorNamespaceTypeDefs}

    type Health {
      status: String!
      role: String!
    }

    type Query {
      health: Health!
${generatedEntityQueryFields}
${connectorQueryFields}
${connectorNamespaceQueryFields}
    }

    type Mutation {
${generatedEntityMutationFields}
${connectorMutationFields}
${connectorNamespaceMutationFields}
    }
  `,
  resolvers: {
    JSON: {
      serialize: (value: unknown) => value,
      parseValue: (value: unknown) => value,
      parseLiteral: parseJsonLiteral,
    },
    ...objectResolvers(),
    ...connectorObjectResolvers(),
    Query: {
      ...generatedEntityResolvers.Query,
      ...connectorResolvers.Query,
      health: () => ({
        status: "ok",
        role: "api",
      }),
    },
    Mutation: {
      ...generatedEntityResolvers.Mutation,
      ...connectorResolvers.Mutation,
    },
  },
});

/** Connector namespace types (ObjectStoreQueries, …), keyed by type name. */
function connectorObjectResolvers() {
  const { Query: _query, Mutation: _mutation, ...namespaces } = connectorResolvers;
  return namespaces;
}

function objectResolvers() {
  const { Query: _query, Mutation: _mutation, ...objects } = generatedEntityResolvers;
  return objects;
}

function parseJsonLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map((value) => parseJsonLiteral(value));
    case Kind.OBJECT:
      return Object.fromEntries(
        ast.fields.map((field) => [
          field.name.value,
          parseJsonLiteral(field.value),
        ]),
      );
    default:
      return null;
  }
}
