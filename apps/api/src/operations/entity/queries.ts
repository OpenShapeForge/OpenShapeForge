// SPDX-License-Identifier: BUSL-1.1
import { sql, type RawBuilder } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import {
  assertClassifiedQueryAllowed,
  assertElicitedQueryAllowed,
  generatedCrudError,
  projectGeneratedEntityRow,
  projectRows,
  readGeneratedCrudTable,
  getGeneratedCrudTables,
  requireEntityOperation,
} from "./catalog.js";
import { fieldColumnMap, tableColumnMap } from "./columns.js";
import { resolveComputedEntityRows } from "./computed-fields.js";
import type {
  CountedEntityConnection,
  GeneratedCrudColumn,
  GeneratedCrudTable,
  GeneratedEntityConnection,
  GeneratedEntityRow,
  ListPageInput,
} from "./types.js";

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


function normalizeSortDirection(value: unknown): "asc" | "desc" {
  return typeof value === "string" && value.toLowerCase() === "desc" ? "desc" : "asc";
}

function buildFilterConditions(
  table: GeneratedCrudTable,
  session: DbSessionInput,
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

    const relationship = table.source?.graphql?.relationships?.find((candidate) => candidate.name === key);
    if (relationship && value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "any")) {
      if (relationship.resolve !== "hasMany" || !relationship.foreignKey || !table.primaryKey) {
        throw generatedCrudError(`Relationship filter ${key} is not a supported collection for ${table.name}.`, "BAD_USER_INPUT");
      }
      const any = (value as { any?: unknown }).any;
      if (!any || typeof any !== "object" || Array.isArray(any) || Object.keys(any).length === 0) {
        throw generatedCrudError(`Relationship filter ${key}.any requires exact field constraints.`, "BAD_USER_INPUT");
      }
      const related = getGeneratedCrudTables().find((candidate) => candidate.source?.graphql?.typeName === relationship.target);
      if (!related) throw generatedCrudError(`Relationship filter ${key} has no generated target.`, "INTERNAL_SERVER_ERROR");
      requireEntityOperation(related, "list", session);
      assertClassifiedQueryAllowed(related, session, { filter: any as Record<string, unknown> });
      const relatedFields = fieldColumnMap(related);
      const relatedConditions = [];
      for (const [relatedKey, relatedValue] of Object.entries(any as Record<string, unknown>)) {
        const column = relatedFields.get(relatedKey);
        const eq = relatedValue && typeof relatedValue === "object" && !Array.isArray(relatedValue)
          ? (relatedValue as { eq?: unknown }).eq : undefined;
        if (!column || eq === undefined || Object.keys(relatedValue as object).length !== 1) {
          throw generatedCrudError(`Relationship filter ${key}.any.${relatedKey} supports eq on declared scalar fields only.`, "BAD_USER_INPUT");
        }
        relatedConditions.push(sql`${sql.id("related", column.name)} = ${eq}`);
      }
      if (related.tenantScoped) relatedConditions.push(sql`${sql.id("related", "tenant_id")} = ${session.tenantId}`);
      conditions.push(sql`exists (
        select 1 from ${sql.id(related.schema, related.table)} as related
        where ${sql.id("related", relationship.foreignKey)} = ${sql.id("row_source", table.primaryKey)}
          and ${sql.join(relatedConditions, sql` and `)}
      )`);
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

    const exact = value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "eq")
      ? (value as { eq?: unknown }).eq : undefined;
    if (exact !== undefined) {
      if (Object.keys(value as object).length !== 1) {
        throw generatedCrudError(`Exact filter ${key} accepts eq only.`, "BAD_USER_INPUT");
      }
      conditions.push(sql`${sql.id("row_source", column.name)} = ${exact}`);
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
  relationScope?: { where: RawBuilder<unknown>; orderBy?: RawBuilder<unknown> },
): Promise<GeneratedEntityConnection> {
  // This helper intentionally bypasses entity-role checks for trusted runtime
  // projections, but it must not bypass the value-oracle boundary.
  assertElicitedQueryAllowed(table, input);
  const limit = normalizeLimit(input.limit);
  const offset = decodeOffsetCursor(input.cursor);
  const fixedWhere = [...tenantFixedWhere(table, session), ...(input.fixedWhere ?? [])];
  const ordinaryWhere = buildFilterConditions(table, session, input.filter, fixedWhere);
  const where = relationScope ? sql`(${ordinaryWhere}) and (${relationScope.where})` : ordinaryWhere;
  const orderBy = relationScope?.orderBy ?? buildSortExpression(table, input.sort);

  return withDbSession(db, session, async (trx, resolvedSession) => {
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
    const projectedRows = projectOutput
      ? projectRows(table, session, storageRows)
      : storageRows;
    const rows = projectOutput
      ? await resolveComputedEntityRows(trx, resolvedSession, table, projectedRows)
      : projectedRows;
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
  relationScope?: { where: RawBuilder<unknown>; orderBy?: RawBuilder<unknown> },
): Promise<GeneratedEntityConnection> {
  return listGeneratedEntityRowsForTable(db, session, table, input, true, relationScope);
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
  if (row === null) return null;
  const projected = projectGeneratedEntityRow(table, session, row);
  return withDbSession(db, session, async (trx, resolvedSession) =>
    (await resolveComputedEntityRows(trx, resolvedSession, table, [projected]))[0] ?? null,
  );
}

/**
 * Row fetch WITHOUT the role gate or output projection. Callers must have
 * already authorized the operation that led here and must project before
 * handing the row to a reader.
 */
export async function fetchGeneratedEntityRow(
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
