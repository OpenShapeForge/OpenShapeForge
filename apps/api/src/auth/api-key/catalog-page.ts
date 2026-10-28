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
 * there is no tail to be cut off. It is also stable under concurrent writes in
 * the way an offset is not: a row inserted or removed before the cursor cannot
 * shift a later page, which an offset silently does (one row skipped, one row
 * repeated).
 *
 * That is a claim about INSERTS and REMOVALS before the cursor, and not a
 * snapshot of the catalog across page requests: a row whose own sort value
 * changes between two requests moves in the order, and a walk may then reach
 * it twice or not at all. That is ordinary keyset pagination and not something
 * a cursor can carry. The one case this listing refuses rather than absorbs is
 * the ANCHOR row's own movement, because resuming from it is what would end a
 * walk early with rows unread — {@link sortValueDigest} says how that is
 * noticed and {@link MOVED_ANCHOR} what the caller is told.
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
 * What the cursor CARRIES is a third property. A cursor names the previous
 * page's last row by id and by a fixed-width DIGEST of that row's sort value
 * ({@link PageAnchor}); the value to resume after is read back out of the row
 * inside the page's own statement ({@link anchorSortValue}) and only then
 * reaches the predicate. So a cursor is a fixed size whatever a row holds, the
 * only caller-supplied part of it is a uuid and a digest, and a row that MOVED
 * in the order since the cursor was issued is detected rather than resumed
 * from (see {@link sortValueDigest}).
 *
 * The fourth property is that those answers agree with each other, which is
 * why the count, the anchor and the rows are ONE statement
 * ({@link pageStatement}) rather than three: three statements in a READ
 * COMMITTED transaction take three snapshots, and the window between them is
 * long enough for the anchor to move after its digest was checked and before
 * the page was cut.
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
 * a caller now supplies is the uuid, and {@link anchorSortValue} reads the
 * value from the row itself.
 */
export type PageAnchor = { id: string; value: string };

/**
 * The anchor's sort value as a fixed-width digest — the half of the cursor
 * that makes a MOVED row visible.
 *
 * The id alone is not enough, and that is a correctness matter rather than a
 * refinement. The resume value is read from the anchor row at resume time, so
 * if that row's own sort value changed between two pages the resume point
 * moves with it: renaming the row the previous page ended on to a name that
 * sorts after everything left makes the next page empty and the listing end
 * there, silently, with every remaining row unread. Renaming it backwards
 * repeats rows instead. Neither is something a caller can see.
 *
 * Carrying the VALUE would fix it and cannot be done: `display_name` is
 * unbounded `text` and the two surfaces that have been storing it since before
 * this listing existed bound it nowhere, so a cursor carrying it is as long as
 * the longest name any row holds — and bounding the cursor would then be
 * bounding those two published contracts. A digest is 16 characters for a name
 * of any length, so the cursor stays one size and no stored name and no
 * accepted input can put a page out of reach.
 *
 * What the digest buys is detection, not repair: the resume point cannot be
 * recovered from it, so a cursor whose anchor moved is refused as a client
 * error ({@link MOVED_ANCHOR}) and the caller reads the listing again. That is
 * the trade this listing makes — an explicit 400 on the rare page that follows
 * a mutation of the row it anchored on, instead of a silently short answer.
 *
 * Computed in SQL, in both places that need it (the anchor CTE and the page's
 * own projection, in one statement), for two reasons. It is the ONE expression, so a
 * page's digest and the resume check's digest cannot drift the way a
 * JavaScript hash of a separately rendered value could. And a page carries 16
 * characters per row out of the database instead of the sort value itself —
 * which for the names this catalog really holds is tens of kilobytes a row,
 * for a value no caller is shown.
 *
 * `null` — "no expiry", "never used" — digests the marker `n` rather than any
 * rendered value, so the absent-value block is its own anchor and cannot
 * collide with a row whose name happens to render the same way. The result is
 * compared for EQUALITY against the cursor's copy, so, like the sort/filter
 * fingerprint, none of it reaches a typed expression.
 */
export function sortValueDigest(column: SortColumn): RawBuilder<unknown> {
  const rendered = renderSortValue(column);
  return sql`left(translate(encode(sha256(convert_to(
    case when (${rendered}) is null then 'n' else 'v' || (${rendered}) end, 'UTF8')),
    'base64'), '+/', '-_'), ${sql.lit(DIGEST_LENGTH)})`;
}

/** Characters of base64url the digest keeps: enough to make a collision idle. */
export const DIGEST_LENGTH = 16;

