// SPDX-License-Identifier: BUSL-1.1
/**
 * Generated entity SDL and resolvers.
 *
 * Authored descriptions are intentionally present in the schema used by local
 * GraphiQL and other development/schema tooling. Production currently blocks
 * introspection in yoga.ts, so deployed anonymous clients cannot retrieve
 * them; keeping one schema in every environment avoids runtime schema drift.
 */
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
  isElicitedOutputColumn,
  isGeneratedCrudOperationEnabled,
  createGeneratedEntity,
  deleteGeneratedEntity,
  isCallerWritableColumn,
  isOperationWrittenColumn,
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
import { collectionMutationError } from "../operations/entity/collection-policy.js";
import { projectGraphqlOperation } from "./operation-error.js";
import {
  entityOperationContract,
  entityOperationRef,
  executeEntityOperation,
} from "../operations/entity/index.js";
import type {
  EntityOperationInput,
  GeneratedCrudExposureOperation,
} from "../operations/entity/types.js";

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

export function createGraphqlDocumentationIndex(
  catalog: unknown,
): ReadonlyMap<string, GraphqlEntityDocumentation> {
  if (!catalog || typeof catalog !== "object" ||
      !Array.isArray((catalog as { entities?: unknown }).entities)) {
    throw new Error("Generated GraphQL documentation must contain an entities array.");
  }
  const entities = (catalog as { entities: unknown[] }).entities;
  for (const entity of entities) {
    const candidate = entity as Partial<GraphqlEntityDocumentation> | null;
    if (!candidate || typeof candidate !== "object" ||
        typeof candidate.typeName !== "string" ||
        (candidate.description !== undefined && typeof candidate.description !== "string") ||
        !Array.isArray(candidate.fields) ||
        candidate.fields.some((field) =>
          !field || typeof field !== "object" ||
          typeof field.name !== "string" ||
          (field.description !== undefined && typeof field.description !== "string") ||
          (field.substringFilterDescription !== undefined &&
            typeof field.substringFilterDescription !== "string")
        )) {
      throw new Error("Generated GraphQL documentation contains an invalid entity entry.");
    }
  }
  return new Map(
    (entities as GraphqlEntityDocumentation[]).map((entity) => [entity.typeName, entity]),
  );
}

const tables = getGeneratedCrudTables().filter((table) => table.source?.graphql);
const tablesByGraphqlType = new Map(
  tables.map((table) => [table.source!.graphql!.typeName, table]),
);
const documentationByGraphqlType = createGraphqlDocumentationIndex(
  graphqlDocumentation,
);

type CrudOperation = "list" | "get" | "create" | "update" | "delete";

function operationEnabled(table: GeneratedTable, operation: CrudOperation): boolean {
  if (operation === "create" && collectionMutationError(table, "create", getGeneratedCrudTables()) &&
    entityOperationContract(entityOperationRef(table, "create").id).implementation?.type !== "plugin") return false;
  return table.source?.graphql?.operations?.[operation] !== false &&
    isGeneratedCrudOperationEnabled(table, operation);
}

export function usesCanonicalGraphqlOperations(table: GeneratedTable): boolean {
  return (table.source?.authoringVersion ?? 1) >= 2;
}

function projectedOperationIntents(table: GeneratedTable): GeneratedCrudExposureOperation[] {
  const operations = table.source?.graphql?.operations ?? {} as Partial<
    Record<GeneratedCrudExposureOperation, boolean>
  >;
  return (["list", "get", "create", "update", "delete"] as const)
    .filter((intent) => operations[intent] !== false && operationEnabled(table, intent));
}

function operationControlFields(
  table: GeneratedTable,
  intent: "create" | "update" | "delete",
): string[] {
  if (!usesCanonicalGraphqlOperations(table) || !operationEnabled(table, intent)) return [];
  const operation = entityOperationContract(entityOperationRef(table, intent).id);
  return [
    ...(intent === "create" && table.source?.blueprint ? ["      blueprintId: String"] : []),
    ...(operation.concurrency?.version ? ["      expectedVersion: String!"] : []),
    ...(operation.concurrency?.editLease ? ["      leaseToken: String!"] : []),
    ...(operation.interaction.confirmation.mode === "acknowledgement"
      ? ["      confirmed: Boolean!"]
      : []),
    ...(operation.interaction.confirmation.mode === "challenge"
      ? ["      confirmationToken: String", "      confirmationAnswer: String"]
      : []),
  ];
}

