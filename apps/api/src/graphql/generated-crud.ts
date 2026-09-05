// SPDX-License-Identifier: BUSL-1.1
import manifest from "../generated/db/manifest.json" with { type: "json" };
import { GraphQLError } from "graphql";
import { sql } from "kysely";
import { redactElicitedValues } from "../connectors/secrets.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import {
  classifyDatabaseError,
  type DatabaseErrorTableContext,
} from "../db/database-refusals.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import { appendScopedEntityEventInTransaction } from "../platform/entity-events.js";
import {
  assertClassifiedQueryFieldsAllowed,
  canReadClassifiedColumns,
  redactRow,
} from "./generated-authz.js";

type GeneratedCrudTable = {
  name: string;
  schema: string;
  table: string;
  tenantScoped: boolean;
  domainInternal: boolean;
  generatedCrudEligible?: boolean;
  generatedCrud: boolean;
  primaryKey: string | null;
  columns: GeneratedCrudColumn[];
  source?: {
    authoringEntityName?: string;
    crud?: {
      operations: Record<GeneratedCrudExposureOperation, boolean>;
    };
    graphql?: {
      typeName: string;
      singleQueryName: string;
      listQueryName: string;
      createMutationName: string;
      updateMutationName: string;
      deleteMutationName: string;
      relationships?: GeneratedCrudRelationship[];
      /**
       * Effective default sort for any embedded list rendering of this
       * entity. Derived by the compiler from the entity's view
       * presentations (`listCompact.defaultSort` then `list.defaultSort`).
       * `field` is the camelCase field name — mapped to a column via the
       * existing `fieldColumnMap` plumbing.
       */
      defaultSort?: { field: string; direction: "asc" | "desc" };
    };
    /**
     * Opt-in generated REST exposure (entity YAML `rest:` block). When
     * present, the REST route registration mounts Fastify routes under
     * /api/rest/v1/{basePath} for each enabled operation.
     */
    rest?: {
      basePath: string;
      operations: {
        list: boolean;
        get: boolean;
        create: boolean;
        update: boolean;
        delete: boolean;
      };
    };
    /**
     * Opt-in generated MCP exposure (entity YAML `mcp:` block). When present,
     * the MCP server advertises tools for this table under `toolPrefix`. The
     * tools' input schemas are not here — they live in the separate
     * generated/mcp/tools.json catalog, built from the authored field
     * definitions rather than these storage columns.
     */
    mcp?: {
      toolPrefix: string;
      tools: "dedicated" | "generic";
      operations: {
        list: boolean;
        get: boolean;
        create: boolean;
        update: boolean;
        delete: boolean;
      };
      elicitOnCreate?: {
        sourceField: string;
        sourceEntity: string;
        definitionsField: string;
        into: string;
        message?: string;
      };
    };
    /**
     * Per-operation entity role allow-lists (authored + Keycloak-normalized
     * union, compiler-emitted). Enforced fail-closed by
     * requireEntityOperation before any SQL runs, so both the GraphQL
     * resolvers and the REST routes are gated by construction (#94).
     */
    authorization?: GeneratedCrudAuthorization;
  };
};

export type GeneratedCrudOperation = "read" | "create" | "update" | "delete";
export type GeneratedCrudExposureOperation = "list" | "get" | "create" | "update" | "delete";

export type GeneratedCrudAuthorization = {
  roles: Record<GeneratedCrudOperation, string[]>;
};

export type GeneratedCrudColumn = {
  name: string;
  type: string;
  required: boolean;
  primaryKey: boolean;
  generated: string | null;
  sourceField?: string;
  /**
   * Data-classification tier (pii/bsn/confidential) propagated from the
   * authoring field. Present only for restricting tiers; used to redact the
   * column from readers who lack a write grant on the entity (#96/#101).
   */
  classification?: "confidential" | "pii" | "bsn";
  /**
   * Authored `immutable: true` on the backing field: settable at create,
   * refused on update (#177). Reaches the runtime the way `classification`
   * does, so all three transports inherit it from one authored fact.
   */
  immutable?: boolean;
};

export type GeneratedCrudRelationship = {
  name: string;
  target: string;
  type: string;
  resolve: "belongsTo" | "hasMany";
  foreignKey?: string;
};

type GeneratedEntityRow = Record<string, unknown>;

export type GeneratedEntityConnection = {
  rows: GeneratedEntityRow[];
  nextCursor: string | null;
  /**
   * `null` unless the caller asked for it with `includeTotalCount` (#17).
   *
   * The count is a second pass over the same predicate as the page, and it is
   * the expensive one: it cannot stop at `limit`, and a text filter compiles to
   * an unanchored `ilike '%value%'` that no b-tree index answers, so on a large
   * tenant it degrades to a sequential scan. Paying for it on every list —
   * including `first: 1` — let a stream of cheap requests hold the database in
   * sustained full scans.
   *
   * Transports that always publish a count (REST, MCP) opt in; GraphQL opts in
   * only when the client actually selected the field.
   */
  totalCount: number | null;
};