/**
 * The CTE a page statement resolves its anchor in.
 *
 * Named once, here, because three parts of one statement reference it: the
 * declaration, the resume predicate that reads the value out of it, and the
 * projection that reports whether the row is still where the cursor left it.
 */
const ANCHOR = sql.raw("page_anchor");

/**
 * The anchor's resolved sort value, as a subquery over {@link ANCHOR}.
 *
 * Resolved inside the statement rather than carried, so the value and the
 * ORDER are read under the same expression, the same `now` and — the point of
 * {@link pageStatement} — the same snapshot: the resume point is a real point
 * in the order the page is being produced in, rather than a rendering of an
 * expression (a derived status, an expiry against `now`) that has since moved
 * on, or one read a statement earlier under a snapshot the page no longer has.
 *
 * It is one scalar subquery over a CTE this statement declares, so PostgreSQL
 * evaluates it once and as a constant, and an index can still serve the
 * comparison it bounds.
 *
 * It does NOT make the walk stable under a mutation of the anchor row itself —
 * nothing resolved per request can, because the resolved value is the row's
 * NEW one. {@link sortValueDigest} is what notices that, and
 * {@link MOVED_ANCHOR} is what the caller is told.
 */
function anchorSortValue(column: SortColumn): RawBuilder<unknown> {
  const value = sql`(select sort_value from ${ANCHOR})`;
  return column.cast === "timestamptz" ? sql`${value}::timestamptz` : value;
}

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

/**
 * The other refusal: the anchor row IS a row of this set, and it has moved.
 *
 * Distinguished from {@link UNUSABLE_CURSOR} on purpose, and safely. It is
 * only ever reached after the anchor resolved to a row inside the caller's
 * own fenced set — the row the previous page handed them — so it discloses
 * nothing a caller did not already read, while telling them the one thing they
 * can act on: this walk cannot be continued, start it again.
 */
export const MOVED_ANCHOR =
  "after names a row whose sort value changed after the page that issued it; " +
  "read this listing again from its first page.";

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
 * Written as one disjunction rather than a `case` over the two, so every
 * comparison stays a plain comparison against a constant the planner can push
 * into an index. It reads the way it does because `>`, `<` and `=` against a
 * NULL value are all NULL and so drop out by themselves: when the value is
 * absent only the first branch can hold, and its own `is not null` test is
 * what keeps the id tie-break from leaking into the case where it must not
 * apply. The two readings are the two above, with nothing in between.
 *
 * `after` is the anchor a CALLER sent, and the only part of it that reaches a
 * typed expression is the uuid. The value comes from
 * {@link anchorSortValue} — the statement's own CTE, under the statement's own
 * snapshot — so the cast is over this listing's projection rather than over
 * anything a request supplied.
 */
