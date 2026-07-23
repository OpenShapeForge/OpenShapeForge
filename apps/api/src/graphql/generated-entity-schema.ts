// SPDX-License-Identifier: BUSL-1.1
import { GraphQLError } from "graphql";
import {
  getGeneratedCrudTables,
  getGeneratedEntity,
  createGeneratedEntity,
  deleteGeneratedEntity,
  listGeneratedEntities,
  listGeneratedEntityRelation,
  updateGeneratedEntity,
  type GeneratedCrudRelationship,
} from "./generated-crud.js";
import {
  assertOperationAllowed,
  redactRow,
} from "./generated-authz.js";
import type { GraphqlContext } from "./context.js";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

type GraphqlMetadata = NonNullable<NonNullable<GeneratedTable["source"]>["graphql"]>;

const tables = getGeneratedCrudTables().filter((table) => table.source?.graphql);
const tablesByGraphqlType = new Map(
  tables.map((table) => [table.source!.graphql!.typeName, table]),
);

function assertGraphqlMetadata(table: GeneratedTable): GraphqlMetadata {
  const graphql = table.source?.graphql;
  if (!graphql) {
    throw new Error(`Generated table ${table.name} is missing GraphQL metadata.`);
  }
  return graphql;
}

function graphqlScalarForColumn(column: GeneratedTable["columns"][number]) {
  switch (column.type) {
    case "boolean":
      return "Boolean";
    case "integer":
      return "Int";
    case "bigint":
    case "numeric":
      return "Float";
    case "uuid":
      return "ID";
    case "jsonb":
      return "JSON";
    case "date":
    case "timestamptz":
    case "text":
    default:
      return "String";
  }
}