type ListPageInput = {
  limit?: number | null;
  cursor?: string | null;
  filter?: Record<string, unknown> | null;
  sort?: { field?: string | null; direction?: string | null } | null;
  /** Run the count pass. Off by default: see GeneratedEntityConnection.totalCount. */
  includeTotalCount?: boolean;
};

/** A connection whose caller opted into the count, so it is never null. */
export type CountedEntityConnection = GeneratedEntityConnection & {
  totalCount: number;
};

export function isGeneratedCrudTableEligible(table: GeneratedCrudTable): boolean {
  if (table.domainInternal) return false;
  return table.generatedCrudEligible === undefined
    ? table.generatedCrud === true
    : table.generatedCrudEligible === true;
}

export function isGeneratedCrudOperationEnabled(
  table: GeneratedCrudTable,
  operation: GeneratedCrudExposureOperation,
): boolean {
  if (table.source?.crud !== undefined) {
    return table.source.crud.operations?.[operation] === true;
  }
  return table.generatedCrud === true;
}

const generatedCrudTables = new Map(
  (manifest.tables as GeneratedCrudTable[])
    .filter((table) => isGeneratedCrudTableEligible(table) && table.primaryKey)
    .map((table) => [table.name, table]),
);

// Precomputed per-table, per-operation role allow-sets from the manifest's
// source.authorization block. Membership checks are exact case-sensitive
// string matches — the compiler already emitted both the authored (Dutch)
// and Keycloak-normalized (English) spellings of every role.
const entityRoleSets = new Map<string, Partial<Record<GeneratedCrudOperation, ReadonlySet<string>>>>(
  [...generatedCrudTables.values()].map((table) => [
    table.name,
    Object.fromEntries(
      Object.entries(table.source?.authorization?.roles ?? {}).map(
        ([operation, roles]) => [operation, new Set(roles)],
      ),
    ) as Partial<Record<GeneratedCrudOperation, ReadonlySet<string>>>,
  ]),
);

const AUTHORIZATION_OPERATION: Record<GeneratedCrudExposureOperation, GeneratedCrudOperation> = {
  list: "read",
  get: "read",
  create: "create",
  update: "update",
  delete: "delete",
};

/**
 * Fail-closed entity-level role gate, shared by every generated CRUD entry
 * point and therefore by both the GraphQL resolvers and the REST routes.
 * Runs before withDbSession — a forbidden operation opens no transaction and
 * journals no entity events. The error message deliberately names only the
 * entity and operation, never the allowed role list (no role enumeration).
 */
function requireEntityOperation(
  table: GeneratedCrudTable,
  operation: GeneratedCrudExposureOperation,
  session: DbSessionInput,
): void {
  if (!isGeneratedCrudOperationEnabled(table, operation)) {
    throw new GraphQLError(
      `Generated CRUD operation ${operation} is not enabled for ${table.source?.authoringEntityName ?? table.name}.`,
      { extensions: { code: "GENERATED_CRUD_OPERATION_NOT_ENABLED", status: 404 } },
    );
  }
  const authorizationOperation = AUTHORIZATION_OPERATION[operation];
  const allowed = entityRoleSets.get(table.name)?.[authorizationOperation];
  if (!allowed || allowed.size === 0) {
    // A generatedCrud table without role metadata means the manifest predates
    // the authorization bridge (stale artifacts) — deny with distinct wording
    // so operators recognize the regeneration bug instead of a policy denial.
    throw new GraphQLError(
      `Entity ${table.name} has no role metadata for ${authorizationOperation}; access denied. ` +
        `Regenerate artifacts with \`bun run generate\`.`,
      { extensions: { code: "FORBIDDEN", status: 403 } },
    );
  }
  const sessionRoles = session.roles ?? [];
  if (!sessionRoles.some((role) => allowed.has(role))) {
    throw new GraphQLError(
      `Not authorized to ${operation} ${table.source?.authoringEntityName ?? table.name}.`,
      { extensions: { code: "FORBIDDEN", status: 403 } },
    );
  }
}

/** Test-only direct handle on the guard (unit tests bypass the DB layer). */
export const __requireEntityOperationForTests = requireEntityOperation;

/**
 * Entity name used in authorization errors — the authored name when the
 * manifest carries one, never the physical table. Matches the wording
 * requireEntityOperation already produces.
 */
function entityLabel(table: GeneratedCrudTable) {
  return table.source?.authoringEntityName ?? table.name;
}

/**
 * Field-level data protection (#96/#101), applied in the shared CRUD core
 * rather than per transport: every read reaches its rows through the functions
 * below, so GraphQL, the generated REST routes and any transport added later
 * inherit redaction by construction instead of having to remember it (#164).
 *
 * Classification and elicited-secret projection are composed here so every
 * generated CRUD return path has one output policy. A write grant can reveal
 * classified plain values, but encrypted elicited values always leave as the
 * existing set marker.
 */