function canonicalRecordResultType(graphql: GraphqlMetadata): string {
  return `${graphql.typeName}OperationResult`;
}

function mutationInputType(table: GeneratedTable, intent: "create" | "update"): string {
  const graphql = assertGraphqlMetadata(table);
  if (usesCanonicalGraphqlOperations(table) && entityOperationContract(entityOperationRef(table, intent).id).implementation?.type === "plugin") return "JSON";
  return `${intent === "create" ? "Create" : "Update"}${graphql.typeName}Input`;
}

function canonicalCollectionResultType(graphql: GraphqlMetadata): string {
  return `${graphql.typeName}CollectionOperationResult`;
}

function canonicalDeleteResultType(graphql: GraphqlMetadata): string {
  return `${graphql.typeName}DeleteOperationResult`;
}

export function renderGeneratedQueryFields(table: GeneratedTable): string[] {
  const graphql = assertGraphqlMetadata(table);
  const canonical = usesCanonicalGraphqlOperations(table);
  return [
    ...(operationEnabled(table, "get")
      ? [`      ${graphql.singleQueryName}(id: ID!): ${canonical ? canonicalRecordResultType(graphql) : graphql.typeName}`]
      : []),
    ...(operationEnabled(table, "list")
      ? [`      ${graphql.listQueryName}(filter: ${graphql.typeName}Filter, sort: ${graphql.typeName}Sort, first: Int, after: String): ${canonical ? canonicalCollectionResultType(graphql) : `${graphql.typeName}Connection!`}`]
      : []),
  ];
}

export function renderGeneratedMutationFields(table: GeneratedTable): string[] {
  const graphql = assertGraphqlMetadata(table);
  const canonical = usesCanonicalGraphqlOperations(table);
  return [
    ...(operationEnabled(table, "create")
      ? [`      ${graphql.createMutationName}(input: ${mutationInputType(table, "create")}!): ${canonical ? canonicalRecordResultType(graphql) : graphql.typeName}`]
      : []),
    ...(operationEnabled(table, "update")
      ? [`      ${graphql.updateMutationName}(input: ${mutationInputType(table, "update")}!): ${canonical ? canonicalRecordResultType(graphql) : graphql.typeName}`]
      : []),
    ...(operationEnabled(table, "delete")
      ? [canonical
          ? `      ${graphql.deleteMutationName}(input: Delete${graphql.typeName}Input!): ${canonicalDeleteResultType(graphql)}`
          : `      ${graphql.deleteMutationName}(id: ID!): Boolean!`]
      : []),
  ];
}

function relationshipReadEnabled(
  relationship: GeneratedCrudRelationship,
  target: GeneratedTable | undefined,
): boolean {
  if (!target) return false;
  return operationEnabled(target, relationship.resolve === "belongsTo" ? "get" : "list");
}

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
  if (!description) return "";
  let safe = "";
  for (let index = 0; index < description.length; index += 1) {
    const code = description.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = description.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        safe += description.slice(index, index + 2);
        index += 1;
      } else {
        safe += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      safe += "\ufffd";
    } else {
      safe += description.charAt(index);
    }
  }
  return `${indent}${JSON.stringify(safe)}\n`;
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
/**
 * GraphQL rejects an unknown input field during validation, before any resolver
 * runs, so the `writtenBy` refusal cannot be phrased there the way REST and MCP
 * phrase theirs. The next best thing is that the schema itself says why the
 * field is missing and what to call instead — an introspecting client reads
 * this without having to be refused first.
 */
function operationWrittenNote(table: GeneratedTable): string | undefined {
  const written = table.columns.filter(isOperationWrittenColumn);
  if (written.length === 0) return undefined;
  const parts = written.map(
    (column) =>
      `${fieldNameForColumn(column)} (${column
        .writtenBy!.map((writer) => writer.operation)
        .join(", ")})`,
  );
  return (
    "Fields that record that a process took place are absent here and are " +
    `written only by the operation named: ${parts.join("; ")}.`
  );
}

