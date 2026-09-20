// SPDX-License-Identifier: BUSL-1.1
/**
 * GraphQL documents and result readers for the entity sweeps.
 *
 * A canonical entity wraps every answer in an operation result — `{ data,
 * operations, error }`, a collection as `data { items { data } nextCursor
 * totalCount }`, a delete as `data { deleted }` — and reports refusals IN
 * BAND at `data.<field>.error.code` with no top-level error at all. Only
 * failures that precede dispatch (UNAUTHENTICATED, schema validation) still
 * throw.
 *
 * Every builder here renders the document and every reader unwraps it, so a
 * suite states its intent once rather than spelling out the envelope itself.
 */
import { expect } from "bun:test";
import { gql, type GeneratedTable, type GqlResponse, type Identity } from "./harness.js";
import {
  acknowledgementRequired,
  acquireLease,
  challengeAnswerFor,
  challengeFieldFor,
  isEntityBackedCreate,
  type MutationControls,
} from "./operations.js";

type Graphql = NonNullable<NonNullable<GeneratedTable["source"]>["graphql"]>;

function graphqlOf(table: GeneratedTable): Graphql {
  const graphql = table.source?.graphql;
  if (!graphql) throw new Error(`${table.name} has no GraphQL metadata.`);
  return graphql;
}

/** Selection on a canonical result: the record plus the in-band error. */
const ERROR_SELECTION = "error { code message retryable data }";

