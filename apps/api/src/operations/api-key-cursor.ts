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
 * checked here, before anything is bound.
 *
 * What they are checked against is the ONE spelling the listing emits, not
 * everything the database could emit or its input parser could read. The page
 * renders a timestamp sort's value with an explicit template against UTC
 * (`catalog-page.ts`, `renderSortValue`), and a text sort's value is bounded by
 * the display name the service agreed to store (`service.ts`,
 * `MAX_DISPLAY_NAME_LENGTH`). Both checks are DERIVED from those two facts
 * rather than guessed, which is the property that matters: every cursor a
 * listing hands out is one it will take back, and everything else is refused
 * before it is parsed.
 *
 * Nothing is normalized on the way back in. The resume predicate compares the
 * value for EQUALITY to find the tie-break block (`catalog-page.ts`,
 * `keysetPredicate`), so a cursor is accepted verbatim or refused: rewriting it
 * into some canonical spelling would move the resume point.
 */
import { createHash } from "node:crypto";
import type { KeysetCursor } from "../auth/api-key/catalog-page.js";
import { daysInMonth } from "../db/timestamps.js";
import {
  ApiKeyValidationError,
  codePointLength,
  MAX_DISPLAY_NAME_LENGTH,
} from "../auth/api-key/service.js";

/** What travels inside the base64url payload. */
type CursorPayload = {
  /** Sort field and direction this cursor was issued under. */
  f: string;
  d: "asc" | "desc";
  /** Fingerprint of the subject and filters. */
  q: string;
  /** The last row's sort value as the listing rendered it; null in the NULL block. */
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
 * The ONE spelling a timestamp sort's cursor value has, split into its fields.
 *
 * Not "a timestamptz PostgreSQL might render": the listing renders it with an
 * explicit `to_char` template against UTC (`catalog-page.ts`,
 * `renderSortValue`) precisely so that it does not depend on the session's
 * `DateStyle` or `TimeZone`, and this is that template read back. Fixed-width
 * fields, the fraction always present at six digits, the displacement always
 * `+00`. Anything else is a cursor this listing did not issue — including every
 * other form the input parser would happily accept.
 *
 * This is still only the SHAPE. A shape test alone is what let
 * `2026-99-99 99:99:99+99` reach the cast, and `2026-02-29 00:00:00+00` with
 * it: shaped perfectly, and still PostgreSQL's "date/time field value out of
 * range" because 2026 is not a leap year. Every field is range-checked below.
 */
const CURSOR_TIMESTAMP = /^(\d{4,6})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d{6}\+00$/;

/**
 * The last year `timestamptz` holds: `294276-12-31 23:59:59.999999+00` casts,
 * `294277-01-01 00:00:00.000000+00` is "timestamp out of range". The template
 * above writes as many digits as the year has, so the bound is checked rather
 * than assumed from four digits.
 */
const MAX_TIMESTAMPTZ_YEAR = 294_276;

/**
 * Is this exactly the value a timestamp sort's cursor carries?
 *
 * Shape first, then every field against the calendar — which is where the
 * month, the day (February of a leap year included) and the year's upper bound
 * are decided, because a regular expression cannot count days in a month.
 */
export function isCursorTimestamp(value: string): boolean {
  const match = CURSOR_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (Number(year) > MAX_TIMESTAMPTZ_YEAR) return false;
  const days = daysInMonth(Number(year), Number(month));
  if (days === undefined) return false;
  if (Number(day) < 1 || Number(day) > days) return false;
  // The rendered form only: a normalized time has no hour 24 and no second 60.
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

/** The sorts whose value is a timestamp rather than text (service.ts). */
const TIMESTAMP_SORTS = new Set(["createdAt", "updatedAt", "expiresAt", "lastUsedAt"]);

/**
 * Full Unicode lowercase mapping can LENGTHEN a string: `İ` (U+0130)
 * lowercases to `i` followed by U+0307, two code points for one. Two is the
 * longest lowercase mapping Unicode defines, and an ICU collation applies it
 * where libc does not, so `lower(display_name)` is at most twice the name.
 */
const LOWERCASE_GROWTH = 2;

/**
 * The longest text sort value a cursor may carry, in code points.
 *
 * `lower(display_name)` is the only text sort value — `status` is one short
 * word — so the bound is the service's own display-name bound, grown by what
 * lowercasing can add. Measured in code points because that is what bounds the
 * name: 200 emoji are 200 characters to the contract and 400 UTF-16 units to
 * `String.length`, and comparing units against a character bound is what
 * refused this listing's own cursor for a name it had just accepted.
 */
const MAX_CURSOR_VALUE_LENGTH = MAX_DISPLAY_NAME_LENGTH * LOWERCASE_GROWTH;

/**
 * The JSON frame plus the longest `f`, `d`, `q` and `i` it can hold: 34
 * characters of punctuation, an 11-character sort field, a 4-character
 * direction, a 16-character fingerprint and a 36-character uuid.
 */
const CURSOR_ENVELOPE_BYTES = 128;

/** `"\u0000"` — the longest escape `JSON.stringify` writes for one code point. */
const ESCAPE_BYTES_PER_CODE_POINT = 6;

/**
 * The longest `after` string this listing can have produced, DERIVED rather
 * than picked: the widest payload the bounds above allow, as base64.
 *
 * A fixed ceiling is what made a valid page unreachable. A display name of 200
 * emoji is 800 UTF-8 bytes, so its cursor is some 1.1 kB of base64 — past any
 * 512-character guess, and refused before it was ever parsed, for a name the
 * contract permits and the database holds. Deriving the ceiling keeps the cheap
 * length check a bound on MALFORMED input, which is all it was ever for, while
 * every cursor the listing issues fits under it by construction.
 */
export const MAX_CURSOR_LENGTH = Math.ceil(
  (CURSOR_ENVELOPE_BYTES + MAX_CURSOR_VALUE_LENGTH * ESCAPE_BYTES_PER_CODE_POINT) / 3,
) * 4;

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
  if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH) invalidCursor();
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
  // type is known too. Checked against what the listing renders, never left
  // for the cast to reject — see isCursorTimestamp.
  if (payload.v !== null) {
    if (TIMESTAMP_SORTS.has(payload.f)) {
      if (!isCursorTimestamp(payload.v)) invalidCursor();
    } else if (codePointLength(payload.v) > MAX_CURSOR_VALUE_LENGTH) invalidCursor();
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