export function renderTypeDefinition(
  table: GeneratedTable,
  documentationIndex: ReadonlyMap<string, GraphqlEntityDocumentation> =
    documentationByGraphqlType,
) {
  const graphql = assertGraphqlMetadata(table);
  const canonical = usesCanonicalGraphqlOperations(table);
  const documentation = documentationIndex.get(graphql.typeName);
  const fieldDocumentation = new Map(
    (documentation?.fields ?? []).map((field) => [field.name, field]),
  );
  const queryableColumns = table.columns.filter(
    (column) => !isElicitedOutputColumn(table, column),
  );
  const filterFieldNames = new Set(queryableColumns.map(fieldNameForColumn));
  const relationNames = new Set((graphql.relationships ?? []).filter((relationship) => relationship.fieldKey).map((relationship) => relationship.name));
  const columnFields = table.columns.filter((column) => !relationNames.has(fieldNameForColumn(column)))
    .map((column) => {
      const field = fieldNameForColumn(column);
      return `${renderDescription(fieldDocumentation.get(field)?.description, "      ")}` +
        `      ${field}: ${graphqlScalarForColumn(column)}${nonNullSuffix(column)}`;
    });
  const relationshipFields = (graphql.relationships ?? [])
    .filter((relationship) =>
      isValidGraphqlName(relationship.name) &&
      relationshipReadEnabled(relationship, tablesByGraphqlType.get(relationship.target))
    )
    .flatMap((relationship) => [
      `      ${relationship.name}: ${relationFieldType(relationship)}`,
      `      ${relationship.name}Aggregate: AggregateResult!`,
    ]);
  // Create and update inputs are rendered from the CRUD layer's caller
  // predicate: immutable fields retain their operation asymmetry, while the
  // secure elicitation target is absent from both inputs.
  const creatableColumns = table.columns.filter((column) =>
    isCallerWritableColumn(table, column, "create"),
  );
  const updatableColumns = table.columns.filter((column) =>
    isCallerWritableColumn(table, column, "update"),
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
    ...operationControlFields(table, "update"),
  ].join("\n");
  const canonicalCreateInputBody = [
    createInputBody,
    ...operationControlFields(table, "create"),
  ].join("\n");
  const deleteInputBody = [
    "      id: ID!",
    ...operationControlFields(table, "delete"),
  ].join("\n");
  const canonicalResultTypes = canonical
    ? `
    type ${graphql.typeName}RecordEnvelope {
      data: ${graphql.typeName}!
      operations: [EntityOperationOffer!]!
    }

    type ${graphql.typeName}CollectionData {
      items: [${graphql.typeName}RecordEnvelope!]!
      nextCursor: String
      totalCount: Int
    }

    type ${canonicalRecordResultType(graphql)} {
      data: ${graphql.typeName}
      operations: [EntityOperationOffer!]
      error: EntityOperationError
    }

    type ${canonicalCollectionResultType(graphql)} {
      data: ${graphql.typeName}CollectionData
      operations: [EntityOperationOffer!]
      error: EntityOperationError
    }

    type ${graphql.typeName}DeletionData {
      deleted: Boolean!
    }

    type ${canonicalDeleteResultType(graphql)} {
      data: ${graphql.typeName}DeletionData
      operations: [EntityOperationOffer!]
      error: EntityOperationError
    }

    input Delete${graphql.typeName}Input {
${deleteInputBody}
    }
`
    : "";

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
${queryableColumns
  .flatMap((column) => {
    const field = fieldNameForColumn(column);
    const scalar = graphqlScalarForColumn(column);
    const fieldDocumentationEntry = fieldDocumentation.get(field);
    const directDescription = column.type === "text"
      ? fieldDocumentationEntry?.substringFilterDescription ??
        fieldDocumentationEntry?.description
      : fieldDocumentationEntry?.description;
    const definitions: string[] = [];
    // The CRUD layer reserves a trailing `In` for exact-any filters, so a
    // real field with that suffix has no unambiguous direct filter spelling.
    if (!field.endsWith("In")) {
      definitions.push(
        `${renderDescription(
          appendDescription(
            directDescription,
            column.type === "text"
              ? "Matches a case-insensitive substring."
              : "Matches exactly.",
          ),
          "      ",
        )}      ${field}: ${scalar}`,
      );
    }
    // A real `<field>In` column wins the name. Suppress the generated alias
    // so one authored x/xIn pair cannot make the entire schema invalid.
    if (!filterFieldNames.has(`${field}In`)) {
      definitions.push(`${renderDescription(
        appendDescription(
          fieldDocumentationEntry?.description,
          "Matches exactly against any supplied value.",
        ),
        "      ",
      )}      ${field}In: [${scalar}!]`);
    }
    return definitions;
  })
  .join("\n")}
    }

    input ${graphql.typeName}Sort {
      field: String
      direction: String
    }

