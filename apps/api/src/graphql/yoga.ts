// SPDX-License-Identifier: BUSL-1.1
import { costLimitPlugin } from "@escape.tech/graphql-armor-cost-limit";
import { maxAliasesPlugin } from "@escape.tech/graphql-armor-max-aliases";
import { maxDepthPlugin } from "@escape.tech/graphql-armor-max-depth";
import { createYoga } from "graphql-yoga";
import { readPositiveIntEnv } from "../config/limits.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { createGraphqlContext, type GraphqlContext } from "./context.js";
import { graphqlSchema } from "./schema.js";

export type CreateGraphqlYogaOptions = {
  db?: OpenShapeForgeDatabase | undefined;
};

/**
 * Conservative production defaults for GraphQL query hardening.
 *
 * The generated relationship resolvers resolve each belongsTo/hasMany field
 * with its own DB round-trip, and relationships can be cyclic (order ->
 * customer -> orders -> ...). Without a server-side cap a single authenticated
 * request can nest these fields arbitrarily deep and multiply the fan-out with
 * field aliases, producing exponential query/connection load (issue #8). These
 * guards reject such queries during validation, before any resolver runs.
 *
 * Each limit is overridable via env so operators can tune per deployment; the
 * defaults are intentionally strict and suit the CRUD surface here.
 */
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ALIASES = 15;
const DEFAULT_MAX_COST = 5000;

export function createGraphqlYoga(options: CreateGraphqlYogaOptions = {}) {
  const maxDepth = readPositiveIntEnv("GRAPHQL_MAX_DEPTH", DEFAULT_MAX_DEPTH);
  const maxAliases = readPositiveIntEnv(
    "GRAPHQL_MAX_ALIASES",
    DEFAULT_MAX_ALIASES,
  );
  const maxCost = readPositiveIntEnv("GRAPHQL_MAX_COST", DEFAULT_MAX_COST);

  return createYoga<Record<string, unknown>, GraphqlContext>({
    schema: graphqlSchema,
    graphqlEndpoint: "/api/graphql",
    landingPage: false,
    graphiql: process.env.NODE_ENV !== "production",
    plugins: [
      maxDepthPlugin({ n: maxDepth, ignoreIntrospection: true }),
      maxAliasesPlugin({ n: maxAliases }),
      costLimitPlugin({ maxCost, ignoreIntrospection: true }),
    ],
    context: async ({ request }) => createGraphqlContext(request.headers, options),
  });
}
