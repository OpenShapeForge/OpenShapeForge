// SPDX-License-Identifier: BUSL-1.1
import { costLimitPlugin } from "@escape.tech/graphql-armor-cost-limit";
import { maxAliasesPlugin } from "@escape.tech/graphql-armor-max-aliases";
import { maxDepthPlugin } from "@escape.tech/graphql-armor-max-depth";
import { maxDirectivesPlugin } from "@escape.tech/graphql-armor-max-directives";
import { maxTokensPlugin } from "@escape.tech/graphql-armor-max-tokens";
import { usePersistedOperations } from "@graphql-yoga/plugin-persisted-operations";
import {
  createMaskedErrorOptions,
  createYogaCorsConfiguration,
  createYogaMetricsPlugin,
  type GraphqlCorsPolicy,
} from "@openshapeforge/observability/yoga";
import type { Registry, SanitizedErrorReport } from "@openshapeforge/observability";
import { NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga, type Plugin } from "graphql-yoga";
import { readPositiveIntEnv } from "../config/limits.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { createGraphqlContext, type GraphqlContext } from "./context.js";
import type { RuntimeModule } from "../modules/contract.js";
import { buildGraphqlSchema } from "./schema.js";
import persistedManifest from "../generated/graphql/persisted-operations.json" with { type: "json" };
import type { TrustedSessionContext } from "../auth/trusted-context.js";

/**
 * Rejects schema introspection (__schema / __type) during validation.
 *
 * graphql-yoga enables introspection by default, and the /api/graphql route is
 * reachable unauthenticated, so without this an anonymous caller can read the
 * full schema — every generated entity type, filter/sort input, and mutation —
 * even though GraphiQL is disabled in production (issue #16). We only install
 * this in production so local development keeps introspection (and GraphiQL,
 * which depends on it) working.
 */
const disableIntrospectionPlugin: Plugin = {
  onValidate({ addValidationRule }) {
    addValidationRule(NoSchemaIntrospectionCustomRule);
  },
};

export type CreateGraphqlYogaOptions = {
  cors: GraphqlCorsPolicy;
  db?: OpenShapeForgeDatabase | undefined;
  /**
   * Runtime modules whose GraphQL surfaces join the schema. Resolved at boot by
   * `modules/registry.ts`; omitted by callers that only need the core surface.
   */
  modules?: readonly RuntimeModule[] | undefined;
  metricsRegistry?: Registry;
  reportUnexpectedError?: (report: SanitizedErrorReport) => void;
  /** Host-selected generated manifest; injectable for rolling-deployment contract tests. */
  persistedOperations?: PersistedOperationManifest;
};

export type PersistedOperationManifest = {
  operationNames: string[];
  operations: Record<string, string>;
};

const persistedOperations = persistedManifest as PersistedOperationManifest;

export type GraphqlYogaServerContext = Record<string, unknown> & {
  verifiedSession?: TrustedSessionContext;
};

const DEFAULT_GRAPHIQL_QUERY = /* GraphQL */ `
  # OpenShapeForge local development
  # This health query needs no credentials. For protected operations, add an
  # Authorization: Bearer <local access token> header in GraphiQL's Headers
  # panel. Never paste a production token or trusted-context secret here.
  query OsfHealth {
    health {
      status
      role
    }
  }
`;

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
/**
 * Depth, aliases and cost are all measured AFTER parsing. A query can be
 * expensive before it ever gets that far: a megabyte of tokens, or thousands of
 * repeated directives, is work the parser does regardless of how trivial the
 * resulting document turns out to be (#161). These two cap the document itself.
 *
 * 1000 tokens is far above any query this CRUD surface produces — the widest
 * generated entity selection with its relationships is an order of magnitude
 * below it — and far below what a flooding attempt needs to be interesting.
 * Directives: the schema defines none beyond the built-ins, so 50 is generous.
 */
const DEFAULT_MAX_TOKENS = 1000;
const DEFAULT_MAX_DIRECTIVES = 50;

export function createGraphqlYoga(options: CreateGraphqlYogaOptions) {
  const operationManifest = options.persistedOperations ?? persistedOperations;
  const maxDepth = readPositiveIntEnv("GRAPHQL_MAX_DEPTH", DEFAULT_MAX_DEPTH);
  const maxAliases = readPositiveIntEnv(
    "GRAPHQL_MAX_ALIASES",
    DEFAULT_MAX_ALIASES,
  );
  const maxCost = readPositiveIntEnv("GRAPHQL_MAX_COST", DEFAULT_MAX_COST);
  const maxTokens = readPositiveIntEnv("GRAPHQL_MAX_TOKENS", DEFAULT_MAX_TOKENS);
  const maxDirectives = readPositiveIntEnv(
    "GRAPHQL_MAX_DIRECTIVES",
    DEFAULT_MAX_DIRECTIVES,
  );
  const isProduction = process.env.NODE_ENV === "production";

  return createYoga<GraphqlYogaServerContext, GraphqlContext>({
    schema: buildGraphqlSchema(options.modules ?? [], { db: options.db }),
    graphqlEndpoint: "/api/graphql",
    cors: createYogaCorsConfiguration(options.cors),
    landingPage: false,
    graphiql: isProduction ? false : { defaultQuery: DEFAULT_GRAPHIQL_QUERY },
    // Yoga otherwise logs the original exception after masking it. Central
    // reporting below deliberately sees only the redacted category/type tuple.
    logging: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    maskedErrors: createMaskedErrorOptions({
      report: options.reportUnexpectedError ?? (() => undefined),
    }),
    plugins: [
      usePersistedOperations({
        getPersistedOperation: (key) => operationManifest.operations[key] ?? null,
        // Arbitrary documents are a development or authenticated-integration
        // profile selected by the Fastify host after it verifies identity.
        allowArbitraryOperations: (request) =>
          request.headers.get("x-openshapeforge-arbitrary-profile") === "development" ||
          request.headers.get("x-openshapeforge-arbitrary-profile") === "authenticated",
      }),
      createYogaMetricsPlugin({
        metricPrefix: "openshapeforge",
        allowedOperationNames: new Set(operationManifest.operationNames),
        ...(options.metricsRegistry ? { registry: options.metricsRegistry } : {}),
      }),
      // Cheapest first: token and directive counts reject a flooding document
      // before depth/alias/cost analysis walks it.
      maxTokensPlugin({ n: maxTokens }),
      maxDirectivesPlugin({ n: maxDirectives }),
      maxDepthPlugin({ n: maxDepth, ignoreIntrospection: true }),
      maxAliasesPlugin({ n: maxAliases }),
      costLimitPlugin({ maxCost, ignoreIntrospection: true }),
      ...(isProduction ? [disableIntrospectionPlugin] : []),
    ],
    context: async ({ request, verifiedSession }) => createGraphqlContext(
      request.headers,
      { ...options, resolvedSession: verifiedSession },
    ),
  });
}