${renderDescription(operationWrittenNote(table), "    ")}
    input Create${graphql.typeName}Input {
${canonicalCreateInputBody}
    }

${renderDescription(operationWrittenNote(table), "    ")}
    input Update${graphql.typeName}Input {
${updateInputBody}
    }
${canonicalResultTypes}
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

  type EntityOperationReference {
    id: String!
    intent: String!
  }

  type EntityOperationViolation {
    field: String
    code: String!
    message: String!
    detail: String
  }

  type EntityOperationError {
    code: String!
    message: String!
    detail: String
    violations: [EntityOperationViolation!]
    retryable: Boolean!
    retryAt: String
    data: JSON
  }

  type EntityOperationInteractionChoice {
    value: String!
    label: String!
    description: String
    available: Boolean
    error: EntityOperationError
  }

  type EntityOperationInteractionBinding {
    tenant: String!
    subject: String!
    target: String
    instance: String
    node: String
    version: String
  }

  type EntityOperationInteraction {
    kind: String!
    offerId: String!
    expiresAt: String!
    bindTo: EntityOperationInteractionBinding!
    inputSchema: JSON
    choices: [EntityOperationInteractionChoice!]
  }

  type EntityOperationVersionConcurrency {
    mode: String!
    field: String!
  }

  type EntityOperationEditLeaseConcurrency {
    mode: String!
    expiresAfterInactivity: String!
  }

  type EntityOperationConcurrency {
    version: EntityOperationVersionConcurrency
    editLease: EntityOperationEditLeaseConcurrency
  }

  type EntityOperationTarget {
    entityId: String!
    id: String!
    version: String
  }

  type EntityOperationTargetBinding {
    target: EntityOperationTarget!
    input: JSON!
  }

  type EntityOperationOffer {
    operation: EntityOperationReference!
    available: Boolean!
    interaction: EntityOperationInteraction
    concurrency: EntityOperationConcurrency
    binding: EntityOperationTargetBinding
    error: EntityOperationError
  }

