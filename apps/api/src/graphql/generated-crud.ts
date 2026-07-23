import manifest from "../generated/db/manifest.json" with { type: "json" };
import { GraphQLError } from "graphql";
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import { appendScopedEntityEventInTransaction } from "../platform/entity-events.js";

type GeneratedCrudTable = {
  name: string;
  schema: string;
  table: string;
  tenantScoped: boolean;
  domainInternal: boolean;
  generatedCrud: boolean;
  primaryKey: string | null;
  columns: GeneratedCrudColumn[];
  source?: {
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
  };
};

type GeneratedCrudColumn = {
  name: string;
  type: string;
  required: boolean;
  primaryKey: boolean;
  generated: string | null;
  sourceField?: string;
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
   * Total number of rows matching the filter, or null when the caller did not
   * request it. Computing this runs a second count(*) over the same predicate,
   * so it is opt-in (see `includeTotal`) to avoid an unbounded scan on every
   * page fetch (issue #17).
   */
  totalCount: number | null;
};

const generatedCrudTables = new Map(
  (manifest.tables as GeneratedCrudTable[])
    .filter((table) => table.generatedCrud && !table.domainInternal && table.primaryKey)
    .map((table) => [table.name, table]),
);

export function isGeneratedCrudTableReadable(name: string) {
  return generatedCrudTables.has(name);
}

export function getGeneratedCrudTables() {
  return [...generatedCrudTables.values()];
}

function generatedCrudError(message: string, code: string) {
  return new GraphQLError(message, {
    extensions: { code },
  });
}

function readGeneratedCrudTable(name: string) {
  const table = generatedCrudTables.get(name);
  if (!table || !table.primaryKey) {
    throw generatedCrudError(
      `Generated CRUD is not enabled for ${name}.`,
      "GENERATED_CRUD_NOT_ENABLED",
    );
  }
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
  const requested = sort?.field ? fields.get(sort.field) : undefined;
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

async function listGeneratedEntitiesForTable(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  input: {
    limit?: number | null;
    cursor?: string | null;
    filter?: Record<string, unknown> | null;
    sort?: { field?: string | null; direction?: string | null } | null;
    fixedWhere?: Array<{ column: string; value: unknown }>;
    includeTotal?: boolean;
  },
): Promise<GeneratedEntityConnection> {
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

    // The count is a second scan over the same (possibly unindexable) predicate,
    // so only run it when the caller asked for the total. Otherwise a page fetch
    // would always pay for a full scan (issue #17).
    let totalCount: number | null = null;
    if (input.includeTotal) {
      const countResult = await sql<{ total_count: string | number }>`
        select count(*) as total_count
        from ${sql.id(table.schema, table.table)} as row_source
        where ${where}
      `.execute(trx);
      totalCount = Number(countResult.rows[0]?.total_count ?? 0);
    }

    const rows = result.rows.slice(0, limit).map((row) => row.row);
    return {
      rows,
      totalCount,
      nextCursor:
        result.rows.length > limit ? encodeOffsetCursor(offset + limit) : null,
    };
  });
}

export async function listGeneratedEntities(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: {
    table: string;
    limit?: number | null;
    cursor?: string | null;
    filter?: Record<string, unknown> | null;
    sort?: { field?: string | null; direction?: string | null } | null;
    includeTotal?: boolean;
  },
): Promise<GeneratedEntityConnection> {
  const table = readGeneratedCrudTable(input.table);
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
  const table = readGeneratedCrudTable(input.table);

  return withDbSession(db, session, async (trx) => {
    const tenantWhere =
      table.tenantScoped
        ? sql`and ${sql.id("row_source", "tenant_id")} = ${session.tenantId}`
        : sql``;
    const result = await sql<{ row: GeneratedEntityRow }>`
      select to_jsonb(row_source.*) as row
      from ${sql.id(table.schema, table.table)} as row_source
      where ${sql.id("row_source", table.primaryKey!)}::text = ${input.id}
        ${tenantWhere}
      limit 1
    `.execute(trx);

    return result.rows[0]?.row ?? null;
  });
}

function writableColumnMap(table: GeneratedCrudTable) {
  return new Map(
    table.columns
      .filter((column) =>
        !column.primaryKey &&
        column.generated !== "identity" &&
        column.name !== "tenant_id" &&
        column.name !== "created_at" &&
        column.name !== "updated_at",
      )
      .map((column) => [fieldNameForColumn(column), column]),
  );
}

function normalizeWritableValues(
  table: GeneratedCrudTable,
  input: Record<string, unknown>,
) {
  const writable = writableColumnMap(table);
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

export async function createGeneratedEntity(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: {
    table: string;
    values: Record<string, unknown>;
  },
): Promise<GeneratedEntityRow> {
  const table = readGeneratedCrudTable(input.table);
  const values = normalizeWritableValues(table, input.values);

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
    return row;
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
  const table = readGeneratedCrudTable(input.table);
  const values = normalizeWritableValues(table, input.values);
  const updatedAt = table.columns.find((column) => column.name === "updated_at");
  const assignments = [...values.entries()].map(([column, value]) =>
    sql`${sql.id(column.name)} = ${value}`,
  );
  if (updatedAt) {
    assignments.push(sql`${sql.id(updatedAt.name)} = now()`);
  }

  if (assignments.length === 0) {
    return getGeneratedEntity(db, session, { table: table.name, id: input.id });
  }

  return withDbSession(db, session, async (trx) => {
    const tenantWhere =
      table.tenantScoped ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}` : sql``;
    const result = await sql<{ row: GeneratedEntityRow }>`
      update ${sql.id(table.schema, table.table)}
      set ${sql.join(assignments)}
      where ${sql.id(table.primaryKey!)}::text = ${input.id}
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
    return row;
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
  const table = readGeneratedCrudTable(input.table);

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
  });
}

export async function listGeneratedEntityRelation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: {
    parent: GeneratedEntityRow;
    relationship: GeneratedCrudRelationship;
    targetTable: GeneratedCrudTable;
    limit?: number | null;
    includeTotal?: boolean;
  },
): Promise<GeneratedEntityConnection> {
  const relationship = input.relationship;
  if (!relationship.foreignKey) {
    return { rows: [], nextCursor: null, totalCount: input.includeTotal ? 0 : null };
  }

  if (relationship.resolve === "belongsTo") {
    const id = input.parent[relationship.foreignKey];
    if (id == null) {
      return { rows: [], nextCursor: null, totalCount: input.includeTotal ? 0 : null };
    }
    return listGeneratedEntitiesForTable(db, session, input.targetTable, {
      limit: 1,
      fixedWhere: [{ column: input.targetTable.primaryKey!, value: id }],
      ...(input.includeTotal ? { includeTotal: true } : {}),
    });
  }

  const parentId = input.parent.id;
  if (parentId == null) {
    return { rows: [], nextCursor: null, totalCount: input.includeTotal ? 0 : null };
  }
  const targetDefaultSort = input.targetTable.source?.graphql?.defaultSort;
  return listGeneratedEntitiesForTable(db, session, input.targetTable, {
    limit: input.limit ?? 50,
    fixedWhere: [{ column: relationship.foreignKey, value: parentId }],
    ...(input.includeTotal ? { includeTotal: true } : {}),
    ...(targetDefaultSort
      ? { sort: { field: targetDefaultSort.field, direction: targetDefaultSort.direction } }
      : {}),
  });
}
