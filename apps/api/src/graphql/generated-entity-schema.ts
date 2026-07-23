import { GraphQLError, type GraphQLResolveInfo } from "graphql";
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

/**
 * Whether the client selected `fieldName` directly on the resolved field.
 * Used to make `totalCount` opt-in so a page fetch does not always run a
 * second count(*) scan (issue #17). Only inspects the immediate selection set
 * (fragments spread at this level are followed); if `info` is unavailable we
 * conservatively report the field as unselected.
 */
function isFieldSelected(info: GraphQLResolveInfo | undefined, fieldName: string): boolean {
  if (!info) return false;
  for (const node of info.fieldNodes) {
    const selections = node.selectionSet?.selections ?? [];
    for (const selection of selections) {
      if (selection.kind === "Field" && selection.name.value === fieldName) {
        return true;
      }
      if (selection.kind === "InlineFragment") {
        for (const inner of selection.selectionSet?.selections ?? []) {
          if (inner.kind === "Field" && inner.name.value === fieldName) return true;
        }
      }
      if (selection.kind === "FragmentSpread") {
        const fragment = info.fragments[selection.name.value];
        for (const inner of fragment?.selectionSet.selections ?? []) {
          if (inner.kind === "Field" && inner.name.value === fieldName) return true;
        }
      }
    }
  }
  return false;
}

function toConnection(
  rows: Record<string, unknown>[],
  nextCursor: string | null,
  totalCount: number | null,
) {
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
    return [
      [
        graphql.singleQueryName,
        async (_parent: unknown, args: { id: string }, context: GraphqlContext) => {
          const db = requireGeneratedDb(context);
          return getGeneratedEntity(db, context.session, {
            table: table.name,
            id: args.id,
          });
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
          info: GraphQLResolveInfo,
        ) => {
          const db = requireGeneratedDb(context);
          const includeTotal = isFieldSelected(info, "totalCount");
          const result = await listGeneratedEntities(db, context.session, {
            table: table.name,
            includeTotal,
            ...(args.first === undefined ? {} : { limit: args.first }),
            ...(args.after === undefined ? {} : { cursor: args.after }),
            ...(args.filter === undefined ? {} : { filter: args.filter }),
            ...(args.sort === undefined ? {} : { sort: args.sort }),
          });
          return toConnection(result.rows, result.nextCursor, result.totalCount);
        },
      ],
    ];
  }),
);

const mutationResolvers = Object.fromEntries(
  tables.flatMap((table) => {
    const graphql = assertGraphqlMetadata(table);
    return [
      [
        graphql.createMutationName,
        async (_parent: unknown, args: { input: Record<string, unknown> }, context: GraphqlContext) => {
          const db = requireGeneratedDb(context);
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
        return [
          [
            relationship.name,
            async (parent: Record<string, unknown>, _args: unknown, context: GraphqlContext) => {
              const db = requireGeneratedDb(context);
              const result = await listGeneratedEntityRelation(db, context.session, {
                parent,
                relationship,
                targetTable,
              });
              return relationship.resolve === "belongsTo" ? result.rows[0] ?? null : result.rows;
            },
          ],
          [
            `${relationship.name}Aggregate`,
            async (parent: Record<string, unknown>, _args: unknown, context: GraphqlContext) => {
              const db = requireGeneratedDb(context);
              const result = await listGeneratedEntityRelation(db, context.session, {
                parent,
                relationship,
                targetTable,
                limit: 1,
                includeTotal: true,
              });
              return { count: result.totalCount ?? 0 };
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
