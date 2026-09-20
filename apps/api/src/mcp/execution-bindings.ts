// SPDX-License-Identifier: BUSL-1.1
/**
 * Load the ordered binding rows a derived tool will execute.
 *
 * JSON form (`bindingsField`) reads the collection off the owner row.
 * Relation form (`bindingsRelation`) joins the owned collection table under
 * the caller's session (RLS / tenant scope) and orders by `order`.
 */
import { HttpError } from "../rest/http-error.js";
import {
  orderedBindingRecords,
  orderedBindings,
  type ExecutionCatalogEntry,
} from "./declarative-execution.js";

export type BindingRowReader = (
  table: string,
  filter: Record<string, unknown>,
  limit?: number,
) => Promise<Record<string, unknown>[]>;

const RELATION_BINDINGS_LIMIT = 200;

function relationContract(
  execution: ExecutionCatalogEntry,
): { table: string; parentRef: string } {
  const table = execution.bindingsTable;
  const parentRef = execution.parentRef;
  if (
    typeof execution.bindingsRelation !== "string" ||
    execution.bindingsRelation.length === 0 ||
    typeof table !== "string" ||
    table.length === 0 ||
    typeof parentRef !== "string" ||
    parentRef.length === 0
  ) {
    throw new HttpError(
      500,
      "SERVICE_MISCONFIGURED",
      "The service execution contract is incomplete.",
    );
  }
  return { table, parentRef };
}

/** Raw binding rows for one owner, without order validation. Empty is `[]`. */
export async function readBindingRows(
  execution: ExecutionCatalogEntry,
  ownerRow: Record<string, unknown>,
  readRows?: BindingRowReader,
): Promise<Record<string, unknown>[]> {
  if (typeof execution.bindingsField === "string" && execution.bindingsField.length > 0) {
    const raw = ownerRow[execution.bindingsField];
    return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  }
  if (!readRows) return [];
  try {
    const { table, parentRef } = relationContract(execution);
    const ownerId = ownerRow.id;
    if (typeof ownerId !== "string" || ownerId.length === 0) return [];
    const rows = await readRows(
      table,
      { [parentRef]: ownerId },
      RELATION_BINDINGS_LIMIT,
    );
    return rows.filter((row) => row && typeof row === "object");
  } catch {
    return [];
  }
}

/** Ordered bindings for one owner row. */
export async function loadOrderedBindings(
  execution: ExecutionCatalogEntry,
  ownerRow: Record<string, unknown>,
  readRows?: BindingRowReader,
): Promise<Record<string, unknown>[]> {
  if (typeof execution.bindingsField === "string" && execution.bindingsField.length > 0) {
    return orderedBindings(ownerRow, execution.bindingsField);
  }
  if (!readRows) {
    throw new HttpError(
      500,
      "SERVICE_MISCONFIGURED",
      "The service execution contract is incomplete.",
    );
  }
  const { table, parentRef } = relationContract(execution);
  const ownerId = ownerRow.id;
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new HttpError(
      400,
      "SERVICE_MISCONFIGURED",
      "The service defines no bindings.",
    );
  }
  const rows = await readRows(
    table,
    { [parentRef]: ownerId },
    RELATION_BINDINGS_LIMIT,
  );
  return orderedBindingRecords(rows);
}

/** Ordered bindings grouped by owner id, for listing many derived tools. */
export async function loadOrderedBindingsByOwner(
  execution: ExecutionCatalogEntry,
  ownerRows: readonly Record<string, unknown>[],
  readRows: BindingRowReader,
): Promise<Map<string, Record<string, unknown>[]>> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  if (typeof execution.bindingsField === "string" && execution.bindingsField.length > 0) {
    for (const row of ownerRows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) continue;
      try {
        grouped.set(id, orderedBindings(row, execution.bindingsField));
      } catch {
        grouped.set(id, []);
      }
    }
    return grouped;
  }
  const { table, parentRef } = relationContract(execution);
  const ownerIds = ownerRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ownerIds.length === 0) return grouped;
  const rows = await readRows(
    table,
    { [`${parentRef}In`]: ownerIds },
    RELATION_BINDINGS_LIMIT,
  );
  const raw = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const ownerId = row[parentRef];
    if (typeof ownerId !== "string" || ownerId.length === 0) continue;
    const list = raw.get(ownerId) ?? [];
    list.push(row);
    raw.set(ownerId, list);
  }
  for (const [ownerId, list] of raw) {
    try {
      grouped.set(ownerId, orderedBindingRecords(list));
    } catch {
      grouped.set(ownerId, []);
    }
  }
  for (const id of ownerIds) {
    if (!grouped.has(id)) grouped.set(id, []);
  }
  return grouped;
}