function recordSelection(table: GeneratedTable, selection: string): string {
  return `data { ${selection} } ${ERROR_SELECTION}`;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** `query($id: ID!) { x(id: $id) { data { <selection> } error {...} } }`. */
export function getDoc(table: GeneratedTable, selection = "id"): string {
  const graphql = graphqlOf(table);
  return `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { ${recordSelection(table, selection)} } }`;
}

export type ListDocOptions = {
  /** Variables to declare and pass; types follow the generated schema. */
  variables?: readonly ("filter" | "sort" | "first" | "after")[];
  /** Literal arguments appended verbatim, e.g. `first: 1`. */
  args?: string;
  /** Selection on each record; omit to select nothing per record. */
  selection?: string;
  totalCount?: boolean;
  /** Cursor bookkeeping: selects `nextCursor`. */
  pageInfo?: boolean;
};

const LIST_VARIABLE_TYPES = {
  filter: (typeName: string) => `${typeName}Filter`,
  sort: (typeName: string) => `${typeName}Sort`,
  first: () => "Int",
  after: () => "String",
} as const;

/**
 * A list query. The record selection, count and cursor bookkeeping are named
 * by intent, so a test asks for "ids and totalCount" rather than spelling out
 * items/data itself.
 */
export function listDoc(table: GeneratedTable, options: ListDocOptions = {}): string {
  const graphql = graphqlOf(table);
  const variables = options.variables ?? [];
  const declared = variables
    .map((name) => `$${name}: ${LIST_VARIABLE_TYPES[name](graphql.typeName)}`)
    .join(", ");
  const args = [...variables.map((name) => `${name}: $${name}`), ...(options.args ? [options.args] : [])]
    .join(", ");
  const record = options.selection ?? "";

  const body = [
    record ? `items { data { ${record} } }` : "",
    options.totalCount ? "totalCount" : "",
    options.pageInfo ? "nextCursor" : "",
  ].filter(Boolean).join(" ");
  return `query${declared ? `(${declared})` : ""} {
    ${graphql.listQueryName}${args ? `(${args})` : ""} {
      data { ${body || "__typename"} }
      ${ERROR_SELECTION}
    }
  }`;
}

/** The GraphQL input type `create` takes: the column input, or JSON for a plugin-backed create. */
export function createInputType(table: GeneratedTable): string {
  return isEntityBackedCreate(table) ? `Create${graphqlOf(table).typeName}Input` : "JSON";
}

export function createDoc(table: GeneratedTable, selection = "id"): string {
  const graphql = graphqlOf(table);
  return `mutation($input: ${createInputType(table)}!) {
    ${graphql.createMutationName}(input: $input) { ${recordSelection(table, selection)} }
  }`;
}

export function updateDoc(table: GeneratedTable, selection = "id"): string {
  const graphql = graphqlOf(table);
  return `mutation($input: Update${graphql.typeName}Input!) {
    ${graphql.updateMutationName}(input: $input) { ${recordSelection(table, selection)} }
  }`;
}

export function deleteDoc(table: GeneratedTable): string {
  const graphql = graphqlOf(table);
  return `mutation($input: Delete${graphql.typeName}Input!) {
    ${graphql.deleteMutationName}(input: $input) { data { deleted } ${ERROR_SELECTION} }
  }`;
}

/** Variables for `deleteDoc`: an input carrying the id and its controls. */
export function deleteVariables(
  table: GeneratedTable,
  id: string,
  controls: MutationControls = {},
): Record<string, unknown> {
  return {
    input: {
      id,
      ...controls,
      ...(acknowledgementRequired(table, "delete") ? { confirmed: true } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export type OperationErrorShape = {
  code: string;
  message: string;
  retryable?: boolean;
  data?: Record<string, any> | null;
};

/**
 * The refusal a response carries for `field`: the in-band `data.<field>.error`,
 * or a pre-dispatch failure thrown as `errors[0].extensions`. Undefined when
 * the request succeeded.
 */
export function operationErrorOf(
  table: GeneratedTable,
  result: GqlResponse,
  field: string,
): OperationErrorShape | undefined {
  const thrown = result.errors?.[0];
  if (thrown) {
    // Pre-dispatch failures (UNAUTHENTICATED, validation) throw.
    const extensions = thrown.extensions as { code?: string; data?: unknown } | undefined;
    return {
      code: extensions?.code ?? "GRAPHQL_ERROR",
      message: thrown.message,
      ...(extensions?.data === undefined ? {} : { data: extensions.data as Record<string, any> }),
    };
  }
  const error = result.data?.[field]?.error;
  return error ? (error as OperationErrorShape) : undefined;
}

/**
 * Asserts `field` was refused with `code`, and that the refusal did not also
 * answer the question: a thrown error nulls the payload, an in-band result
 * carries no data next to its error.
 */
export function expectOperationError(
  table: GeneratedTable,
  result: GqlResponse,
  field: string,
  code: string,
): OperationErrorShape {
  const error = operationErrorOf(table, result, field);
  expect(error?.code).toBe(code);
  if (!result.errors) {
    expect(result.data?.[field]?.data ?? null).toBeNull();
  } else {
    expect(result.data?.[field] ?? null).toBeNull();
  }
  return error!;
}

/** Asserts the request succeeded at every level and returns the raw payload of `field`. */
export function expectOperationData(
  table: GeneratedTable,
  result: GqlResponse,
  field: string,
): any {
  expect(result.errors ?? []).toEqual([]);
  expect(result.data).toBeTruthy();
  const payload = result.data![field];
  expect(payload).toBeTruthy();
  expect(payload.error ?? null).toBeNull();
  return payload.data ?? null;
}

/** The single record (or null for "not found") a get/create/update answered with. */
export function recordOf(table: GeneratedTable, result: GqlResponse, field: string): any {
  return expectOperationData(table, result, field);
}

export type Collection = {
  items: any[];
  totalCount: number | null | undefined;
  nextCursor: string | null | undefined;
  hasNextPage: boolean;
};

/** A list answer unwrapped: records, count and cursor. */
export function collectionOf(
  table: GeneratedTable,
  result: GqlResponse,
  field: string,
): Collection {
  const payload = expectOperationData(table, result, field);
  expect(payload).toBeTruthy();
  const nextCursor = payload.nextCursor as string | null | undefined;
  return {
    items: (payload.items ?? []).map((item: { data: unknown }) => item.data),
    totalCount: payload.totalCount,
    nextCursor,
    hasNextPage: nextCursor !== null && nextCursor !== undefined,
  };
}

/** Whether a delete answer reports the row as removed. */
export function deletedOf(table: GeneratedTable, result: GqlResponse): boolean {
  const field = graphqlOf(table).deleteMutationName;
  const payload = expectOperationData(table, result, field);
  return payload?.deleted === true;
}

// ---------------------------------------------------------------------------
// Mutations with their controls
// ---------------------------------------------------------------------------

type Auth = { bearer?: string };

/** Fetches the record as the caller sees it, selecting `selection`. */
export async function fetchRecord(
  identity: Identity | null,
  table: GeneratedTable,
  id: string,
  selection = "id",
  auth: Auth = {},
): Promise<any> {
  const result = await gql(identity, getDoc(table, selection), { id }, auth);
  return recordOf(table, result, graphqlOf(table).singleQueryName);
}

/**
 * Runs a mutation that may answer with a server-issued confirmation challenge
 * (canonical delete, and any canonical update authored that way): retries once
 * with the challenge token and the record's current value of the challenged
 * field, exactly as a client would.
 */
async function withConfirmation(
  identity: Identity | null,
  table: GeneratedTable,
  intent: "update" | "delete",
  id: string,
  run: (controls: MutationControls) => Promise<GqlResponse>,
  controls: MutationControls,
  auth: Auth,
): Promise<GqlResponse> {
  const graphql = graphqlOf(table);
  const field = intent === "update" ? graphql.updateMutationName : graphql.deleteMutationName;
  const first = await run({
    ...controls,
    ...(acknowledgementRequired(table, intent) ? { confirmed: true } : {}),
  });
  const error = operationErrorOf(table, first, field);
  if (error?.code !== "CONFIRMATION_REQUIRED") return first;
  const challengeToken = error.data?.confirmation?.challengeToken as string | undefined;
  if (!challengeToken) {
    throw new Error(`${field} demanded confirmation without issuing a challenge token.`);
  }
  // The challenge names one field; read it back so the answer is the value
  // the server will hash, not the value the test believes it planted.
  const challenged = challengeFieldFor(table, intent);
  const relationshipField = table.source?.graphql?.relationships?.some(
    (relationship) => relationship.fieldKey === challenged,
  ) === true;
  const row = await fetchRecord(
    identity,
    table,
    id,
    `id ${challenged ?? ""}${challenged && relationshipField ? " { id }" : ""}`,
    auth,
  );
  return run({
    ...controls,
    confirmationToken: challengeToken,
    confirmationAnswer: challengeAnswerFor(table, intent, row ?? {}),
  });
}

/**
 * Updates `values` on `id`, acquiring the lease the Operation demands first.
 * Returns the raw response so a test can assert either outcome.
 */
export async function updateRecord(
  identity: Identity | null,
  table: GeneratedTable,
  id: string,
  values: Record<string, unknown>,
  options: Auth & { selection?: string } = {},
): Promise<GqlResponse> {
  const { selection = "id", ...auth } = options;
  const lease = await acquireLease(identity, table, id, "update", auth);
  return withConfirmation(
    identity,
    table,
    "update",
    id,
    (controls) =>
      gql(identity, updateDoc(table, selection), { input: { id, ...values, ...controls } }, auth),
    lease,
    auth,
  );
}

/**
 * Deletes `id` the way a client must: lease, then delete, then answer the
 * confirmation challenge if one is issued. Returns the raw response.
 */
export async function deleteRecord(
  identity: Identity | null,
  table: GeneratedTable,
  id: string,
  auth: Auth = {},
): Promise<GqlResponse> {
  const lease = await acquireLease(identity, table, id, "delete", auth);
  return withConfirmation(
    identity,
    table,
    "delete",
    id,
    (controls) => gql(identity, deleteDoc(table), deleteVariables(table, id, controls), auth),
    lease,
    auth,
  );
}

/** Deletes and asserts the row was removed. */
export async function expectDeleted(
  identity: Identity | null,
  table: GeneratedTable,
  id: string,
  auth: Auth = {},
): Promise<void> {
  const result = await deleteRecord(identity, table, id, auth);
  expect(deletedOf(table, result)).toBe(true);
}
