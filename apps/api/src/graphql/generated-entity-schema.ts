// SPDX-License-Identifier: BUSL-1.1
import {
  GraphQLError,
  Kind,
  type GraphQLResolveInfo,
  type SelectionSetNode,
} from "graphql";
import graphqlDocumentation from "../generated/graphql/documentation.json" with { type: "json" };
import {
  getGeneratedCrudTables,
  getGeneratedEntity,
  createGeneratedEntity,
  deleteGeneratedEntity,
  isWritableColumn,
  listGeneratedEntities,
  listGeneratedEntityRelation,
  updateGeneratedEntity,
  type GeneratedCrudRelationship,
} from "./generated-crud.js";
// Field-level redaction and the classified filter/sort guard are NOT applied
// here: they live in the generated CRUD core, which every read below goes
// through, so REST and future transports are covered by the same code (#164).
import { assertOperationAllowed } from "./generated-authz.js";
import type { GraphqlContext } from "./context.js";

type GeneratedTable = ReturnType<typeof getGeneratedCrudTables>[number];

type GraphqlMetadata = NonNullable<NonNullable<GeneratedTable["source"]>["graphql"]>;

export type GraphqlEntityDocumentation = {
  typeName: string;
  description?: string;
  fields: Array<{
    name: string;
    description?: string;
    substringFilterDescription?: string;
  }>;
};

export type GraphqlDocumentationCatalog = {
  entities: GraphqlEntityDocumentation[];
};

export function createGraphqlDocumentationIndex(
  catalog: GraphqlDocumentationCatalog,
): ReadonlyMap<string, GraphqlEntityDocumentation> {
  return new Map(catalog.entities.map((entity) => [entity.typeName, entity]));
}

