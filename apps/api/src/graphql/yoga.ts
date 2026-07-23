import { createYoga } from "graphql-yoga";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { createGraphqlContext, type GraphqlContext } from "./context.js";
import { graphqlSchema } from "./schema.js";

export type CreateGraphqlYogaOptions = {
  db?: OpenShapeForgeDatabase | undefined;
};

export function createGraphqlYoga(options: CreateGraphqlYogaOptions = {}) {
  return createYoga<Record<string, unknown>, GraphqlContext>({
    schema: graphqlSchema,
    graphqlEndpoint: "/api/graphql",
    landingPage: false,
    graphiql: process.env.NODE_ENV !== "production",
    context: async ({ request }) => createGraphqlContext(request.headers, options),
  });
}