function projectRows(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  rows: GeneratedEntityRow[],
): GeneratedEntityRow[] {
  const hasClassification = table.columns.some(
    (column) => column.classification,
  );
  const hasElicitedOutput = table.source?.mcp?.elicitOnCreate !== undefined;
  if (!hasClassification && !hasElicitedOutput) {
    return rows;
  }
  return rows.map((row) => projectGeneratedEntityRow(table, session, row));
}

function elicitedOutputColumn(
  table: GeneratedCrudTable,
): GeneratedCrudColumn | undefined {
  const target = table.source?.mcp?.elicitOnCreate?.into;
  if (!target) return undefined;
  const column = table.columns.find(
    (candidate) => fieldNameForColumn(candidate) === target,
  );
  if (!column) {
    throw generatedCrudError(
      "Generated CRUD elicited-output metadata is invalid.",
      "INTERNAL_SERVER_ERROR",
      500,
    );
  }
  return column;
}

export function isElicitedOutputColumn(
  table: GeneratedCrudTable,
  column: GeneratedCrudColumn,
): boolean {
  return elicitedOutputColumn(table)?.name === column.name;
}

export function projectGeneratedEntityRow(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  row: GeneratedEntityRow,
): GeneratedEntityRow {
  const classified = redactRow(
    row,
    table.columns,
    table.source?.authorization,
    session,
  );
  const column = elicitedOutputColumn(table);
  return column
    ? redactElicitedValues(classified, column.name)
    : classified;
}

/** Elicited values cannot be used as list membership or ordering oracles. */
function assertElicitedQueryAllowed(
  table: GeneratedCrudTable,
  input: Pick<ListPageInput, "filter" | "sort">,
): void {
  const column = elicitedOutputColumn(table);
  if (!column) return;
  const field = fieldNameForColumn(column);
  const filtered = Object.keys(input.filter ?? {}).some(
    (candidate) => candidate === field || candidate === `${field}In`,
  );
  if (filtered || input.sort?.field === field) {
    throw generatedCrudError(
      "Filtering or sorting by an elicited-output field is not permitted.",
      "FORBIDDEN",
      403,
    );
  }
}

/** The oracle guard for caller-supplied list filters and ordering. */
function assertClassifiedQueryAllowed(
  table: GeneratedCrudTable,
  session: DbSessionInput,
  input: {
    filter?: Record<string, unknown> | null;
    sort?: { field?: string | null; direction?: string | null } | null;
  },
): void {
  assertClassifiedQueryFieldsAllowed(
    table.columns,
    table.source?.authorization,
    session,
    entityLabel(table),
    input.filter,
    input.sort,
  );
}

export function isGeneratedCrudTableReadable(name: string) {
  const table = generatedCrudTables.get(name);
  return table !== undefined && (
    isGeneratedCrudOperationEnabled(table, "list") ||
    isGeneratedCrudOperationEnabled(table, "get")
  );
}

export function getGeneratedCrudTables() {
  return [...generatedCrudTables.values()];
}

function generatedCrudError(
  message: string,
  code: string,
  status?: number,
  authored?: { detail?: string; hint?: string },
) {
  return new GraphQLError(message, {
    extensions: {
      code,
      ...(status === undefined ? {} : { status }),
      ...(authored?.detail === undefined ? {} : { detail: authored.detail }),
      ...(authored?.hint === undefined ? {} : { hint: authored.hint }),
    },
  });
}

/**
 * A database refusal on a generated write becomes a GraphQLError carrying the
 * public code and status, so all three transports answer alike: GraphQL passes
 * it through unmasked (no originalError), REST and MCP map it via toHttpError.
 * Anything the classifier declines stays the original driver error and is
 * redacted downstream exactly as before.
 */
function translateDatabaseError(table: GeneratedCrudTable, error: unknown): unknown {
  const refusal = classifyDatabaseError(error, databaseErrorContext(table));
  return refusal
    ? generatedCrudError(refusal.message, refusal.code, refusal.status, {
        ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
        ...(refusal.hint === undefined ? {} : { hint: refusal.hint }),
      })
    : error;
}

function databaseErrorContext(table: GeneratedCrudTable): DatabaseErrorTableContext {
  const columns = tableColumnMap(table);
  const belongsTo = new Set<string>();
  for (const relationship of table.source?.graphql?.relationships ?? []) {
    if (relationship.resolve === "belongsTo" && relationship.foreignKey) {
      belongsTo.add(relationship.foreignKey);
    }
  }
  return {
    table: table.table,
    belongsTo,
    fieldName: (column) => {
      const known = columns.get(column);
      return known ? fieldNameForColumn(known) : undefined;
    },
  };
}

/**
 * Resolves a table by name AND enforces the entity role gate for the
 * requested operation. This is the only by-name table resolver, so every
 * public CRUD entry point is role-checked by construction.
 */
function readGeneratedCrudTable(
  name: string,
  operation: GeneratedCrudExposureOperation,
  session: DbSessionInput,
) {
  const table = generatedCrudTables.get(name);
  if (!table || !table.primaryKey) {
    throw generatedCrudError(
      `Generated CRUD is not enabled for ${name}.`,
      "GENERATED_CRUD_NOT_ENABLED",
    );
  }
  requireEntityOperation(table, operation, session);
  return table;
}