const tables = getGeneratedCrudTables().filter((table) => table.source?.graphql);
const tablesByGraphqlType = new Map(
  tables.map((table) => [table.source!.graphql!.typeName, table]),
);
const documentationByGraphqlType = createGraphqlDocumentationIndex(
  graphqlDocumentation as GraphqlDocumentationCatalog,
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

/**
 * `!` for columns the API guarantees a value for.
 *
 * A data-classified column is deliberately NOT one of them, however the column
 * is authored (#168). Field-level redaction nulls a classified column for a
 * reader without a write grant, so `required: true` plus a restricting
 * classification describes a field the runtime may legitimately answer with
 * `null`. Rendering it `String!` made the two rules incompatible: redaction
 * produced a non-null execution error that propagated up and nulled the whole
 * selection — a list query lost every row rather than one field. The column
 * stays NOT NULL in Postgres and required on create; only the read contract
 * admits the null that redaction produces.
 */
export function nonNullSuffix(column: GeneratedTable["columns"][number]) {
  if (column.classification) {
    return "";
  }
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

function renderDescription(description: string | undefined, indent: string): string {
  return description ? `${indent}${JSON.stringify(description)}\n` : "";
}

function appendDescription(
  description: string | undefined,
  addition: string,
): string {
  return description ? `${description} ${addition}` : addition;
}

/**
 * Exported for tests: the shipped manifest declares no classified column, so
 * the nullability rule above (#168) has nothing to act on in
 * `generatedEntityTypeDefs` and asserting against it would be vacuous. Calling
 * this with a synthetic table exercises the real rendering path.
 */
export function renderTypeDefinition(
  table: GeneratedTable,
  documentationIndex: ReadonlyMap<string, GraphqlEntityDocumentation> =
    documentationByGraphqlType,
) {
  const graphql = assertGraphqlMetadata(table);
  const documentation = documentationIndex.get(graphql.typeName);
  const fieldDocumentation = new Map(
    (documentation?.fields ?? []).map((field) => [field.name, field]),
  );
  const columnFields = table.columns
    .map((column) => {
      const field = fieldNameForColumn(column);
      return `${renderDescription(fieldDocumentation.get(field)?.description, "      ")}` +
        `      ${field}: ${graphqlScalarForColumn(column)}${nonNullSuffix(column)}`;
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
  // Create and update inputs are rendered from the CRUD layer's own
  // writability predicate, per operation: a column authored `immutable` is
  // offered on create and absent from the update input, so a mutation naming it
  // fails GraphQL validation rather than being silently dropped (#177).
  const creatableColumns = table.columns.filter((column) =>
    isWritableColumn(column, "create"),
  );
  const updatableColumns = table.columns.filter((column) =>
    isWritableColumn(column, "update"),
  );
  const createInputBody = creatableColumns.length === 0
    ? "      _empty: String"
    : creatableColumns
        .map((column) => {
          const field = fieldNameForColumn(column);
          return `${renderDescription(fieldDocumentation.get(field)?.description, "      ")}` +
            `      ${field}: ${graphqlScalarForColumn(column)}`;
        })
        .join("\n");
  const updateInputBody = [
    "      id: ID!",
    ...updatableColumns.map((column) => {
      const field = fieldNameForColumn(column);
      return `${renderDescription(fieldDocumentation.get(field)?.description, "      ")}` +
        `      ${field}: ${graphqlScalarForColumn(column)}`;
    }),
  ].join("\n");

  return `
${renderDescription(documentation?.description, "    ")}
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
    const directMatch = column.type === "text"
      ? "Matches a case-insensitive substring."
      : "Matches exactly.";
    const fieldDocumentationEntry = fieldDocumentation.get(field);
    const directDescription = column.type === "text"
      ? fieldDocumentationEntry?.substringFilterDescription
      : fieldDocumentationEntry?.description;
    return `${renderDescription(
      appendDescription(directDescription, directMatch),
      "      ",
    )}      ${field}: ${scalar}\n` +
      `${renderDescription(
        appendDescription(
          fieldDocumentationEntry?.description,
          "Matches exactly against any supplied value.",
        ),
        "      ",
      )}      ${field}In: [${scalar}!]`;
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

${tables.map((table) => renderTypeDefinition(table)).join("\n")}
`;

export function renderQueryFields(
  table: GeneratedTable,
  documentationIndex: ReadonlyMap<string, GraphqlEntityDocumentation> =
    documentationByGraphqlType,
): string {
  const graphql = assertGraphqlMetadata(table);
  const documentation = documentationIndex.get(graphql.typeName);
  return [
    `${renderDescription(
      appendDescription(documentation?.description, "Fetches one record by id."),
      "      ",
    )}      ${graphql.singleQueryName}(id: ID!): ${graphql.typeName}`,
    `${renderDescription(
      appendDescription(documentation?.description, "Returns a page of records."),
      "      ",
    )}      ${graphql.listQueryName}(filter: ${graphql.typeName}Filter, sort: ${graphql.typeName}Sort, first: Int, after: String): ${graphql.typeName}Connection!`,
  ].join("\n");
}

export const generatedEntityQueryFields = tables
  .map((table) => renderQueryFields(table))
  .join("\n");

export function renderMutationFields(
  table: GeneratedTable,
  documentationIndex: ReadonlyMap<string, GraphqlEntityDocumentation> =
    documentationByGraphqlType,
): string {
  const graphql = assertGraphqlMetadata(table);
  const documentation = documentationIndex.get(graphql.typeName);
  return [
    `${renderDescription(
      appendDescription(documentation?.description, "Creates a record."),
      "      ",
    )}      ${graphql.createMutationName}(input: Create${graphql.typeName}Input!): ${graphql.typeName}`,
    `${renderDescription(
      appendDescription(documentation?.description, "Partially updates a record."),
      "      ",
    )}      ${graphql.updateMutationName}(input: Update${graphql.typeName}Input!): ${graphql.typeName}`,
    `${renderDescription(
      appendDescription(documentation?.description, "Deletes a record by id."),
      "      ",
    )}      ${graphql.deleteMutationName}(id: ID!): Boolean!`,
  ].join("\n");
}

export const generatedEntityMutationFields = tables
  .map((table) => renderMutationFields(table))
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
    // Null only when the client did not select it, in which case nothing reads
    // it. `totalCount: Int` is nullable in the schema, so this is well-formed.
    totalCount,
  };
}

/**
 * Whether the client selected `name` on the field being resolved.
 *
 * Drives the opt-in count (#17): a list query that does not ask for
 * `totalCount` must not pay for the count pass. Walks the selection set the
 * same way execution will — inline fragments and named fragment spreads
 * included, since `... on FooConnection { totalCount }` selects the field just
 * as plainly as naming it. Aliases need no handling: an alias renames the
 * response key, not the field.
 *
 * Wrong in the safe direction if it ever missed a spelling: the count comes
 * back null and the client sees no value, rather than the server quietly
 * skipping authorization or returning stale data.
 */
function selectionIncludes(info: GraphQLResolveInfo, name: string): boolean {
  const seenFragments = new Set<string>();

  const walk = (selectionSet: SelectionSetNode | undefined): boolean => {
    if (!selectionSet) return false;
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        if (selection.name.value === name) return true;
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (walk(selection.selectionSet)) return true;
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragmentName = selection.name.value;
        // Fragment cycles are invalid GraphQL, but a guard costs nothing and
        // turns a malformed document into a false rather than a stack overflow.
        if (seenFragments.has(fragmentName)) continue;
        seenFragments.add(fragmentName);
        if (walk(info.fragments[fragmentName]?.selectionSet)) return true;
      }
    }
    return false;
  };

  return info.fieldNodes.some((node) => walk(node.selectionSet));
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
          assertOperationAllowed(authorization, context.session, "read", graphql.typeName);
          const result = await listGeneratedEntities(db, context.session, {
            table: table.name,
            ...(args.first === undefined ? {} : { limit: args.first }),
            ...(args.after === undefined ? {} : { cursor: args.after }),
            ...(args.filter === undefined ? {} : { filter: args.filter }),
            ...(args.sort === undefined ? {} : { sort: args.sort }),
            // The count is the expensive half of a list read (#17). Ask for it
            // only when the client selected the field it feeds.
            ...(selectionIncludes(info, "totalCount") ? { includeTotalCount: true as const } : {}),
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
              return relationship.resolve === "belongsTo"
                ? result.rows[0] ?? null
                : result.rows;
            },
          ],
          [
            `${relationship.name}Aggregate`,
            async (parent: Record<string, unknown>, _args: unknown, context: GraphqlContext) => {
              const db = requireGeneratedDb(context);
              assertOperationAllowed(targetAuthorization, context.session, "read", relationship.target);
              // The count IS this field, so it is always computed here.
              const result = await listGeneratedEntityRelation(db, context.session, {
                parent,
                parentTable: table,
                relationship,
                targetTable,
                limit: 1,
                includeTotalCount: true,
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