function fieldNameForColumn(column: GeneratedTable["columns"][number]) {
  return column.sourceField ?? column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function nonNullSuffix(column: GeneratedTable["columns"][number]) {
  return column.required || column.primaryKey ? "!" : "";
}

function isValidGraphqlName(value: string) {
  return /^[_A-Za-z][_0-9A-Za-z]*$/.test(value);
}

function relationFieldType(relationship: GeneratedCrudRelationship) {
  return relationship.resolve === "hasMany"
    ? `[${relationship.target}!]!`
    : relationship.target;
}

function isMutableColumn(column: GeneratedTable["columns"][number]) {
  return (
    !column.primaryKey &&
    column.generated !== "identity" &&
    column.name !== "tenant_id" &&
    column.name !== "created_at" &&
    column.name !== "updated_at"
  );
}

function renderTypeDefinition(table: GeneratedTable) {
  const graphql = assertGraphqlMetadata(table);
  const columnFields = table.columns
    .map((column) => {
      const field = fieldNameForColumn(column);
      return `      ${field}: ${graphqlScalarForColumn(column)}${nonNullSuffix(column)}`;
    });
  const relationshipFields = (graphql.relationships ?? [])
    .filter((relationship) =>
      isValidGraphqlName(relationship.name) &&
      tablesByGraphqlType.has(relationship.target)
    )
    .flatMap((relationship) => [
      `      ${relationship.name}: ${relationFieldType(relationship)}`,
      `      ${relationship.name}Aggregate: AggregateResult!`,
    ]);
  const mutableColumns = table.columns.filter(isMutableColumn);
  const createInputBody = mutableColumns.length === 0
    ? "      _empty: String"
    : mutableColumns
        .map((column) => `      ${fieldNameForColumn(column)}: ${graphqlScalarForColumn(column)}`)
        .join("\n");
  const updateInputBody = [
    "      id: ID!",
    ...mutableColumns.map(
      (column) => `      ${fieldNameForColumn(column)}: ${graphqlScalarForColumn(column)}`,
    ),
  ].join("\n");

  return `
    type ${graphql.typeName} {
${[...columnFields, ...relationshipFields].join("\n")}
    }

    type ${graphql.typeName}Edge {
      node: ${graphql.typeName}
      cursor: String
    }

    type ${graphql.typeName}Connection {
      edges: [${graphql.typeName}Edge!]!
      pageInfo: PageInfo!
      totalCount: Int
    }

    input ${graphql.typeName}Filter {
${table.columns
  .map((column) => {
    const field = fieldNameForColumn(column);
    const scalar = graphqlScalarForColumn(column);
    return `      ${field}: ${scalar}\n      ${field}In: [${scalar}!]`;
  })
  .join("\n")}
    }

    input ${graphql.typeName}Sort {
      field: String
      direction: String
    }

    input Create${graphql.typeName}Input {
${createInputBody}
    }

    input Update${graphql.typeName}Input {
${updateInputBody}
    }
  `;
}

export const generatedEntityTypeDefs = /* GraphQL */ `
  type PageInfo {
    hasNextPage: Boolean
    endCursor: String
  }

  type AggregateResult {
    count: Int!
  }

${tables.map(renderTypeDefinition).join("\n")}
`;

export const generatedEntityQueryFields = tables
  .map((table) => {
    const graphql = assertGraphqlMetadata(table);
    return [
      `      ${graphql.singleQueryName}(id: ID!): ${graphql.typeName}`,
      `      ${graphql.listQueryName}(filter: ${graphql.typeName}Filter, sort: ${graphql.typeName}Sort, first: Int, after: String): ${graphql.typeName}Connection!`,
    ].join("\n");
  })
  .join("\n");

export const generatedEntityMutationFields = tables
  .map((table) => {
    const graphql = assertGraphqlMetadata(table);
    return [
      `      ${graphql.createMutationName}(input: Create${graphql.typeName}Input!): ${graphql.typeName}`,
      `      ${graphql.updateMutationName}(input: Update${graphql.typeName}Input!): ${graphql.typeName}`,
      `      ${graphql.deleteMutationName}(id: ID!): Boolean!`,
    ].join("\n");
  })
  .join("\n");

function requireGeneratedDb(context: GraphqlContext) {
  if (!context.session?.tenantId || !context.session?.userId) {
    throw new GraphQLError("Generated entity access requires an authenticated session.", {
      extensions: { code: "UNAUTHENTICATED", status: 401 },
    });
  }
  if (!context.db) {
    throw new GraphQLError("Database is not configured for generated entity access.", {
      extensions: { code: "DATABASE_NOT_CONFIGURED", status: 503 },
    });
  }
  return context.db;
}

function toConnection(rows: Record<string, unknown>[], nextCursor: string | null, totalCount: number) {
  return {
    edges: rows.map((row, index) => ({
      node: row,
      cursor: Buffer.from(String(index + 1), "utf8").toString("base64url"),
    })),
    pageInfo: {
      hasNextPage: nextCursor !== null,
      endCursor: nextCursor,
    },
    totalCount,
  };
}

const queryResolvers = Object.fromEntries(
  tables.flatMap((table) => {
    const graphql = assertGraphqlMetadata(table);
    const authorization = table.source?.authorization;
    return [
      [
        graphql.singleQueryName,
        async (_parent: unknown, args: { id: string }, context: GraphqlContext) => {
          const db = requireGeneratedDb(context);
          assertOperationAllowed(authorization, context.session, "read", graphql.typeName);
          const row = await getGeneratedEntity(db, context.session, {
            table: table.name,
            id: args.id,
          });
          return row
            ? redactRow(row, table.columns, authorization, context.session)
            : row;
        },
      ],
      [
        graphql.listQueryName,
        async (
          _parent: unknown,
          args: {
            filter?: Record<string, unknown> | null;
            sort?: { field?: string | null; direction?: string | null } | null;
            first?: number | null;
            after?: string | null;
          },
          context: GraphqlContext,
        ) => {
          const db = requireGeneratedDb(context);
          assertOperationAllowed(authorization, context.session, "read", graphql.typeName);
          const result = await listGeneratedEntities(db, context.session, {
            table: table.name,
            ...(args.first === undefined ? {} : { limit: args.first }),
            ...(args.after === undefined ? {} : { cursor: args.after }),
            ...(args.filter === undefined ? {} : { filter: args.filter }),
            ...(args.sort === undefined ? {} : { sort: args.sort }),
          });
          const rows = result.rows.map((row) =>
            redactRow(row, table.columns, authorization, context.session),
          );
          return toConnection(rows, result.nextCursor, result.totalCount);
        },
      ],
    ];
  }),
);

const mutationResolvers = Object.fromEntries(
  tables.flatMap((table) => {
    const graphql = assertGraphqlMetadata(table);
    const authorization = table.source?.authorization;
    return [
      [
        graphql.createMutationName,
        async (_parent: unknown, args: { input: Record<string, unknown> }, context: GraphqlContext) => {
          const db = requireGeneratedDb(context);
          assertOperationAllowed(authorization, context.session, "create", graphql.typeName);
          return createGeneratedEntity(db, context.session, {
            table: table.name,
            values: args.input,
          });
        },
      ],
      [
        graphql.updateMutationName,
        async (_parent: unknown, args: { input: Record<string, unknown> & { id: string } }, context: GraphqlContext) => {
          const db = requireGeneratedDb(context);
          assertOperationAllowed(authorization, context.session, "update", graphql.typeName);
          return updateGeneratedEntity(db, context.session, {
            table: table.name,
            id: args.input.id,
            values: args.input,
          });
        },
      ],
      [
        graphql.deleteMutationName,
        async (_parent: unknown, args: { id: string }, context: GraphqlContext) => {
          const db = requireGeneratedDb(context);
          assertOperationAllowed(authorization, context.session, "delete", graphql.typeName);
          return deleteGeneratedEntity(db, context.session, {
            table: table.name,
            id: args.id,
          });
        },
      ],
    ];
  }),
);

const objectResolvers = Object.fromEntries(
  tables.map((table) => {
    const graphql = assertGraphqlMetadata(table);
    const fields = Object.fromEntries(
      table.columns.map((column) => [
        fieldNameForColumn(column),
        (parent: Record<string, unknown>) => parent[column.name],
      ]),
    );
    const relationships = Object.fromEntries(
      (graphql.relationships ?? []).flatMap((relationship) => {
        const targetTable = tablesByGraphqlType.get(relationship.target);
        if (!targetTable) {
          return [];
        }
        const targetAuthorization = targetTable.source?.authorization;
        return [
          [
            relationship.name,
            async (parent: Record<string, unknown>, _args: unknown, context: GraphqlContext) => {
              const db = requireGeneratedDb(context);
              // Reading the related entity requires read authorization on the
              // TARGET entity (#94): a caller with no read grant on the target
              // cannot pull its rows through a relationship edge.
              assertOperationAllowed(targetAuthorization, context.session, "read", relationship.target);
              const result = await listGeneratedEntityRelation(db, context.session, {
                parent,
                parentTable: table,
                relationship,
                targetTable,
              });
              const rows = result.rows.map((row) =>
                redactRow(row, targetTable.columns, targetAuthorization, context.session),
              );
              return relationship.resolve === "belongsTo" ? rows[0] ?? null : rows;
            },
          ],
          [
            `${relationship.name}Aggregate`,
            async (parent: Record<string, unknown>, _args: unknown, context: GraphqlContext) => {
              const db = requireGeneratedDb(context);
              assertOperationAllowed(targetAuthorization, context.session, "read", relationship.target);
              const result = await listGeneratedEntityRelation(db, context.session, {
                parent,
                parentTable: table,
                relationship,
                targetTable,
                limit: 1,
              });
              return { count: result.totalCount };
            },
          ],
        ];
      }),
    );
    return [graphql.typeName, { ...fields, ...relationships }];
  }),
);

export const generatedEntityResolvers = {
  Query: queryResolvers,
  Mutation: mutationResolvers,
  ...objectResolvers,
};