function generatedCrudAggregateType(table: GeneratedCrudTable) {
  const aggregateType = table.source?.graphql?.singleQueryName?.trim();
  if (!aggregateType) {
    throw generatedCrudError(
      `Generated CRUD table ${table.name} is missing source.graphql.singleQueryName.`,
      "INTERNAL_SERVER_ERROR",
    );
  }
  return aggregateType;
}

async function appendGeneratedCrudEvent(
  trx: Parameters<typeof appendScopedEntityEventInTransaction>[0],
  table: GeneratedCrudTable,
  input: {
    aggregateId: string;
    eventType: "created" | "updated" | "deleted";
  },
) {
  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: generatedCrudAggregateType(table),
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: {
      table: table.name,
      schema: table.schema,
      operation: input.eventType,
    },
  });
}

function generatedCrudAggregateId(table: GeneratedCrudTable, row: GeneratedEntityRow) {
  const id = row[table.primaryKey!];
  if (id === null || id === undefined || id === "") {
    throw generatedCrudError(
      `Generated CRUD event for ${table.name} is missing primary key ${table.primaryKey}.`,
      "INTERNAL_SERVER_ERROR",
    );
  }
  return String(id);
}

function normalizeLimit(limit?: number | null) {
  if (!Number.isFinite(limit ?? NaN)) {
    return 50;
  }
  return Math.max(1, Math.min(Math.trunc(limit as number), 200));
}

/**
 * Upper bound on the decoded pagination offset. The cursor is an opaque,
 * client-craftable base64url integer that flows straight into SQL `OFFSET`;
 * Postgres must still generate and discard `OFFSET` rows, so an unbounded
 * offset is a cheap-to-send, expensive-to-serve deep-scan amplification.
 * Cap it so page cost stays bounded. Configurable via
 * OPENSHAPEFORGE_GENERATED_CRUD_MAX_OFFSET for deployments that legitimately
 * page very deep.
 */
const DEFAULT_MAX_OFFSET = 100_000;

function maxOffset() {
  const raw = process.env.OPENSHAPEFORGE_GENERATED_CRUD_MAX_OFFSET;
  if (raw === undefined || raw === "") {
    return DEFAULT_MAX_OFFSET;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_MAX_OFFSET;
  }
  return parsed;
}

function decodeOffsetCursor(cursor?: string | null) {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(
    Buffer.from(cursor, "base64url").toString("utf8"),
    10,
  );
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw generatedCrudError("Invalid generated CRUD cursor.", "BAD_USER_INPUT");
  }
  if (parsed > maxOffset()) {
    throw generatedCrudError(
      "Generated CRUD cursor exceeds the maximum allowed offset. Narrow the " +
        "result set with a filter or sort instead of paging arbitrarily deep.",
      "BAD_USER_INPUT",
    );
  }
  return parsed;
}

