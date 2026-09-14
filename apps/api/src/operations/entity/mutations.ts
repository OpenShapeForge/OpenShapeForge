// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DB } from "../../generated/db/types.js";
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
import { normalizeTimestampToken } from "../../db/timestamps.js";
import {
  consumeEntityConfirmationInTransaction,
  type ChallengeProtectedOperation,
} from "./confirmation-challenges.js";
import {
  consumeEntityEditLeaseInTransaction,
  type LeaseProtectedOperation,
} from "./edit-leases.js";
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
import {
  assertCreateRecordPermissions,
  assertRecordPermissionInTransaction,
  assertUpdateRecordPermissions,
} from "./record-permissions.js";

async function fetchGeneratedRowInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
): Promise<GeneratedEntityRow | null> {
  const tenantWhere = table.tenantScoped
    ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}`
    : sql``;
  const result = await sql<{ row: GeneratedEntityRow }>`
    select to_jsonb(${sql.id(table.table)}.*) as row
    from ${sql.id(table.schema, table.table)}
    where ${sql.id(table.primaryKey!)}::text = ${id}
      ${tenantWhere}
    limit 1
  `.execute(trx);
  return result.rows[0]?.row ?? null;
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
  assertCreateRecordPermissions(table, session, rawValues);
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
  assertUpdateRecordPermissions(table, rawValues);
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
    );
  }
  assertCreateRecordPermissions(table, session, input.values);
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
  assertCreateRecordPermissions(table, session, input.values);
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
      row,
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
    guard?: {
      operation: ChallengeProtectedOperation & LeaseProtectedOperation;
      expectedVersion: string;
      leaseToken?: string;
      confirmationToken?: string;
      confirmationAnswer?: string;
    };
  },
): Promise<GeneratedEntityRow | null> {
  const table = readGeneratedCrudTable(input.table, "update", session);
  assertNoCallerElicitedOutput(table, input.values);
  assertNoOperationWrittenValues(table, input.values);
  assertUpdateRecordPermissions(table, input.values);
  const values = normalizeWritableValues(table, input.values, "update");
  return applyGeneratedRowUpdate(db, session, table, input.id, values, input.guard);
}

async function applyGeneratedRowUpdate(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  values: ReturnType<typeof normalizeWritableValues>,
  guard?: {
    operation: ChallengeProtectedOperation & LeaseProtectedOperation;
    expectedVersion: string;
    leaseToken?: string;
    confirmationToken?: string;
    confirmationAnswer?: string;
  },
): Promise<GeneratedEntityRow | null> {
  const updatedAt = table.columns.find((column) => column.name === "updated_at");
  const assignments = [...values.entries()].map(([column, value]) =>
    sql`${sql.id(column.name)} = ${value}`,
  );
  if (updatedAt) {
    assignments.push(sql`${sql.id(updatedAt.name)} = now()`);
  }

  if (
    assignments.length === 0 &&
    !guard &&
    !table.source?.authorization?.recordPermissions
  ) {
    // Already authorized as an update above; an empty-body update must not
    // additionally require the read role, so fetch without re-gating and then
    // apply the same output projection as every other return path.
    const row = await fetchGeneratedEntityRow(db, session, table, id);
    return row === null ? null : projectGeneratedEntityRow(table, session, row);
  }

  return withDbSession(db, session, async (trx) => {
    if (table.source?.authorization?.recordPermissions) {
      await assertRecordPermissionInTransaction(trx, session, table, id, "edit");
    }
    if (guard?.operation.concurrency?.editLease) {
      if (!guard.leaseToken) {
        throw generatedCrudError(
          "A valid edit lease is required for this operation.",
          "LEASE_INVALID",
        );
      }
      await consumeEntityEditLeaseInTransaction(trx, session, {
        operation: guard.operation,
        targetId: id,
        expectedVersion: guard.expectedVersion,
        leaseToken: guard.leaseToken,
      });
    }
    if (guard?.confirmationToken && guard.confirmationAnswer) {
      await consumeEntityConfirmationInTransaction(trx, session, {
        operation: guard.operation,
        targetId: id,
        expectedVersion: guard.expectedVersion,
        confirmationToken: guard.confirmationToken,
        confirmationAnswer: guard.confirmationAnswer,
      });
    }
    const tenantWhere =
      table.tenantScoped ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}` : sql``;
    const versionField = guard?.operation.concurrency?.version?.field;
    const versionColumn = versionField
      ? table.columns.find((column) => fieldNameForColumn(column) === versionField)
      : undefined;
    if (guard && !versionColumn) {
      throw generatedCrudError(
        "Generated entity version metadata is invalid.",
        "INTERNAL_SERVER_ERROR",
      );
    }
    const expectedVersionWhere = guard && versionColumn
      ? sql`and ${sql.id(versionColumn.name)} = ${normalizeTimestampToken(guard.expectedVersion)}::timestamptz`
      : sql``;

    if (assignments.length === 0) {
      const unchanged = await sql<{ row: GeneratedEntityRow }>`
        select to_jsonb(${sql.id(table.table)}.*) as row
        from ${sql.id(table.schema, table.table)}
        where ${sql.id(table.primaryKey!)}::text = ${id}
          ${tenantWhere}
          ${expectedVersionWhere}
      `.execute(trx);
      if (unchanged.rows[0]) {
        return projectGeneratedEntityRow(table, session, unchanged.rows[0].row);
      }
      const current = await fetchGeneratedRowInTransaction(trx, session, table, id);
      if (current) {
        throw generatedCrudError(
          "The record has changed since it was loaded. Reload it before saving.",
          "VERSION_CONFLICT",
        );
      }
      return null;
    }
    const result = await sql<{ row: GeneratedEntityRow }>`
      update ${sql.id(table.schema, table.table)}
      set ${sql.join(assignments)}
      where ${sql.id(table.primaryKey!)}::text = ${id}
        ${tenantWhere}
        ${expectedVersionWhere}
      returning to_jsonb(${sql.id(table.table)}.*) as row
    `.execute(trx);

    const row = result.rows[0]?.row ?? null;
    if (!row) {
      const current = guard
        ? await fetchGeneratedRowInTransaction(trx, session, table, id)
        : null;
      if (current) {
        throw generatedCrudError(
          "The record has changed since it was loaded. Reload it before saving.",
          "VERSION_CONFLICT",
        );
      }
      return null;
    }
    await appendGeneratedCrudEvent(trx, table, {
      aggregateId: generatedCrudAggregateId(table, row),
      eventType: "updated",
      row,
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
    guard?: {
      operation: ChallengeProtectedOperation & LeaseProtectedOperation;
      expectedVersion: string;
      leaseToken?: string;
      confirmationToken?: string;
      confirmationAnswer?: string;
    };
  },
): Promise<boolean> {
  const table = readGeneratedCrudTable(input.table, "delete", session);

  return withDbSession(db, session, async (trx) => {
    if (table.source?.authorization?.recordPermissions) {
      await assertRecordPermissionInTransaction(trx, session, table, input.id, "delete");
    }
    if (input.guard?.operation.concurrency?.editLease) {
      if (!input.guard.leaseToken) {
        throw generatedCrudError(
          "A valid edit lease is required for this operation.",
          "LEASE_INVALID",
        );
      }
      await consumeEntityEditLeaseInTransaction(trx, session, {
        operation: input.guard.operation,
        targetId: input.id,
        expectedVersion: input.guard.expectedVersion,
        leaseToken: input.guard.leaseToken,
      });
    }
    if (input.guard?.confirmationToken && input.guard.confirmationAnswer) {
      await consumeEntityConfirmationInTransaction(trx, session, {
        operation: input.guard.operation,
        targetId: input.id,
        expectedVersion: input.guard.expectedVersion,
        confirmationToken: input.guard.confirmationToken,
        confirmationAnswer: input.guard.confirmationAnswer,
      });
    }
    const tenantWhere =
      table.tenantScoped ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}` : sql``;
    const versionField = input.guard?.operation.concurrency?.version?.field;
    const versionColumn = versionField
      ? table.columns.find((column) => fieldNameForColumn(column) === versionField)
      : undefined;
    if (input.guard && !versionColumn) {
      throw generatedCrudError(
        "Generated entity version metadata is invalid.",
        "INTERNAL_SERVER_ERROR",
      );
    }
    const expectedVersionWhere = input.guard && versionColumn
      ? sql`and ${sql.id(versionColumn.name)} = ${normalizeTimestampToken(input.guard.expectedVersion)}::timestamptz`
      : sql``;
    const result = await sql<{ row: GeneratedEntityRow }>`
      delete from ${sql.id(table.schema, table.table)}
      where ${sql.id(table.primaryKey!)}::text = ${input.id}
        ${tenantWhere}
        ${expectedVersionWhere}
      returning to_jsonb(${sql.id(table.table)}.*) as row
    `.execute(trx);

    const row = result.rows[0]?.row ?? null;
    if (!row) {
      const current = input.guard
        ? await fetchGeneratedRowInTransaction(trx, session, table, input.id)
        : null;
      if (current) {
        throw generatedCrudError(
          "The record has changed since it was loaded. Reload it before deleting.",
          "VERSION_CONFLICT",
        );
      }
      return false;
    }
    await appendGeneratedCrudEvent(trx, table, {
      aggregateId: generatedCrudAggregateId(table, row),
      eventType: "deleted",
      row,
    });
    return true;
  }).catch((error) => {
    throw translateDatabaseError(table, error);
  });
}
