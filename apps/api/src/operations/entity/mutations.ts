// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DB } from "../../generated/db/types.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import { operationFailure } from "@openshapeforge/operations";
import { collectionMutationError, ownedCollectionsOf } from "./collection-policy.js";
import { entityValueCarriers, prepareEntityValueWriteInTransaction, type EntityValueIOContext } from "./entity-value-io.js";
import { getGeneratedCrudTables } from "./catalog.js";
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
import { draftOwningHead, draftRule } from "./versioned-head.js";
import {
  assertCreateRecordPermissions,
  assertRecordPermissionInTransaction,
  assertUpdateRecordPermissions,
} from "./record-permissions.js";
import {
  derivedOnCreateColumn,
  derivedSlugCandidate,
  maxDerivedIdentifierAttempts,
} from "./derive-on-create.js";
import { assertRelationshipConstraintsInTransaction } from "./relationship-constraints.js";
import { assertPublishableRelatedMutationInTransaction } from "./derived-execution-guards.js";

async function fetchGeneratedRowInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  lock = false,
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
    ${lock ? sql`for update` : sql``}
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
  entityValues: EntityValueIOContext = {},
): Promise<GeneratedEntityRow> {
  assertCreateRecordPermissions(table, session, rawValues);
  const values = normalizeWritableValues(table, rawValues, "create", entityValues.registry);
  return insertGeneratedRow(db, session, table, values, entityValues);
}

/** Role-ungated update counterpart; same contract as the create above. */
export async function updateGeneratedEntityForTable(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  rawValues: Record<string, unknown>,
  entityValues: EntityValueIOContext = {},
  guard?: Parameters<typeof updateGeneratedEntity>[2]["guard"],
): Promise<GeneratedEntityRow | null> {
  assertUpdateRecordPermissions(table, rawValues);
  const values = normalizeWritableValues(table, rawValues, "update", entityValues.registry);
  return applyGeneratedRowUpdate(db, session, table, id, values, guard, entityValues);
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
  if (entityValueCarriers(table).some((carrier) => carrier.fieldKey === field)) throw generatedCrudError("Entity values require a canonical whole-value update.", "BAD_USER_INPUT");
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
  const unsupported = collectionMutationError(table, "create", getGeneratedCrudTables(), input.values);
  if (unsupported) throw operationFailure(unsupported);
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
  const unsupported = collectionMutationError(table, "create", getGeneratedCrudTables(), input.values);
  if (unsupported) throw operationFailure(unsupported);
  assertNoCallerElicitedOutput(table, input.values);
  assertNoOperationWrittenValues(table, input.values);
  assertCreateRecordPermissions(table, session, input.values);
  const values = normalizeWritableValues(table, input.values, "create");
  return insertGeneratedRow(db, session, table, values);
}

function fieldRow(table: GeneratedCrudTable, row: GeneratedEntityRow): Record<string, unknown> {
  return Object.fromEntries(
    table.columns.map((column) => [fieldNameForColumn(column), row[column.name]]),
  );
}

function fieldValues(
  prepared: Map<GeneratedCrudColumn, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    [...prepared.entries()].map(([column, value]) => [fieldNameForColumn(column), value]),
  );
}

function insertGeneratedRow(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  values: ReturnType<typeof normalizeWritableValues>,
  entityValues: EntityValueIOContext = {},
): Promise<GeneratedEntityRow> {
  return withDbSession(db, session, (trx, dbSession) => insertGeneratedRowInTransaction(trx, dbSession, table, values, entityValues)).catch((error) => {
    throw translateDatabaseError(table, error);
  });
}

/** Trusted transaction-owned create; the caller must gate the authored Operation first. */
export async function createGeneratedEntityInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  rawValues: Record<string, unknown>,
  entityValues: EntityValueIOContext = {},
): Promise<GeneratedEntityRow> {
  assertCreateRecordPermissions(table, session, rawValues);
  return insertGeneratedRowInTransaction(trx, session, table, normalizeWritableValues(table, rawValues, "create", entityValues.registry), entityValues);
}

