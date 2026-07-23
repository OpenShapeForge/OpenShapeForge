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
import type { GraphqlContext } from "./context.js";

export const graphqlSchema = createSchema<GraphqlContext>({
  typeDefs: /* GraphQL */ `
    scalar JSON

    ${generatedEntityTypeDefs}

    type Health {
      status: String!
      role: String!
    }

    type Query {
      health: Health!
${generatedEntityQueryFields}
    }

    type Mutation {
${generatedEntityMutationFields}
    }
  `,
  resolvers: {
    JSON: {
      serialize: (value: unknown) => value,
      parseValue: (value: unknown) => value,
      parseLiteral: parseJsonLiteral,
    },
    ...objectResolvers(),
    Query: {
      ...generatedEntityResolvers.Query,
      health: () => ({
        status: "ok",
        role: "api",
      }),
    },
    Mutation: {
      ...generatedEntityResolvers.Mutation,
    },
  },
});

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
