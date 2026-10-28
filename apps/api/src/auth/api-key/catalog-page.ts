// SPDX-License-Identifier: BUSL-1.1
/**
 * SQL fragments for one page of the integration catalog.
 *
 * Pure builders: no I/O, no session, no authorization. `service.ts` composes
 * them inside the caller's own tenant session, which is where the ceiling and
 * the tenant fence stay.
 *
 * The page is a KEYSET, not an offset. An offset page has to count rows it
 * will not return, so the cost of the last page grows with the account and a
 * bounded offset makes the tail unreachable; a keyset carries the last row's
 * sort value and id and asks the index for what comes after it, so every page
 * costs the same and there is no tail to be cut off. It is also stable under
 * concurrent writes: a row inserted before the cursor cannot shift a later
 * page, which an offset silently does (one row skipped, one row repeated).
 *
 * Two properties make a keyset correct, and both are enforced here rather than
 * left to the caller:
 *
 *   1. A TOTAL order. The sort field alone is not one — two integrations can
 *      share a `created_at` to the microsecond — so every order ends in the
 *      row id, ascending, in both directions. Ties therefore page in one
 *      definite order instead of an arbitrary one per plan.
 *   2. NULLs in one definite place. "No expiry" and "never used" are the
 *      absence of a value, not the smallest one, so they sort LAST in both
 *      directions and the resume predicate knows which block it is in.
 */
import { sql, type RawBuilder } from "kysely";

export type SortDirection = "asc" | "desc";

/** The last row of the previous page: its sort value as text, and its id. */
export type KeysetCursor = { value: string | null; id: string };

export type PageQuery<TSort extends string> = {
  sortField: TSort;
  sortDirection: SortDirection;
  /** Already bounded by the Operation's input schema; re-bounded by the caller. */
  first: number;
  after?: KeysetCursor;
  /** Case-insensitive substring match. Never interpreted as a pattern. */
  displayName?: string;
  /** Exact match against the subject's status expression. */
  status?: string;
};

export type Page<T> = {
  rows: T[];
  totalCount: number;
  nextCursor: KeysetCursor | null;
};

/**
 * One sortable column: the expression to order by, and how a cursor value
 * comes back INTO that expression's type.
 *
 * The cast matters. A cursor travels as text, and comparing a timestamp
 * against text would compare Postgres' rendering of it — correct only by
 * accident of format. Casting the parameter instead keeps the comparison in
 * the column's own type, which is also what lets an index serve it.
 */
export type SortColumn = {
  expr: RawBuilder<unknown>;
  cast?: "timestamptz";
};

function bind(column: SortColumn, value: string): RawBuilder<unknown> {
  return column.cast === "timestamptz" ? sql`${value}::timestamptz` : sql`${value}`;
}

/**
 * The text a cursor carries for one row of this sort.
 *
 * `(expr)::text` would be the obvious projection and is the wrong one. A
 * timestamptz renders under the SESSION's `DateStyle` and `TimeZone`, neither
 * of which this code sets or owns: the same row reads
 * `2026-10-28 07:34:35.96+00` under `ISO` at UTC, `28.10.2026 07:34:35.96 UTC`
 * under `German`, and `2026-10-28 08:34:35.96+01` in Amsterdam. A page would
 * then hand out a cursor whose spelling depends on a setting, and the check on
 * the way back in — and under `German, DMY` the CAST itself, which reads
 * `28.10.2026` as a day that is not there — would refuse the listing's own
 * cursor and make the next page unreachable.
 *
 * `to_char` against an explicit template ignores `DateStyle`, and converting
 * to UTC first takes the zone out of it, so one row is one cursor:
 * `YYYY-MM-DD HH:MM:SS.ssssss+00`, every field fixed-width and the fraction
 * always present. It casts back to the same instant, so the EQUALITY the
 * resume predicate compares on still holds exactly (`keysetPredicate`).
 *
 * NULL stays NULL — `to_char(null, ...) || '+00'` is null — which is the
 * absent-value block the keyset resumes on the id alone.
 */
export function renderSortValue(column: SortColumn): RawBuilder<unknown> {
  return column.cast === "timestamptz"
    ? sql`to_char((${column.expr}) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`
    : sql`(${column.expr})::text`;
}

/**
 * `<expr> <direction> nulls last, <id> asc`.
 *
 * The id tie-break does NOT flip with the direction: it only has to be
 * definite, and keeping it ascending keeps one resume predicate correct for
 * both directions.
 */
export function orderBy(
  column: SortColumn,
  id: RawBuilder<unknown>,
  direction: SortDirection,
): RawBuilder<unknown> {
  return direction === "desc"
    ? sql`order by ${column.expr} desc nulls last, ${id} asc`
    : sql`order by ${column.expr} asc nulls last, ${id} asc`;
}

/**
 * The resume predicate, or nothing for the first page.
 *
 * Two cases, because a cursor sitting in the NULL block cannot be compared:
 *
 *   - value present — take everything strictly after it in the sort
 *     direction, everything tied with it but after its id, and the whole NULL
 *     block, which sorts last and so is always still ahead.
 *   - value absent — the previous page ended inside the NULL block, so only
 *     NULL rows with a later id remain.
 */
export function keysetPredicate(
  column: SortColumn,
  id: RawBuilder<unknown>,
  query: Pick<PageQuery<string>, "sortDirection" | "after">,
): RawBuilder<unknown> {
  const after = query.after;
  if (!after) return sql``;
  if (after.value === null) {
    return sql`and ${column.expr} is null and ${id} > ${after.id}`;
  }
  const value = bind(column, after.value);
  const beyond = query.sortDirection === "desc"
    ? sql`${column.expr} < ${value}`
    : sql`${column.expr} > ${value}`;
  return sql`and (
    ${column.expr} is null
    or ${beyond}
    or (${column.expr} = ${value} and ${id} > ${after.id})
  )`;
}

/**
 * Case-insensitive CONTAINS, as a position test rather than a `like`.
 *
 * `like` would read `%` and `_` in the caller's own value as wildcards, so a
 * search for `a_b` would match `axb`. `position` has no metacharacters, so
 * there is nothing to escape and nothing to get wrong.
 */
export function containsFilter(
  column: RawBuilder<unknown>,
  value: string | undefined,
): RawBuilder<unknown> {
  const query = value?.trim();
  if (!query) return sql``;
  return sql`and position(lower(${query}) in lower(${column})) > 0`;
}

/** Exact match, or nothing. The accepted set is the Operation's input enum. */
export function exactFilter(
  column: RawBuilder<unknown>,
  value: string | undefined,
): RawBuilder<unknown> {
  if (value === undefined || value === "") return sql``;
  return sql`and ${column} = ${value}`;
}

/** `limit first + 1`: one row past the page is how the next cursor is known. */
export function limitWithProbe(first: number): RawBuilder<unknown> {
  return sql`limit ${sql.lit(Math.trunc(first) + 1)}`;
}

/**
 * Trim the probe row and derive the next cursor from the last row KEPT.
 *
 * The cursor is built from the row's own `sort_value` as the database rendered
 * it, so the next page resumes on exactly the value it stopped at — not on a
 * value re-derived in JavaScript, which is where a timezone or a rounding
 * difference would silently skip or repeat a row.
 */
export function takePage<T extends { sort_value: string | null; id: string }>(
  rows: readonly T[],
  first: number,
  totalCount: number,
): Page<T> {
  const page = rows.slice(0, first);
  const last = page.at(-1);
  return {
    rows: [...page],
    totalCount,
    nextCursor: rows.length > page.length && last
      ? { value: last.sort_value, id: last.id }
      : null,
  };
}