async function insertGeneratedRowInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  values: ReturnType<typeof normalizeWritableValues>,
  entityValues: EntityValueIOContext = {},
): Promise<GeneratedEntityRow> {
  const prepared = await prepareEntityValueWriteInTransaction(trx, session, table, values, "create", undefined, entityValues);
  await assertRelationshipConstraintsInTransaction(trx, session, table, prepared);
  await assertPublishableRelatedMutationInTransaction(trx, session, table, {
    kind: "create",
    values: fieldValues(prepared),
  }, {
    ...(entityValues.tables ? { tables: entityValues.tables } : {}),
    ...(entityValues.derivedTools ? { entries: entityValues.derivedTools } : {}),
  });
  const derivedColumn = derivedOnCreateColumn(table);
  const derivation = derivedColumn?.deriveOnCreate;
  const tenantColumn = table.columns.find((column) => column.name === "tenant_id");
  const attempts = derivation ? maxDerivedIdentifierAttempts() : 1;
  let row: GeneratedEntityRow | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const candidateValues = new Map(prepared);
    if (derivedColumn && derivation) {
      const sourceColumn = table.columns.find((column) => column.name === derivation.sourceColumn);
      if (!sourceColumn || !candidateValues.has(sourceColumn)) {
        throw generatedCrudError(
          "Generated CRUD derivation metadata does not resolve to a submitted source field.",
          "INTERNAL_SERVER_ERROR",
        );
      }
      candidateValues.set(
        derivedColumn,
        derivedSlugCandidate(candidateValues.get(sourceColumn), attempt, derivation.maxLength),
      );
    }
    const columns = [...candidateValues.keys()];
    const sqlValues = [...candidateValues.values()];
    if (table.tenantScoped && tenantColumn) {
      columns.push(tenantColumn);
      sqlValues.push(session.tenantId);
    }
    const conflict = derivation
      ? sql`on conflict (${sql.join(derivation.conflictColumns.map((column) => sql.id(column)))}) do nothing`
      : sql``;
    const result = await sql<{ row: GeneratedEntityRow }>`
      insert into ${sql.id(table.schema, table.table)}
        (${sql.join(columns.map((column) => sql.id(column.name)))})
      values
        (${sql.join(sqlValues)})
      ${conflict}
      returning to_jsonb(${sql.id(table.table)}.*) as row
    `.execute(trx);
    row = result.rows[0]?.row;
    if (row) break;
  }

  if (!row) {
    throw generatedCrudError(
      derivation
        ? "Generated CRUD could not allocate a unique derived identifier."
        : "Generated entity create did not return a row.",
      "INTERNAL_SERVER_ERROR",
    );
  }
  // A new row under a versioned head is a content change of that head. The
  // public create refuses an owned child (collectionMutationError), so this
  // covers the in-transaction create the collection insert runs.
  await draftOwningHead(trx, entityValues.tables ?? getGeneratedCrudTables(), table, row);
  await appendGeneratedCrudEvent(trx, table, {
    aggregateId: generatedCrudAggregateId(table, row),
    eventType: "created",
    row,
  }, entityValues.registry);
  return projectGeneratedEntityRow(table, session, row, entityValues.registry);
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
  const unsupported = collectionMutationError(table, "update", getGeneratedCrudTables(), input.values);
  if (unsupported) throw operationFailure(unsupported);
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
  entityValues: EntityValueIOContext = {},
): Promise<GeneratedEntityRow | null> {
  const updatedAt = table.columns.find((column) => column.name === "updated_at");
  const carriers = entityValueCarriers(table, entityValues.registry);

  if (
    values.size === 0 && !updatedAt && carriers.length === 0 &&
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
    const current = await fetchGeneratedRowInTransaction(trx, session, table, id, true);
    if (carriers.length && !current) return null;
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

    const prepared = await prepareEntityValueWriteInTransaction(trx, session, table, values, "update", current ?? undefined, entityValues);
    await assertRelationshipConstraintsInTransaction(trx, session, table, prepared);
    if (current) {
      await assertPublishableRelatedMutationInTransaction(trx, session, table, {
        kind: "update",
        id,
        before: fieldRow(table, current),
        values: fieldValues(prepared),
      }, {
        ...(entityValues.tables ? { tables: entityValues.tables } : {}),
        ...(entityValues.derivedTools ? { entries: entityValues.derivedTools } : {}),
      });
    }
    const assignments = [...prepared.entries()].map(([column, value]) => sql`${sql.id(column.name)} = ${value}`);
    // A write happens only when a content column actually changes, compared
    // in the database against the locked row: a value supplied as stored, or
    // no value at all, leaves the version token, the draft rule and the
    // event journal alone and returns the row as it is.
    const changes = [...prepared.entries()].map(([column, value]) => sql`${sql.id(column.name)} is distinct from ${value}`);
    const draft = assignments.length ? draftRule(table) : undefined;
    if (draft) assignments.push(sql`${sql.id(draft.column)} = ${draft.value}`);
    if (updatedAt && assignments.length) assignments.push(sql`${sql.id(updatedAt.name)} = ${carriers.length ? sql`greatest(clock_timestamp(), ${sql.id(updatedAt.name)} + interval '1 microsecond')` : sql`now()`}`);

    const unchangedRow = async (): Promise<GeneratedEntityRow | null> => {
      const unchanged = await sql<{ row: GeneratedEntityRow }>`
        select to_jsonb(${sql.id(table.table)}.*) as row
        from ${sql.id(table.schema, table.table)}
        where ${sql.id(table.primaryKey!)}::text = ${id}
          ${tenantWhere}
          ${expectedVersionWhere}
      `.execute(trx);
      if (unchanged.rows[0]) {
        return projectGeneratedEntityRow(table, session, unchanged.rows[0].row, entityValues.registry);
      }
      const current = await fetchGeneratedRowInTransaction(trx, session, table, id);
      if (current) {
        throw generatedCrudError(
          "The record has changed since it was loaded. Reload it before saving.",
          "VERSION_CONFLICT",
        );
      }
      return null;
    };
    if (changes.length === 0) return unchangedRow();
    const result = await sql<{ row: GeneratedEntityRow }>`
      update ${sql.id(table.schema, table.table)}
      set ${sql.join(assignments)}
      where ${sql.id(table.primaryKey!)}::text = ${id}
        ${tenantWhere}
        ${expectedVersionWhere}
        and (${sql.join(changes, sql` or `)})
      returning to_jsonb(${sql.id(table.table)}.*) as row
    `.execute(trx);

    const row = result.rows[0]?.row ?? null;
    if (!row) return unchangedRow();
    await draftOwningHead(trx, entityValues.tables ?? getGeneratedCrudTables(), table, row);
    await appendGeneratedCrudEvent(trx, table, {
      aggregateId: generatedCrudAggregateId(table, row),
      eventType: "updated",
      row,
    }, entityValues.registry);
    return projectGeneratedEntityRow(table, session, row, entityValues.registry);
  }).catch((error) => {
    throw translateDatabaseError(table, error);
  });
}