export function keysetPredicate(
  column: SortColumn,
  id: RawBuilder<unknown>,
  direction: SortDirection,
  after: PageAnchor | undefined,
): RawBuilder<unknown> {
  if (!after) return sql``;
  const value = anchorSortValue(column);
  const beyond = direction === "desc"
    ? sql`${column.expr} < ${value}`
    : sql`${column.expr} > ${value}`;
  return sql`and (
    (${column.expr} is null and (${value} is not null or ${id} > ${after.id}))
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
 * The whole page — the count, the anchor's verdict and the rows — as ONE
 * statement.
 *
 * This is one statement because the three answers have to agree with each
 * other, and three statements cannot be made to. They used to run in sequence
 * inside the page's transaction, which is READ COMMITTED, so each took its own
 * snapshot and a concurrent write landing between them was visible to the
 * later ones and not the earlier:
 *
 *   - the anchor's digest matched under the second statement's snapshot, and
 *     the page then resumed after the row's value under the third's. If the
 *     anchor's sort value moved later in the order in that window, the anchor
 *     row itself satisfied "after its old value" and came back a SECOND time,
 *     having just been handed to the caller as the end of the previous page.
 *     Moving it earlier skipped rows instead. {@link MOVED_ANCHOR} is the
 *     refusal for exactly this, and it could not see the move it was for.
 *   - `totalCount` was counted under the first snapshot and the rows selected
 *     under the third, so a page could report fewer rows in total than it
 *     carried.
 *
 * One statement has one snapshot, whatever the isolation level and whether or
 * not this listing opened the transaction it runs in — which matters, because
 * inside a canonical Operation it JOINS the dispatcher's transaction and
 * cannot choose that transaction's isolation. The CTEs are read under that one
 * snapshot, so the digest the caller compares, the value the keyset resumes
 * after and the count all describe the same set of rows.
 *
 * What this does NOT claim is a snapshot across page REQUESTS. Every request
 * reads the catalog as it is at that moment, which is what a keyset is for: a
 * row inserted or removed before the cursor cannot shift a later page, and a
 * row that changes elsewhere in the order is ordinary pagination, not an
 * anomaly this closes. The anchor row's own movement is the one case that is
 * refused rather than absorbed, and the digest is now compared against the
 * same snapshot the page was cut from.
 *
 * The page's rows carry `page_ord`, a `row_number()` over the limited
 * subquery, because the outer select joins the count onto them and a join
 * guarantees no order. Numbering the rows is how the order survives it without
 * the sort VALUE having to be projected out of the database — which is the
 * thing {@link sortValueDigest} exists to avoid shipping.
 */
export function pageStatement(parts: {
  column: SortColumn;
  /** The row id, as the page's own `from` names it. */
  id: RawBuilder<unknown>;
  direction: SortDirection;
  first: number;
  /** What the count and the anchor read. */
  from: RawBuilder<unknown>;
  /** The same rows, plus whatever the page's projection joins in. */
  pageFrom: RawBuilder<unknown>;
  /** Tenant, subject and filters: one fragment, so the count cannot drift. */
  fence: RawBuilder<unknown>;
  /** The page's own projection. */
  columns: RawBuilder<unknown>;
  groupBy?: RawBuilder<unknown>;
  /**
   * The cursor's anchor and the fence that makes it a row of THIS set — which
   * must carry the tenant and the subject binding, exactly as the page's own
   * fence does, so an anchor is never resolved against a row outside the set
   * the caller may read.
   */
  anchor?: { cursor: PageAnchor; fence: RawBuilder<unknown> };
}): RawBuilder<unknown> {
  const anchor = parts.anchor
    ? sql`${ANCHOR} as (
        select ${renderSortValue(parts.column)} as sort_value,
               ${sortValueDigest(parts.column)} as sort_digest
          from ${parts.from}
         where ${parts.anchor.fence}
         limit 1
      ),`
    : sql``;
  return sql`
    with ${anchor}
    page_total as (
      select count(*) as total from ${parts.from} where ${parts.fence}
    ),
    page_rows as (
      select limited.*, row_number() over () as page_ord
        from (
          select ${parts.columns}, ${sortValueDigest(parts.column)} as sort_digest
            from ${parts.pageFrom}
           where ${parts.fence}
             ${keysetPredicate(parts.column, parts.id, parts.direction, parts.anchor?.cursor)}
           ${parts.groupBy ?? sql``}
           ${orderBy(parts.column, parts.id, parts.direction)}
           ${limitWithProbe(parts.first)}
        ) limited
    )
    select page_total.total,
           ${parts.anchor ? sql`(select sort_digest from ${ANCHOR})` : sql`null`} as anchor_digest,
           ${parts.anchor ? sql`exists (select 1 from ${ANCHOR})` : sql`false`} as anchor_found,
           page_rows.*
      from page_total left join page_rows on true
     order by page_rows.page_ord
  `;
}

/**
 * What {@link pageStatement} answers with, beside the page's own columns.
 *
 * `page_total` always has its one row, so the statement always has one too:
 * an empty page is the left join's unmatched row, which carries the count and
 * the anchor's verdict and a null `page_ord`. {@link takePage} drops it.
 */
export type PageStatementRow = {
  total: string | number;
  /** The anchor's current digest, or null when no row of this set answers to it. */
  anchor_digest: string | null;
  anchor_found: boolean;
  /** Null on the one row an empty page comes back as. */
  page_ord: string | number | null;
};

/**
 * Trim the empty-page sentinel and the probe row, and anchor the next cursor
 * on the last row KEPT.
 *
 * The anchor is the row's id plus its `sort_digest` — the projection
 * {@link sortValueDigest} put on the page query, so it is the database's own
 * digest of the very expression that ordered the row, not something re-derived
 * in JavaScript. The next page resolves that row's value again under its own
 * single snapshot, and the digest is what says whether it is still the same
 * value.
 */
export function takePage<T extends { id: string; sort_digest: string }>(
  rows: readonly (T & PageStatementRow)[],
  first: number,
): Page<T> {
  const totalCount = Number(rows[0]?.total ?? 0);
  const found = rows.filter((row) => row.page_ord !== null);
  const page = found.slice(0, first);
  const last = page.at(-1);
  return {
    rows: [...page],
    totalCount,
    nextCursor: found.length > page.length && last
      ? { id: last.id, value: last.sort_digest }
      : null,
  };
}
