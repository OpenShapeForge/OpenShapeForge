// SPDX-License-Identifier: BUSL-1.1
/**
 * The opaque `after` cursor of the integration catalog: what it carries, and
 * what has to be true of it before any half of it reaches a typed expression.
 *
 * The keyset alone would be resumable under a DIFFERENT sort or filter, where
 * "everything after this value" means something else entirely and silently
 * skips or repeats rows. So the cursor carries a fingerprint of the sort and
 * the filters it was issued for, and a request whose own sort or filters do
 * not match it is refused as a client error instead of answered with a page
 * that looks fine and is not.
 *
 * The fingerprint is a hash, so the cursor stays short, but it is NOT a
 * security boundary and is not relied on as one: the tenant comes from the
 * session and the subject from the request, both re-applied as SQL predicates
 * on every statement, so the worst a forged cursor can do is pick a different
 * resume point inside a set the caller may already read.
 *
 * Both halves of a keyset reach a TYPED expression: the id is compared against
 * a uuid column, and a date sort's value is cast to timestamptz
 * (`auth/api-key/catalog-page.ts`, `bind`). PostgreSQL answers a malformed one
 * with `invalid input syntax` or `field value out of range` — a 500 reported to
 * a caller who only supplied a bad cursor, which this contract does not declare
 * and which should never be logged as an internal failure. So both halves are
 * checked here, against what the database itself renders, before anything is
 * bound.
 *
 * Nothing is normalized on the way back in. The resume predicate compares the
 * value for EQUALITY to find the tie-break block (`catalog-page.ts`,
 * `keysetPredicate`), so a cursor is accepted verbatim or refused: rewriting it
 * into some canonical spelling would move the resume point.
 */
import { createHash } from "node:crypto";
import type { KeysetCursor } from "../auth/api-key/catalog-page.js";
import { daysInMonth } from "../db/timestamps.js";
import { ApiKeyValidationError } from "../auth/api-key/service.js";

/** What travels inside the base64url payload. */
type CursorPayload = {
  /** Sort field and direction this cursor was issued under. */
  f: string;
  d: "asc" | "desc";
  /** Fingerprint of the subject and filters. */
  q: string;
  /** The last row's sort value as the database rendered it; null in the NULL block. */
  v: string | null;
  /** The last row's id — the tie-break half of the keyset. */
  i: string;
};

/**
 * The 8-4-4-4-12 hex shape, deliberately NOT the stricter RFC 4122 pattern the
 * session layer applies: this only has to be a value the uuid type accepts, and
 * a row id is whatever the database minted, not something to re-validate.
 */
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `timestamptz::text` under DateStyle ISO, split into its fields.
 *
 * This is only the SHAPE. A shape test alone is what made
 * `2026-99-99 99:99:99+99` reach the cast — and `2026-02-29 00:00:00+00` with
 * it, which is shaped perfectly and is still PostgreSQL's
 * "date/time field value out of range". Every field is therefore range-checked
 * below as well.
 *
 * The fields are what the database renders, not everything its input parser
 * accepts: a space separator (never `T`), a fraction of at most six digits and
 * only when non-zero, and an offset that grows from `+00` to `+05:30` to
 * `+00:19:32` exactly as far as it has to. A rendered value also never carries
 * the input parser's roll-over spellings — `24:00:00` is rendered as the next
 * day's `00:00:00`, `:60` as the next minute — so those are refused: accepting
 * them would accept a cursor this listing cannot have issued.
 */
const RENDERED_TIMESTAMPTZ =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::(\d{2})(?::(\d{2}))?)?$/;

/**
 * The widest numeric time-zone displacement PostgreSQL accepts: `+16` is
 * "time zone displacement out of range", `+15:59:59` is not. A rendered value
 * is always inside this, so the bound only ever refuses a crafted one.
 */
const MAX_OFFSET_SECONDS = 15 * 3600 + 59 * 60 + 59;

/**
 * Is this exactly a timestamptz PostgreSQL could have rendered?
 *
 * Shape first, then every field against the calendar — which is where the
 * month, the day (February of a leap year included) and the displacement are
 * decided, because a regular expression cannot count days in a month.
 */
export function isRenderedTimestamptz(value: string): boolean {
  const match = RENDERED_TIMESTAMPTZ.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , , offsetHour, offsetMinute, offsetSecond] =
    match;
  const days = daysInMonth(Number(year), Number(month));
  if (days === undefined) return false;
  if (Number(day) < 1 || Number(day) > days) return false;
  // The rendered forms only: a normalized time has no hour 24 and no second 60.
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  const offset = Number(offsetHour) * 3600 +
    Number(offsetMinute ?? 0) * 60 +
    Number(offsetSecond ?? 0);
  if (Number(offsetMinute ?? 0) > 59 || Number(offsetSecond ?? 0) > 59) return false;
  return offset <= MAX_OFFSET_SECONDS;
}

/** The sorts whose value is a timestamp rather than text (service.ts). */
const TIMESTAMP_SORTS = new Set(["createdAt", "updatedAt", "expiresAt", "lastUsedAt"]);

/**
 * The longest text sort value a cursor may carry.
 *
 * `lower(display_name)` is the only text sort value, and the authored input
 * bounds a display name at 200 characters; `status` is one short word. Past
 * that the cursor is not one this listing produced.
 */
const MAX_CURSOR_VALUE_LENGTH = 200;

export function fingerprint(parts: readonly (string | undefined)[]): string {
  return createHash("sha256").update(JSON.stringify(parts.map((part) => part ?? null)))
    .digest("base64url").slice(0, 16);
}

function invalidCursor(): never {
  // Deliberately one message for every rejection: a caller that tampered with
  // a cursor learns that it was rejected, not which half gave it away.
  throw new ApiKeyValidationError("after must be a cursor this listing returned for this same query.");
}

export function decodeCursor(
  value: unknown,
  sort: { f: string; d: string },
  query: string,
): KeysetCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 512) invalidCursor();
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    invalidCursor();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalidCursor();
  if (typeof payload.i !== "string" || !CURSOR_ID.test(payload.i)) invalidCursor();
  if (payload.v !== null && typeof payload.v !== "string") invalidCursor();
  // Sort or filter tampering: the keyset is only meaningful under the order
  // and the set it was produced in.
  if (payload.f !== sort.f || payload.d !== sort.d || payload.q !== query) invalidCursor();
  // The sort is now known to be the one the caller asked for, so its value's
  // type is known too. Checked against what the database renders, never left
  // for the cast to reject — see isRenderedTimestamptz.
  if (payload.v !== null) {
    if (TIMESTAMP_SORTS.has(payload.f)) {
      if (!isRenderedTimestamptz(payload.v)) invalidCursor();
    } else if (payload.v.length > MAX_CURSOR_VALUE_LENGTH) invalidCursor();
  }
  return { value: payload.v, id: payload.i };
}

export function encodeCursor(
  cursor: KeysetCursor | null,
  sort: { f: string; d: "asc" | "desc" },
  query: string,
): string | null {
  if (!cursor) return null;
  const payload: CursorPayload = { f: sort.f, d: sort.d, q: query, v: cursor.value, i: cursor.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** `exactOptionalPropertyTypes` forbids `after: undefined`; omit the key instead. */
export function cursorSpread(after: KeysetCursor | undefined): { after?: KeysetCursor } {
  return after ? { after } : {};
}
