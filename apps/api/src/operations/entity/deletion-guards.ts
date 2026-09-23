// SPDX-License-Identifier: BUSL-1.1
/** Shared hard-delete eligibility checks derived from the compiled manifest. */
import { sql, type Transaction } from "kysely";
import { operationFailure } from "@openshapeforge/operations";
import type { DB } from "../../generated/db/types.js";
import type { DbSessionInput } from "../../db/session.js";
import type { GeneratedCrudTable, GeneratedEntityRow } from "./types.js";

type Duration = { years?: number; months?: number; days?: number };

function interval(duration: Duration) {
  return sql`make_interval(
    years => ${duration.years ?? 0},
    months => ${duration.months ?? 0},
    days => ${duration.days ?? 0}
  )`;
}

async function assertMinimumElapsed(
  trx: Transaction<DB>,
  table: GeneratedCrudTable,
  row: GeneratedEntityRow,
): Promise<void> {
  const retention = table.retention;
  if (!retention) return;
  const clockColumns = [retention.clock.column, ...(retention.clock.fallbackColumns ?? [])];
  const clockValues = clockColumns.map((column) => row[column]);
  // No actual record clock means retention has not started. That is explicitly
  // deletable; a declared fallback is not a fabricated timestamp.
  if (clockValues.every((value) => value === null || value === undefined)) return;
  for (const rule of retention.rules) {
    const minimum = rule.duration.minimum;
    if (!minimum) continue;
    const clocks = clockValues.map((value) =>
      value === null || value === undefined
        ? sql`null::timestamptz`
        : sql`${String(value)}::timestamptz`,
    );
    const result = await sql<{ active: boolean | null }>`
      select (coalesce(${sql.join(clocks)}) + ${interval(minimum)} > now()) as active
    `.execute(trx);
    if (result.rows[0]?.active === true) {
      throw operationFailure({
        code: "OPERATION_REFUSED",
        message: "This record is still inside its minimum retention period and cannot be deleted.",
        retryable: false,
      });
    }
  }
}

function assertNoActiveHold(table: GeneratedCrudTable, row: GeneratedEntityRow): void {
  const hold = table.retention?.legalHold;
  if (!hold?.suspendDestruction || !hold.activeColumn) return;
  if (row[hold.activeColumn] === true) {
    throw operationFailure({
      code: "OPERATION_REFUSED",
      message: "This record is under an active legal hold and cannot be deleted.",
      retryable: false,
    });
  }
}

async function assertNeverPublished(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  tables: readonly GeneratedCrudTable[],
): Promise<void> {
  if (!table.source?.hardDelete?.requireNeverPublished) return;
  const versioning = table.source.versioning;
  if (!versioning) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The hard-delete publication guard is not bound to version history.",
    });
  }
  const version = versioning.storage.version;
  const versionTable = tables.find(
    (candidate) => candidate.schema === version.schema && candidate.table === version.table,
  );
  if (!versionTable) {
    throw operationFailure({
      code: "INTERNAL_SERVER_ERROR",
      message: "The hard-delete publication guard cannot resolve version history.",
    });
  }
  const tenantWhere = versionTable.tenantScoped
    ? sql`and ${sql.id("tenant_id")} = ${session.tenantId}::uuid`
    : sql``;
  const history = await sql<{ exists: boolean }>`
    select exists(
      select 1
      from ${sql.id(version.schema, version.table)}
      where ${sql.id(version.headColumn)}::text = ${id}
        ${tenantWhere}
    ) as exists
  `.execute(trx);
  if (history.rows[0]?.exists) {
    throw operationFailure({
      code: "OPERATION_REFUSED",
      message: "A document type that has been published cannot be hard-deleted.",
      retryable: false,
    });
  }
}

export async function assertHardDeleteAllowedInTransaction(
  trx: Transaction<DB>,
  session: DbSessionInput,
  table: GeneratedCrudTable,
  id: string,
  row: GeneratedEntityRow,
  tables: readonly GeneratedCrudTable[],
): Promise<void> {
  assertNoActiveHold(table, row);
  await assertMinimumElapsed(trx, table, row);
  await assertNeverPublished(trx, session, table, id, tables);
}
