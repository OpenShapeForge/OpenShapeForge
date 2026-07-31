// SPDX-License-Identifier: BUSL-1.1
/**
 * Minimal GraphQL schema for the generated-entity CRUD runtime.
 *
 * Composes the compiler-driven generated entity types/resolvers with a JSON
 * scalar and a Health query. The full apps/api service carries a much larger
 * schema (workflow, messaging, erp workspace, identity, realtime); those
 * domains are intentionally absent here.
 */
import { GraphQLError, Kind, type ValueNode } from "graphql";
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

    """
    Presentation configuration for one entity's generated CRUD pages. Global
    compiler output, identical for every tenant — layout, not data.
    """
    type EntityPageConfigs {
      listConfigs: JSON
      detailConfigs: JSON
      workspaceConfigs: JSON
      createFormConfigBases: JSON
      editFormConfigBases: JSON
    }

    type Query {
      health: Health!
      entityPageConfigs(entitySlug: String!): EntityPageConfigs
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
      entityPageConfigs: resolveEntityPageConfigs,
    },
    Mutation: {
      ...generatedEntityResolvers.Mutation,
      ...connectorResolvers.Mutation,
    },
  },
});

/**
 * `config_kind` as stored by the seeder -> the field the renderer asks for.
 * The stored spelling is the compiler's; the GraphQL spelling is the web
 * client's, and the two were never the same.
 */
const PAGE_CONFIG_FIELD_BY_KIND: Record<string, string> = {
  list: "listConfigs",
  detail: "detailConfigs",
  workspace: "workspaceConfigs",
  create_form: "createFormConfigBases",
  edit_form: "editFormConfigBases",
};

/**
 * Presentation config for one entity's generated pages.
 *
 * Authenticated but not role-gated: this is compiler output describing how to
 * lay out a page, identical for every tenant, and the renderer needs it before
 * it knows whether the user may read any rows. What the user can actually see
 * is decided by the entity queries, which are role- and RLS-enforced. Returns
 * null for an unknown slug so the caller can 404 rather than render an empty
 * page.
 */
async function resolveEntityPageConfigs(
  _parent: unknown,
  args: { entitySlug: string },
  context: GraphqlContext,
) {
  if (!context.session?.tenantId || !context.session?.userId) {
    throw new GraphQLError("Entity page configs require an authenticated session.", {
      extensions: { code: "UNAUTHENTICATED", status: 401 },
    });
  }
  if (!context.db) {
    throw new GraphQLError("Database is not configured for entity page configs.", {
      extensions: { code: "DATABASE_NOT_CONFIGURED", status: 503 },
    });
  }

  const rows = await context.db
    .selectFrom("platform.entity_page_configs")
    .select(["config_kind", "configs"])
    .where("entity_slug", "=", args.entitySlug)
    .execute();

  if (rows.length === 0) return null;

  const result: Record<string, unknown> = {
    listConfigs: null,
    detailConfigs: null,
    workspaceConfigs: null,
    createFormConfigBases: null,
    editFormConfigBases: null,
  };
  for (const row of rows) {
    const field = PAGE_CONFIG_FIELD_BY_KIND[row.config_kind];
    if (field) result[field] = row.configs;
  }
  return result;
}

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
