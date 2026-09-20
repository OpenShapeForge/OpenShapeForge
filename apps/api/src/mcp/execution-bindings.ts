// SPDX-License-Identifier: BUSL-1.1
/**
 * Load the ordered binding rows a derived tool will execute.
 *
 * Bindings live on an owned collection (`bindingsRelation`). The runtime
 * joins that table under the caller's session (RLS / tenant scope) and
 * orders by `order`.
 *
 * Relation reads page until the owner is complete. A chain that would exceed
 * `MAX_BINDINGS_PER_OWNER` is refused rather than executed truncated. Batch
 * listing loads the owner-id set in one paged query and groups in memory, so
 * one owner's rows cannot starve another.
 */
import { HttpError } from "../rest/http-error.js";
import {
  orderedBindingRecords,
  type ExecutionCatalogEntry,
} from "./declarative-execution.js";

/** Hard cap on binding rows one derived-tool owner may execute. */
export const MAX_BINDINGS_PER_OWNER = 200;

const RELATION_PAGE_SIZE = MAX_BINDINGS_PER_OWNER;

export type BindingReadPage = {
  rows: Record<string, unknown>[];
  nextCursor: string | null;
};

export type BindingRowReader = (
  table: string,
  filter: Record<string, unknown>,
  options?: { limit?: number; cursor?: string | null },
) => Promise<BindingReadPage | Record<string, unknown>[]>;

export class BindingOverflowError extends HttpError {
  constructor(max: number = MAX_BINDINGS_PER_OWNER) {
    super(
      400,
      "SERVICE_MISCONFIGURED",
      `The service defines more than ${max} bindings.`,
    );
    this.name = "BindingOverflowError";
  }
}

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

function asPage(
  result: BindingReadPage | Record<string, unknown>[],
): BindingReadPage {
  if (Array.isArray(result)) {
    // Array readers are complete: they ignored paging and returned every
    // matching row. Overflow is then just `rows.length > MAX`.
    return { rows: result, nextCursor: null };
  }
  return {
    rows: result.rows.filter((row) => row && typeof row === "object"),
    nextCursor: result.nextCursor ?? null,
  };
}

function overflowIfBeyond(
  count: number,
  max: number = MAX_BINDINGS_PER_OWNER,
): void {
  if (count > max) throw new BindingOverflowError(max);
}

/**
 * True for Postgres undefined_table (42P01) and, defensively, missing-schema
 * (3F000). Bun's SQL driver reports the SQLSTATE in `errno`; other drivers
 * put it in `code`.
 */
export function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  const sqlstates = new Set(["42P01", "3F000"]);
  return (
    (typeof candidate.errno === "string" && sqlstates.has(candidate.errno)) ||
    (typeof candidate.code === "string" && sqlstates.has(candidate.code))
  );
}

async function readRelationOrEmpty(
  read: () => Promise<Record<string, unknown>[]>,
): Promise<Record<string, unknown>[]> {
  try {
    return await read();
  } catch (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
}

/**
 * Read every relation row matching `filter`, paging by the reader's cursor.
 * Refuses once `max` rows would be exceeded rather than returning a prefix.
 */
export async function readAllRelationRows(
  readRows: BindingRowReader,
  table: string,
  filter: Record<string, unknown>,
  max: number = MAX_BINDINGS_PER_OWNER,
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    overflowIfBeyond(collected.length, max);
    const page = asPage(
      await readRows(table, filter, {
        limit: RELATION_PAGE_SIZE,
        cursor,
      }),
    );
    for (const row of page.rows) {
      if (!row || typeof row !== "object") continue;
      const id = typeof row.id === "string" ? row.id : "";
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      collected.push(row);
      overflowIfBeyond(collected.length, max);
    }
    if (!page.nextCursor || page.rows.length === 0) return collected;
    if (page.nextCursor === cursor) {
      throw new BindingOverflowError(max);
    }
    cursor = page.nextCursor;
  }
}

async function relationRowsForOwner(
  execution: ExecutionCatalogEntry,
  ownerRow: Record<string, unknown>,
  readRows: BindingRowReader,
): Promise<Record<string, unknown>[]> {
  const { table, parentRef } = relationContract(execution);
  const ownerId = ownerRow.id;
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new HttpError(
      400,
      "SERVICE_MISCONFIGURED",
      "The service defines no bindings.",
    );
  }
  return readAllRelationRows(readRows, table, { [parentRef]: ownerId });
}

/** Raw binding rows for one owner, without order validation. Empty is `[]`. */
export async function readBindingRows(
  execution: ExecutionCatalogEntry,
  ownerRow: Record<string, unknown>,
  readRows?: BindingRowReader,
): Promise<Record<string, unknown>[]> {
  if (!readRows) return [];
  const ownerId = ownerRow.id;
  if (typeof ownerId !== "string" || ownerId.length === 0) return [];
  return readRelationOrEmpty(() =>
    relationRowsForOwner(execution, ownerRow, readRows),
  );
}

/** Ordered bindings for one owner row. */
export async function loadOrderedBindings(
  execution: ExecutionCatalogEntry,
  ownerRow: Record<string, unknown>,
  readRows?: BindingRowReader,
): Promise<Record<string, unknown>[]> {
  if (!readRows) {
    throw new HttpError(
      500,
      "SERVICE_MISCONFIGURED",
      "The service execution contract is incomplete.",
    );
  }
  const rows = await relationRowsForOwner(execution, ownerRow, readRows);
  return orderedBindingRecords(rows);
}

/** Ordered bindings grouped by owner id, for listing many derived tools. */
export async function loadOrderedBindingsByOwner(
  execution: ExecutionCatalogEntry,
  ownerRows: readonly Record<string, unknown>[],
  readRows: BindingRowReader,
): Promise<Map<string, Record<string, unknown>[]>> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  const { table, parentRef } = relationContract(execution);
  const ownerIds = ownerRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  for (const id of ownerIds) grouped.set(id, []);
  if (ownerIds.length === 0) return grouped;

  const collected = await readRelationOrEmpty(async () => {
    const rows: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const page = asPage(
        await readRows(
          table,
          { [parentRef]: { in: ownerIds } },
          { limit: RELATION_PAGE_SIZE, cursor },
        ),
      );
      for (const row of page.rows) {
        if (!row || typeof row !== "object") continue;
        const id = typeof row.id === "string" ? row.id : "";
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        const ownerId = row[parentRef];
        if (typeof ownerId !== "string" || !grouped.has(ownerId)) continue;
        const bucket = grouped.get(ownerId)!;
        bucket.push(row);
        overflowIfBeyond(bucket.length);
        rows.push(row);
      }
      if (!page.nextCursor || page.rows.length === 0) return rows;
      if (page.nextCursor === cursor) throw new BindingOverflowError();
      cursor = page.nextCursor;
    }
  });
  for (const [id, rows] of grouped) {
    grouped.set(id, rows.length === 0 ? [] : orderedBindingRecords(rows));
  }
  return grouped;
}