function encodeOffsetCursor(offset: number) {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function fieldNameForColumn(column: GeneratedCrudColumn) {
  return column.sourceField ?? column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function fieldColumnMap(table: GeneratedCrudTable) {
  return new Map(table.columns.map((column) => [fieldNameForColumn(column), column]));
}

function tableColumnMap(table: GeneratedCrudTable) {
  return new Map(table.columns.map((column) => [column.name, column]));
}

function normalizeSortDirection(value: unknown): "asc" | "desc" {
  return typeof value === "string" && value.toLowerCase() === "desc" ? "desc" : "asc";
}

function buildFilterConditions(
  table: GeneratedCrudTable,
  filter?: Record<string, unknown> | null,
  fixedWhere: Array<{ column: string; value: unknown }> = [],
) {
  const fields = fieldColumnMap(table);
  const columns = tableColumnMap(table);
  const conditions = fixedWhere.map((condition) => {
    if (!columns.has(condition.column)) {
      throw generatedCrudError(
        `Unknown generated CRUD column ${condition.column} for ${table.name}.`,
        "BAD_USER_INPUT",
      );
    }
    return sql`${sql.id("row_source", condition.column)} = ${condition.value}`;
  });

  for (const [key, value] of Object.entries(filter ?? {})) {
    if (value == null || value === "") {
      continue;
    }

    const isInFilter = key.endsWith("In");
    const fieldName = isInFilter ? key.slice(0, -2) : key;
    const column = fields.get(fieldName);
    if (!column) {
      throw generatedCrudError(
        `Unknown generated CRUD filter field ${key} for ${table.name}.`,
        "BAD_USER_INPUT",
      );
    }

    if (isInFilter) {
      if (!Array.isArray(value) || value.length === 0) {
        continue;
      }
      conditions.push(sql`${sql.id("row_source", column.name)} in (${sql.join(value)})`);
      continue;
    }

    if (column.type === "text" && typeof value === "string") {
      conditions.push(sql`${sql.id("row_source", column.name)} ilike ${`%${value}%`}`);
      continue;
    }

    conditions.push(sql`${sql.id("row_source", column.name)} = ${value}`);
  }

  return conditions.length === 0
    ? sql`true`
    : sql.join(conditions, sql` and `);
}

function tenantFixedWhere(table: GeneratedCrudTable, session: DbSessionInput) {
  if (!table.tenantScoped) {
    return [];
  }
  return [{ column: "tenant_id", value: session.tenantId }];
}

function buildSortExpression(
  table: GeneratedCrudTable,
  sort?: { field?: string | null; direction?: string | null } | null,
) {
  const fields = fieldColumnMap(table);
  let requested: GeneratedCrudColumn | undefined;
  if (sort?.field) {
    requested = fields.get(sort.field);
    if (!requested) {
      throw generatedCrudError(
        `Unknown generated CRUD sort field ${sort.field} for ${table.name}.`,
        "BAD_USER_INPUT",
      );
    }
  }
  const column = requested ?? table.columns.find((item) => item.name === table.primaryKey);
  if (!column) {
    throw generatedCrudError(
      `Generated CRUD table ${table.name} does not have a sortable primary column.`,
      "BAD_USER_INPUT",
    );
  }
  const direction = normalizeSortDirection(sort?.direction);
  return direction === "desc"
    ? sql`${sql.id("row_source", column.name)} desc`
    : sql`${sql.id("row_source", column.name)} asc`;
}

/**
 * Role-ungated list for RUNTIME surfaces (not callers): tenant scoping and
 * row-level security still apply via withDbSession, but the entity-role gate
 * is deliberately absent — the derived-tools projection reads definition rows
 * on behalf of an audience that holds none of the entity's CRUD roles. Every
 * caller-facing path must keep going through listGeneratedEntities.
 */
async function listGeneratedEntityRowsForTable(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  input: ListPageInput & {
    fixedWhere?: Array<{ column: string; value: unknown }>;
  },
  projectOutput: boolean,
): Promise<GeneratedEntityConnection> {
  // This helper intentionally bypasses entity-role checks for trusted runtime
  // projections, but it must not bypass the value-oracle boundary.
  assertElicitedQueryAllowed(table, input);
  const limit = normalizeLimit(input.limit);
  const offset = decodeOffsetCursor(input.cursor);
  const fixedWhere = [...tenantFixedWhere(table, session), ...(input.fixedWhere ?? [])];
  const where = buildFilterConditions(table, input.filter, fixedWhere);
  const orderBy = buildSortExpression(table, input.sort);

  return withDbSession(db, session, async (trx) => {
    const result = await sql<{ row: GeneratedEntityRow }>`
      select to_jsonb(row_source.*) as row
      from ${sql.id(table.schema, table.table)} as row_source
      where ${where}
      order by ${orderBy}
      limit ${limit + 1}
      offset ${offset}
    `.execute(trx);

    // Second pass, and the costly one — run it only when someone consumes it.
    // Kept inside this transaction so the count and the page see one snapshot.
    let totalCount: number | null = null;
    if (input.includeTotalCount) {
      const countResult = await sql<{ total_count: string | number }>`
        select count(*) as total_count
        from ${sql.id(table.schema, table.table)} as row_source
        where ${where}
      `.execute(trx);
      totalCount = Number(countResult.rows[0]?.total_count ?? 0);
    }

    const storageRows = result.rows.slice(0, limit).map((row) => row.row);
    const rows = projectOutput
      ? projectRows(table, session, storageRows)
      : storageRows;
    return {
      rows,
      totalCount,
      nextCursor:
        result.rows.length > limit ? encodeOffsetCursor(offset + limit) : null,
    };
  });
}

export function listGeneratedEntitiesForTable(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  input: ListPageInput & {
    fixedWhere?: Array<{ column: string; value: unknown }>;
  },
): Promise<GeneratedEntityConnection> {
  return listGeneratedEntityRowsForTable(db, session, table, input, true);
}

/**
 * Explicit storage-side read for trusted runtime execution that must decrypt
 * values. Never use this for a transport response or other caller output.
 */
export function listGeneratedEntityStorageRowsForTable(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  input: ListPageInput & {
    fixedWhere?: Array<{ column: string; value: unknown }>;
  },
): Promise<GeneratedEntityConnection> {
  return listGeneratedEntityRowsForTable(db, session, table, input, false);
}

export async function listGeneratedEntities(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: ListPageInput & { table: string; includeTotalCount: true },
): Promise<CountedEntityConnection>;
export async function listGeneratedEntities(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: ListPageInput & { table: string },
): Promise<GeneratedEntityConnection>;
export async function listGeneratedEntities(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: ListPageInput & { table: string },
): Promise<GeneratedEntityConnection> {
  const table = readGeneratedCrudTable(input.table, "list", session);
  // Before any SQL runs: filtering or sorting by a column this session may not
  // read turns the result set (and totalCount) into an oracle for the value
  // redaction withholds.
  assertClassifiedQueryAllowed(table, session, input);
  return listGeneratedEntitiesForTable(db, session, table, input);
}

export async function getGeneratedEntity(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: {
    table: string;
    id: string;
  },
): Promise<GeneratedEntityRow | null> {
  const table = readGeneratedCrudTable(input.table, "get", session);
  const row = await fetchGeneratedEntityRow(db, session, table, input.id);
  return row === null
    ? null
    : projectGeneratedEntityRow(table, session, row);
}

/**
 * Row fetch WITHOUT the role gate or output projection. Callers must have
 * already authorized the operation that led here and must project before
 * handing the row to a reader.
 */
async function fetchGeneratedEntityRow(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
): Promise<GeneratedEntityRow | null> {
  return withDbSession(db, session, async (trx) => {
    const tenantWhere =
      table.tenantScoped
        ? sql`and ${sql.id("row_source", "tenant_id")} = ${session.tenantId}`
        : sql``;
    const result = await sql<{ row: GeneratedEntityRow }>`
      select to_jsonb(row_source.*) as row
      from ${sql.id(table.schema, table.table)} as row_source
      where ${sql.id("row_source", table.primaryKey!)}::text = ${id}
        ${tenantWhere}
      limit 1
    `.execute(trx);

    return result.rows[0]?.row ?? null;
  });
}

/**
 * The single storage-writability rule shared by generated CRUD. Caller-facing
 * surfaces additionally apply isCallerWritableColumn so the secure
 * elicitation target remains server-owned.
 *
 * Two rules, deliberately not merged:
 *
 * - The **column-shaped** clauses are absolute. `id` (primary key), identity
 *   columns, `tenant_id`, `created_at` and `updated_at` are server-managed at
 *   create AND update. They cannot be folded into the authored flag below:
 *   `tenant_id` is injected by the manifest compiler and has no authoring field
 *   at all (no `sourceField`), so no YAML property could ever cover it, and the
 *   `_base.yaml` timestamps must stay unsettable on create, which an
 *   update-only flag does not achieve.
 * - The **authored** clause carries `immutable: true` from the field YAML. It
 *   bites on update only: the value is a caller's to set once and the server's
 *   to protect thereafter.
 *
 * Authored `readOnly` is NOT consulted here — in this vocabulary it selects a
 * display component over an input one (docs/mcp.md, #180).
 */
export function isWritableColumn(
  column: GeneratedCrudColumn,
  operation: "create" | "update",
) {
  return (
    !column.primaryKey &&
    column.generated !== "identity" &&
    column.name !== "tenant_id" &&
    column.name !== "created_at" &&
    column.name !== "updated_at" &&
    !(operation === "update" && column.immutable === true)
  );
}

/**
 * Caller-facing transports must never accept the field populated by secure
 * create-time elicitation. Runtime-owned writes keep using isWritableColumn
 * directly because OAuth and configuration handoffs legitimately persist it.
 */
export function isCallerWritableColumn(
  table: GeneratedCrudTable,
  column: GeneratedCrudColumn,
  operation: "create" | "update",
) {
  return (
    isWritableColumn(column, operation) &&
    !isElicitedOutputColumn(table, column)
  );
}

function assertNoCallerElicitedOutput(
  table: GeneratedCrudTable,
  input: Record<string, unknown>,
): void {
  const column = elicitedOutputColumn(table);
  if (!column) return;
  const field = fieldNameForColumn(column);
  if (
    Object.prototype.hasOwnProperty.call(input, field) ||
    Object.prototype.hasOwnProperty.call(input, column.name)
  ) {
    throw generatedCrudError(
      "Securely collected values cannot be supplied through generated CRUD.",
      "BAD_USER_INPUT",
      400,
    );
  }
}

function writableColumnMap(
  table: GeneratedCrudTable,
  operation: "create" | "update",
) {
  return new Map(
    table.columns
      .filter((column) => isWritableColumn(column, operation))
      .map((column) => [fieldNameForColumn(column), column]),
  );
}

function normalizeWritableValues(
  table: GeneratedCrudTable,
  input: Record<string, unknown>,
  operation: "create" | "update",
) {
  const writable = writableColumnMap(table, operation);
  const values = new Map<GeneratedCrudColumn, unknown>();
  for (const [field, value] of Object.entries(input)) {
    if (field === "id") {
      continue;
    }
    const column = writable.get(field);
    if (!column || value === undefined) {
      continue;
    }
    values.set(column, value);
  }
  return values;
}

/**
 * Role-ungated create for RUNTIME surfaces (not callers), mirroring
 * listGeneratedEntitiesForTable: tenant scoping still applies via
 * withDbSession, but the entity-role gate is absent — the OAuth callback
 * writes the personal connection row on behalf of a person who holds none
 * of the entity's CRUD roles. Every caller-facing path must keep going
 * through createGeneratedEntity.
 */
export async function createGeneratedEntityForTable(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  rawValues: Record<string, unknown>,
): Promise<GeneratedEntityRow> {
  const values = normalizeWritableValues(table, rawValues, "create");
  return insertGeneratedRow(db, session, table, values);
}

/** Role-ungated update counterpart; same contract as the create above. */
export async function updateGeneratedEntityForTable(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  rawValues: Record<string, unknown>,
): Promise<GeneratedEntityRow | null> {
  const values = normalizeWritableValues(table, rawValues, "update");
  return applyGeneratedRowUpdate(db, session, table, id, values);
}

/**
 * Merge an object field entirely inside PostgreSQL. Runtime flows use this to
 * preserve encrypted siblings without reading their storage representation
 * back through the shared CRUD output boundary.
 */
export async function mergeGeneratedEntityObjectForTable(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  field: string,
  patch: Record<string, unknown>,
): Promise<GeneratedEntityRow | null> {
  const column = writableColumnMap(table, "update").get(field);
  if (!column || column.type !== "jsonb") {
    throw generatedCrudError(
      "Generated CRUD object-merge metadata is invalid.",
      "INTERNAL_SERVER_ERROR",
      500,
    );
  }
  const values = new Map<GeneratedCrudColumn, unknown>([
    [
      column,
      sql`coalesce(${sql.id(column.name)}, '{}'::jsonb) || ${jsonbLiteral(
        patch,
      )}`,
    ],
  ]);
  return applyGeneratedRowUpdate(db, session, table, id, values);
}

/**
 * Trusted MCP counterpart used only after collectElicitedValues completed.
 * It retains the normal caller role gate but deliberately permits the one
 * server-populated target that public CRUD rejects.
 */
export async function createGeneratedEntityAfterElicitation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: {
    table: string;
    values: Record<string, unknown>;
    into: string;
  },
): Promise<GeneratedEntityRow> {
  const table = readGeneratedCrudTable(input.table, "create", session);
  const column = elicitedOutputColumn(table);
  if (!column || fieldNameForColumn(column) !== input.into) {
    throw generatedCrudError(
      "Generated CRUD elicitation metadata is invalid.",
      "INTERNAL_SERVER_ERROR",
      500,
    );
  }
  const values = normalizeWritableValues(table, input.values, "create");
  return insertGeneratedRow(db, session, table, values);
}

export async function createGeneratedEntity(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: {
    table: string;
    values: Record<string, unknown>;
  },
): Promise<GeneratedEntityRow> {
  const table = readGeneratedCrudTable(input.table, "create", session);
  assertNoCallerElicitedOutput(table, input.values);
  const values = normalizeWritableValues(table, input.values, "create");
  return insertGeneratedRow(db, session, table, values);
}

function insertGeneratedRow(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  values: ReturnType<typeof normalizeWritableValues>,
): Promise<GeneratedEntityRow> {
  return withDbSession(db, session, async (trx, dbSession) => {
    const columns = [...values.keys()];
    const sqlValues = [...values.values()];
    const tenantColumn = table.columns.find((column) => column.name === "tenant_id");
    if (table.tenantScoped && tenantColumn) {
      columns.push(tenantColumn);
      sqlValues.push(dbSession.tenantId);
    }

    const result = await sql<{ row: GeneratedEntityRow }>`
      insert into ${sql.id(table.schema, table.table)}
        (${sql.join(columns.map((column) => sql.id(column.name)))})
      values
        (${sql.join(sqlValues)})
      returning to_jsonb(${sql.id(table.table)}.*) as row
    `.execute(trx);

    const row = result.rows[0]?.row;
    if (!row) {
      throw generatedCrudError("Generated entity create did not return a row.", "INTERNAL_SERVER_ERROR");
    }
    await appendGeneratedCrudEvent(trx, table, {
      aggregateId: generatedCrudAggregateId(table, row),
      eventType: "created",
    });
    return projectGeneratedEntityRow(table, session, row);
  }).catch((error) => {
    throw translateDatabaseError(table, error);
  });
}

export async function updateGeneratedEntity(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: {
    table: string;
    id: string;
    values: Record<string, unknown>;
  },
): Promise<GeneratedEntityRow | null> {
  const table = readGeneratedCrudTable(input.table, "update", session);
  assertNoCallerElicitedOutput(table, input.values);
  const values = normalizeWritableValues(table, input.values, "update");
  return applyGeneratedRowUpdate(db, session, table, input.id, values);
}

async function applyGeneratedRowUpdate(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  values: ReturnType<typeof normalizeWritableValues>,
): Promise<GeneratedEntityRow | null> {
  const updatedAt = table.columns.find((column) => column.name === "updated_at");
  const assignments = [...values.entries()].map(([column, value]) =>
    sql`${sql.id(column.name)} = ${value}`,
  );
  if (updatedAt) {
    assignments.push(sql`${sql.id(updatedAt.name)} = now()`);
  }

  if (assignments.length === 0) {
    // Already authorized as an update above; an empty-body update must not
    // additionally require the read role, so fetch without re-gating and then
    // apply the same output projection as every other return path.
    const row = await fetchGeneratedEntityRow(db, session, table, id);
    return row === null ? null : projectGeneratedEntityRow(table, session, row);
  }

  return withDbSession(db, session, async (trx) => {
    const tenantWhere =
      table.tenantScoped ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}` : sql``;
    const result = await sql<{ row: GeneratedEntityRow }>`
      update ${sql.id(table.schema, table.table)}
      set ${sql.join(assignments)}
      where ${sql.id(table.primaryKey!)}::text = ${id}
        ${tenantWhere}
      returning to_jsonb(${sql.id(table.table)}.*) as row
    `.execute(trx);

    const row = result.rows[0]?.row ?? null;
    if (!row) {
      return null;
    }
    await appendGeneratedCrudEvent(trx, table, {
      aggregateId: generatedCrudAggregateId(table, row),
      eventType: "updated",
    });
    return projectGeneratedEntityRow(table, session, row);
  }).catch((error) => {
    throw translateDatabaseError(table, error);
  });
}

export async function deleteGeneratedEntity(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: {
    table: string;
    id: string;
  },
): Promise<boolean> {
  const table = readGeneratedCrudTable(input.table, "delete", session);

  return withDbSession(db, session, async (trx) => {
    const tenantWhere =
      table.tenantScoped ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}` : sql``;
    const result = await sql<{ row: GeneratedEntityRow }>`
      delete from ${sql.id(table.schema, table.table)}
      where ${sql.id(table.primaryKey!)}::text = ${input.id}
        ${tenantWhere}
      returning to_jsonb(${sql.id(table.table)}.*) as row
    `.execute(trx);

    const row = result.rows[0]?.row ?? null;
    if (!row) {
      return false;
    }
    await appendGeneratedCrudEvent(trx, table, {
      aggregateId: generatedCrudAggregateId(table, row),
      eventType: "deleted",
    });
    return true;
  }).catch((error) => {
    throw translateDatabaseError(table, error);
  });
}

