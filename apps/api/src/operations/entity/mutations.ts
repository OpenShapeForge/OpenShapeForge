// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import {
  appendGeneratedCrudEvent,
  elicitedOutputColumn,
  generatedCrudAggregateId,
  generatedCrudError,
  projectGeneratedEntityRow,
  readGeneratedCrudTable,
  translateDatabaseError,
} from "./catalog.js";
import { fieldNameForColumn } from "./columns.js";
import { fetchGeneratedEntityRow } from "./queries.js";
import type {
  GeneratedCrudColumn,
  GeneratedCrudTable,
  GeneratedEntityRow,
} from "./types.js";
import {
  assertNoCallerElicitedOutput,
  assertNoOperationWrittenValues,
  normalizeWritableValues,
  writableColumnMap,
} from "./write-policy.js";

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
  assertNoOperationWrittenValues(table, input.values);
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
  assertNoOperationWrittenValues(table, input.values);
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