${tables.map((table) => renderTypeDefinition(table)).join("\n")}
`;

export function renderQueryFields(
  table: GeneratedTable,
): string {
  const graphql = assertGraphqlMetadata(table);
  const canonical = usesCanonicalGraphqlOperations(table);
  return [
    ...(operationEnabled(table, "get")
      ? [`${renderDescription(
          `Fetches one ${graphql.typeName} record by id.`,
          "      ",
        )}      ${graphql.singleQueryName}(id: ID!): ${canonical ? canonicalRecordResultType(graphql) : graphql.typeName}`]
      : []),
    ...(operationEnabled(table, "list")
      ? [`${renderDescription(
          `Returns a page of ${graphql.typeName} records.`,
          "      ",
        )}      ${graphql.listQueryName}(filter: ${graphql.typeName}Filter, sort: ${graphql.typeName}Sort, first: Int, after: String): ${canonical ? canonicalCollectionResultType(graphql) : `${graphql.typeName}Connection!`}`]
      : []),
  ].join("\n");
}

export const generatedEntityQueryFields = tables
  .map((table) => renderQueryFields(table))
  .join("\n");

export function renderMutationFields(
  table: GeneratedTable,
): string {
  const graphql = assertGraphqlMetadata(table);
  const canonical = usesCanonicalGraphqlOperations(table);
  return [
    ...(operationEnabled(table, "create")
      ? [`${renderDescription(
          `Creates a ${graphql.typeName} record.`,
          "      ",
        )}      ${graphql.createMutationName}(input: ${mutationInputType(table, "create")}!): ${canonical ? canonicalRecordResultType(graphql) : graphql.typeName}`]
      : []),
    ...(operationEnabled(table, "update")
      ? [`${renderDescription(
          `Partially updates a ${graphql.typeName} record.`,
          "      ",
        )}      ${graphql.updateMutationName}(input: ${mutationInputType(table, "update")}!): ${canonical ? canonicalRecordResultType(graphql) : graphql.typeName}`]
      : []),
    ...(operationEnabled(table, "delete")
      ? [`${renderDescription(
          `Deletes a ${graphql.typeName} record by id.`,
          "      ",
        )}      ${canonical
          ? `${graphql.deleteMutationName}(input: Delete${graphql.typeName}Input!): ${canonicalDeleteResultType(graphql)}`
          : `${graphql.deleteMutationName}(id: ID!): Boolean!`}`]
      : []),
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
 * as plainly as naming it — and through the canonical `data` envelope, where a
 * v2 client's `totalCount` lives. Aliases need no handling: an alias renames
 * the response key, not the field.
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
        // A canonical result wraps the collection in `data { ... }`, so the
        // count a v2 client asks for sits one field down. Only that envelope
        // is descended: a record's own nested selections never carry a count,
        // and walking them would charge a count pass to a query that asked
        // for none.
        if (selection.name.value === "data" && walk(selection.selectionSet)) return true;
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

const GRAPHQL_OPERATION_CONTROLS = new Set([
  "blueprintId",
  "expectedVersion",
  "leaseToken",
  "confirmed",
  "confirmationToken",
  "confirmationAnswer",
]);

/** Split transport controls from authored values before canonical dispatch. */
export function splitCanonicalGraphqlMutationInput(
  input: Record<string, unknown>,
  includeId: boolean,
): { id?: string; values: Record<string, unknown>; controls: EntityOperationInput } {
  const values: Record<string, unknown> = {};
  const controls: EntityOperationInput = {};
  let id: string | undefined;
  for (const [key, value] of Object.entries(input)) {
    if (includeId && key === "id") {
      if (typeof value === "string") id = value;
    } else if (GRAPHQL_OPERATION_CONTROLS.has(key)) {
      (controls as Record<string, unknown>)[key] = value;
    } else {
      values[key] = value;
    }
  }
  return { ...(id === undefined ? {} : { id }), values, controls };
}

/**
 * Canonical GraphQL adapter boundary, exported so tests and alternate schema
 * composers can prove they dispatch the same request contract as REST/MCP.
 */
export function executeCanonicalGraphqlOperation(
  table: GeneratedTable,
  intent: GeneratedCrudExposureOperation,
  input: EntityOperationInput,
  context: GraphqlContext,
  dispatcher: typeof executeEntityOperation = executeEntityOperation,
) {
  const db = requireGeneratedDb(context);
  return dispatcher(db, context.session!, {
    operation: entityOperationRef(table, intent),
    offerIntents: projectedOperationIntents(table),
    input,
  });
}

const queryResolvers = Object.fromEntries(
  tables.flatMap((table) => {
    const graphql = assertGraphqlMetadata(table);
    const authorization = table.source?.authorization;
    return [
      ...(operationEnabled(table, "get") ? [[
        graphql.singleQueryName,
        async (_parent: unknown, args: { id: string }, context: GraphqlContext) => {
          if (usesCanonicalGraphqlOperations(table)) {
            return executeCanonicalGraphqlOperation(
              table,
              "get",
              { id: args.id },
              context,
            );
          }
          return projectGraphqlOperation(() => {
            const db = requireGeneratedDb(context);
            assertOperationAllowed(authorization, context.session, "read", graphql.typeName);
            return getGeneratedEntity(db, context.session, {
              table: table.name,
              id: args.id,
            });
          });
        },
      ]] : []),
      ...(operationEnabled(table, "list") ? [[
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
          if (usesCanonicalGraphqlOperations(table)) {
            return executeCanonicalGraphqlOperation(
              table,
              "list",
              {
                ...(args.first === undefined ? {} : { limit: args.first }),
                ...(args.after === undefined ? {} : { cursor: args.after }),
                ...(args.filter === undefined ? {} : { filter: args.filter }),
                ...(args.sort === undefined ? {} : { sort: args.sort }),
                ...(selectionIncludes(info, "totalCount")
                  ? { includeTotalCount: true as const }
                  : {}),
              },
              context,
            );
          }
          return projectGraphqlOperation(async () => {
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
          });
        },
      ]] : []),
    ];
  }),
);

const mutationResolvers = Object.fromEntries(
  tables.flatMap((table) => {
    const graphql = assertGraphqlMetadata(table);
    const authorization = table.source?.authorization;
    return [
      ...(operationEnabled(table, "create") ? [[
        graphql.createMutationName,
        async (_parent: unknown, args: { input: Record<string, unknown> }, context: GraphqlContext) => {
          if (usesCanonicalGraphqlOperations(table)) {
            if (entityOperationContract(entityOperationRef(table, "create").id).implementation?.type === "plugin") {
              return executeCanonicalGraphqlOperation(table, "create", args.input, context);
            }
            const { values, controls } = splitCanonicalGraphqlMutationInput(
              args.input,
              false,
            );
            return executeCanonicalGraphqlOperation(
              table,
              "create",
              { values, ...controls },
              context,
            );
          }
          return projectGraphqlOperation(() => {
            const db = requireGeneratedDb(context);
            assertOperationAllowed(authorization, context.session, "create", graphql.typeName);
            return createGeneratedEntity(db, context.session, {
              table: table.name,
              values: args.input,
            });
          });
        },
      ]] : []),
      ...(operationEnabled(table, "update") ? [[
        graphql.updateMutationName,
        async (_parent: unknown, args: { input: Record<string, unknown> & { id: string } }, context: GraphqlContext) => {
          if (usesCanonicalGraphqlOperations(table)) {
            if (entityOperationContract(entityOperationRef(table, "update").id).implementation?.type === "plugin") {
              return executeCanonicalGraphqlOperation(table, "update", args.input, context);
            }
            const { id, values, controls } = splitCanonicalGraphqlMutationInput(
              args.input,
              true,
            );
            return executeCanonicalGraphqlOperation(
              table,
              "update",
              { ...(id === undefined ? {} : { id }), values, ...controls },
              context,
            );
          }
          return projectGraphqlOperation(() => {
            const db = requireGeneratedDb(context);
            assertOperationAllowed(authorization, context.session, "update", graphql.typeName);
            return updateGeneratedEntity(db, context.session, {
              table: table.name,
              id: args.input.id,
              values: args.input,
            });
          });
        },
      ]] : []),
      ...(operationEnabled(table, "delete") ? [[
        graphql.deleteMutationName,
        async (
          _parent: unknown,
          args: { id: string } | { input: Record<string, unknown> & { id: string } },
          context: GraphqlContext,
        ) => {
          if (usesCanonicalGraphqlOperations(table)) {
            const { id, controls } = splitCanonicalGraphqlMutationInput(
              "input" in args ? args.input : args,
              true,
            );
            return executeCanonicalGraphqlOperation(
              table,
              "delete",
              { ...(id === undefined ? {} : { id }), ...controls },
              context,
            );
          }
          return projectGraphqlOperation(() => {
            const db = requireGeneratedDb(context);
            assertOperationAllowed(authorization, context.session, "delete", graphql.typeName);
            return deleteGeneratedEntity(db, context.session, {
              table: table.name,
              id: "input" in args ? args.input.id : args.id,
            });
          });
        },
      ]] : []),
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
        if (!targetTable || !relationshipReadEnabled(relationship, targetTable)) {
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