type RelationInput = {
  parent: GeneratedEntityRow;
  parentTable: GeneratedCrudTable;
  relationship: GeneratedCrudRelationship;
  targetTable: GeneratedCrudTable;
  limit?: number | null;
  includeTotalCount?: boolean;
};

export async function listGeneratedEntityRelation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: RelationInput & { includeTotalCount: true },
): Promise<CountedEntityConnection>;
export async function listGeneratedEntityRelation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: RelationInput,
): Promise<GeneratedEntityConnection>;
export async function listGeneratedEntityRelation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: RelationInput,
): Promise<GeneratedEntityConnection> {
  // Relationship traversal reads TARGET rows via the private list helper,
  // bypassing readGeneratedCrudTable — gate the target's read roles here,
  // before the degenerate empty-connection early-returns. The parent needs
  // no check: its row was only obtainable through a read-gated query.
  requireEntityOperation(
    input.targetTable,
    input.relationship.resolve === "belongsTo" ? "get" : "list",
    session,
  );
  // An empty connection still answers a requested count — with 0, not null.
  const emptyCount = input.includeTotalCount ? 0 : null;
  const relationship = input.relationship;
  if (!relationship.foreignKey) {
    return { rows: [], nextCursor: null, totalCount: emptyCount };
  }

  if (relationship.resolve === "belongsTo") {
    const id = input.parent[relationship.foreignKey];
    if (id == null) {
      return { rows: [], nextCursor: null, totalCount: emptyCount };
    }
    return listGeneratedEntitiesForTable(db, session, input.targetTable, {
      limit: 1,
      fixedWhere: [{ column: input.targetTable.primaryKey!, value: id }],
      ...(input.includeTotalCount ? { includeTotalCount: true } : {}),
    });
  }

  const parentPrimaryKey = input.parentTable.primaryKey;
  const parentId = parentPrimaryKey == null ? null : input.parent[parentPrimaryKey];
  if (parentId == null) {
    return { rows: [], nextCursor: null, totalCount: emptyCount };
  }
  const targetDefaultSort = readableDefaultSort(input.targetTable, session);
  return listGeneratedEntitiesForTable(db, session, input.targetTable, {
    limit: input.limit ?? 50,
    fixedWhere: [{ column: relationship.foreignKey, value: parentId }],
    ...(input.includeTotalCount ? { includeTotalCount: true } : {}),
    ...(targetDefaultSort
      ? { sort: { field: targetDefaultSort.field, direction: targetDefaultSort.direction } }
      : {}),
  });
}

/**
 * The embedded-list default sort comes from the compiler, not the caller, so
 * it is not an input to reject — but ordering by a column the reader may not
 * see is the same oracle assertClassifiedQueryAllowed refuses on the list
 * entry point. Drop it (falling back to primary-key order) instead of failing
 * an otherwise legitimate traversal.
 */
function readableDefaultSort(table: GeneratedCrudTable, session: DbSessionInput) {
  const sort = table.source?.graphql?.defaultSort;
  if (!sort) return undefined;
  const column = fieldColumnMap(table).get(sort.field);
  if (column && isElicitedOutputColumn(table, column)) return undefined;
  if (canReadClassifiedColumns(table.source?.authorization, session)) return sort;
  return column?.classification ? undefined : sort;
}
