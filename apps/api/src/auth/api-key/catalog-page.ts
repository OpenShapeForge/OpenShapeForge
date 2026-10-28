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
 * bounded offset makes the tail unreachable; a keyset names the last row and
 * asks the index for what comes after it, so every page costs the same and
 * there is no tail to be cut off. It is also stable under concurrent writes: a
 * row inserted before the cursor cannot shift a later page, which an offset
 * silently does (one row skipped, one row repeated).
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
 *
 * What the cursor CARRIES is a third property, and it is why there are two
 * cursor types below. A cursor names the previous page's last row by id
 * ({@link PageAnchor}); the value to resume after is read back out of that row
 * ({@link anchorValueQuery}) and only then reaches the predicate
 * ({@link KeysetCursor}). So a cursor is a fixed size whatever a row holds,
 * and the only caller-supplied part of it is a uuid.
 */
import { sql, type RawBuilder } from "kysely";

export type SortDirection = "asc" | "desc";

/**
 * The last row of the previous page, as a cursor NAMES it: its id, and nothing
 * else.
 *
 * The id is the whole anchor on purpose. A cursor that also carried the sort
 * VALUE would be as long as that value — and `display_name` is `text`, with no
 * bound in the schema and none in the two surfaces that have been storing it
 * (`auth/api-key/rest-routes.ts`, `graphql-schema.ts`). Every bound on such a
 * cursor is therefore a bound on a name some row may already hold, and a row
 * whose name is past it is a page the listing emits and cannot take back. An
 * anchor is a uuid whatever the row says, so the cursor is bounded by
 * construction, for every row that exists today and every name a caller may
 * still send.
 *
 * It also keeps caller-supplied text out of a typed expression entirely: the
 * value half used to be cast to `timestamptz`, which is a 500 for every
 * spelling the validator and the input parser disagreed about. The only thing
 * a caller now supplies is the uuid, and {@link anchorValueQuery} reads the
 * value from the row itself.
 */
export type PageAnchor = { id: string };

/**
 * An anchor RESOLVED against the row it names: the value to resume after, as
 * the database rendered it, and the id to break ties on.
 *
 * Resolved per request rather than carried, so the value and the ORDER are
 * read under the same expression and the same `now` — which is what keeps a
 * row whose status has since changed from being skipped or repeated.
 */
export type KeysetCursor = { value: string | null; id: string };

/**
 * The ONE answer an unusable cursor gets, wherever it is refused: a payload
 * that will not parse, a sort or filter it was not issued under, or an anchor
 * no row of this set answers to.
 *
 * Deliberately indiscriminate. Distinguishing "no such row" from "not your
 * row" would make the cursor a probe for another tenant's ids, and a caller
 * that tampered with one only has to learn that it was refused.
 */
export const UNUSABLE_CURSOR =
  "after must be a cursor this listing returned for this same query.";

export type PageQuery<TSort extends string> = {
  sortField: TSort;
  sortDirection: SortDirection;
  /** Already bounded by the Operation's input schema; re-bounded by the caller. */
  first: number;
  after?: PageAnchor;
  /** Case-insensitive substring match. Never interpreted as a pattern. */
  displayName?: string;
  /** Exact match against the subject's status expression. */
  status?: string;
};

export type Page<T> = {
  rows: T[];
  totalCount: number;
  nextCursor: PageAnchor | null;
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
 * The text the resume value travels as, between the anchor lookup and the
 * predicate's cast.
 *
 * It stays text rather than a bound `Date` because the driver's `Date` is
 * MILLISECOND precision: `created_at` holds microseconds, and resuming after a
 * value rounded to the millisecond repeats up to a thousandth of a second's
 * worth of rows or skips them. Rendered and cast back, the instant is exact.
 *
 * `(expr)::text` would be the obvious projection and is the wrong one. A
 * timestamptz renders under the SESSION's `DateStyle` and `TimeZone`, neither
 * of which this code sets or owns: the same row reads
 * `2026-10-28 07:34:35.96+00` under `ISO` at UTC, `28.10.2026 07:34:35.96 UTC`
 * under `German`, and `2026-10-28 08:34:35.96+01` in Amsterdam. The render and
 * the cast back are two statements in one transaction, so under `German, DMY`
 * the CAST would read `28.10.2026` as a day that is not there and answer the
 * resume with an error rather than a page.
 *
 * `to_char` against an explicit template ignores `DateStyle`, and converting
 * to UTC first takes the zone out of it, so one instant has one spelling:
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
 * Read the anchor's own sort value back out of the row it names, so the page
 * knows what to resume after.
 *
 * `select` the projection, from the SAME expression and the same `now` the
 * order and the predicate use, under a fence the CALLER supplies — which must
 * carry the tenant and the subject binding, exactly as the page's own fence
 * does, so an anchor is never resolved against a row outside the set the
 * caller may read.
 *
 * Absent means the cursor is unusable: an id this set has no row for, which is
 * what a forged, a stale or another tenant's anchor all look like from here.
 * The caller reports {@link UNUSABLE_CURSOR} and does not guess a resume point.
 *
 * Nothing in this catalog removes a row — an integration is disabled and a
 * credential is revoked, both in place — so for data this contract itself
 * writes, the anchor of a cursor it issued is still there.
 */
export function anchorValueQuery(
  column: SortColumn,
  from: RawBuilder<unknown>,
  fence: RawBuilder<unknown>,
): RawBuilder<unknown> {
  return sql`
    select ${renderSortValue(column)} as sort_value
      from ${from}
     where ${fence}
     limit 1
  `;
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
 *
 * The cursor here is a RESOLVED one ({@link KeysetCursor}), never the anchor a
 * caller sent: the value it binds came out of the database a statement ago, so
 * the cast below is over this listing's own projection rather than over
 * anything a request supplied.
 */
export function keysetPredicate(
  column: SortColumn,
  id: RawBuilder<unknown>,
  direction: SortDirection,
  after: KeysetCursor | undefined,
): RawBuilder<unknown> {
  if (!after) return sql``;
  if (after.value === null) {
    return sql`and ${column.expr} is null and ${id} > ${after.id}`;
  }
  const value = bind(column, after.value);
  const beyond = direction === "desc"
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
 * Trim the probe row and anchor the next cursor on the last row KEPT.
 *
 * The anchor is the row's id, so there is nothing here to re-derive in
 * JavaScript and nothing to get wrong: the value the next page resumes after
 * is read from this row by {@link anchorValueQuery}, under the same projection
 * that ordered it.
 */
export function takePage<T extends { id: string }>(
  rows: readonly T[],
  first: number,
  totalCount: number,
): Page<T> {
  const page = rows.slice(0, first);
  const last = page.at(-1);
  return {
    rows: [...page],
    totalCount,
    nextCursor: rows.length > page.length && last ? { id: last.id } : null,
  };
}