/**
 * An owner's generic delete never reaches its owned children: while any
 * exist, removal is the owned-collection Operations' job (the FK would
 * otherwise cascade silently). With none, the owner is an ordinary row.
 */
async function assertNoOwnedChildrenInTransaction(
  trx: Transaction<DB>,
  table: GeneratedCrudTable,
  id: string,
): Promise<void> {
  for (const owned of ownedCollectionsOf(table, getGeneratedCrudTables())) {
    const result = await sql<{ exists: boolean }>`
      select exists(
        select 1 from ${sql.id(owned.child.schema, owned.child.table)}
        where ${sql.id(owned.column)}::text = ${id}
      ) as exists
    `.execute(trx);
    if (result.rows[0]?.exists) {
      throw generatedCrudError(
        `Collection mutation of ${owned.key} is not supported by generic delete; an atomic collection Operation is required.`,
        "RELATION_COLLECTION_MUTATION_UNSUPPORTED",
      );
    }
  }
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
  entityValues: EntityValueIOContext = {},
): Promise<boolean> {
  const table = readGeneratedCrudTable(input.table, "delete", session);
  const unsupported = collectionMutationError(table, "delete", getGeneratedCrudTables());
  if (unsupported) throw operationFailure(unsupported);

  return withDbSession(db, session, async (trx) => {
    if (table.source?.authorization?.recordPermissions) {
      await assertRecordPermissionInTransaction(trx, session, table, input.id, "delete");
    }
    await assertNoOwnedChildrenInTransaction(trx, table, input.id);
    const current = await fetchGeneratedRowInTransaction(trx, session, table, input.id, true);
    if (current) {
      await assertPublishableRelatedMutationInTransaction(trx, session, table, {
        kind: "delete",
        id: input.id,
        row: fieldRow(table, current),
      }, {
        ...(entityValues.tables ? { tables: entityValues.tables } : {}),
        ...(entityValues.derivedTools ? { entries: entityValues.derivedTools } : {}),
      });
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
