// SPDX-License-Identifier: BUSL-1.1
/**
 * The opaque `after` cursor of the integration catalog: what it carries, and
 * what has to be true of it before any of it reaches a typed expression.
 *
 * It carries the previous page's last row by ID and by a DIGEST of its sort
 * value, never by the value itself. That is the decision this module turns on,
 * so it is worth stating why, because the alternative was tried here and did
 * not hold:
 *
 *   - `display_name` is `text`. Nothing in the schema bounds it, and the two
 *     surfaces that have been storing it since before this listing existed
 *     (`auth/api-key/rest-routes.ts`, `graphql-schema.ts`) bound it nowhere
 *     either — a `String!` and a `typeof body.displayName === "string"`. So
 *     rows exist whose name is longer than anything a cursor would like to
 *     carry, and new ones can still be written through those surfaces.
 *   - A cursor that carries the sort value is as long as that value, so every
 *     bound on such a cursor is a bound on a name some row may already hold.
 *     Any number chosen here makes the page listing that row emit a cursor it
 *     will not take back: the page is reachable and the page after it is not.
 *     Tightening the name instead would have been this listing silently
 *     narrowing two published contracts to suit its own paging.
 *   - An id is a uuid whatever the row says, and a digest of the value is 16
 *     characters whatever the value. One cursor is one length, the bound below
 *     is a bound on MALFORMED input and nothing else, and no stored value and
 *     no accepted input can push a page out of reach.
 *
 * The digest is what keeps the id-only anchor honest. Resolving the resume
 * value from the anchor row means resolving the row's CURRENT value, so a row
 * renamed between two pages moves the resume point with it — forwards, which
 * ends the listing early with rows unread, or backwards, which repeats them.
 * The digest cannot restore the old point, but it makes the move visible, and
 * `auth/api-key/catalog-page.ts` (`MOVED_ANCHOR`) refuses the page instead of
 * answering it short. See {@link sortValueDigest} for why that trade, and not a
 * value-carrying cursor, is the one available here: `sortValueDigest` in that
 * same module states it in full.
 *
 * It also takes caller-supplied text out of the typed expressions entirely.
 * The value half used to be cast to `timestamptz`
 * (`auth/api-key/catalog-page.ts`, `bind`), which answers `invalid input
 * syntax` or `field value out of range` for every spelling the validator and
 * PostgreSQL's input parser disagreed about — a 500 for a caller who supplied
 * a bad cursor. There is nothing left to disagree about: the only text a
 * caller supplies is the uuid checked below, and the value reaching the cast
 * came out of the row a statement earlier (`catalog-page.ts`,
 * `anchorValueQuery`).
 *
 * COMPATIBILITY, STATED: `v` is REQUIRED, so a cursor issued before the digest
 * existed — a payload with `f`, `d`, `q` and `i` and no `v` — is refused as
 * {@link UNUSABLE_CURSOR}, exactly like a tampered one. That is deliberate and
 * it is not free: a caller mid-walk across the deploy that adds this reads the
 * listing again from its first page. A cursor is a page token with a lifetime
 * of one walk rather than a stored identifier, so there is nothing persisted
 * to migrate; and the alternative — accepting a v-less cursor and skipping the
 * check for it — would keep the silently-short page this digest exists to stop
 * reachable for as long as any client held one. Refusing is the smaller cost
 * and the visible one. Nothing else about such a cursor changes: `i` is still
 * an anchor of the caller's own set, so the refusal discloses nothing.
 *
 * The keyset alone would be resumable under a DIFFERENT sort or filter, where
 * "everything after this row" means something else entirely and silently skips
 * or repeats rows. So the cursor also carries a fingerprint of the sort and the
 * filters it was issued for, and a request whose own sort or filters do not
 * match it is refused as a client error instead of answered with a page that
 * looks fine and is not.
 *
 * The fingerprint is a hash, so the cursor stays short, but it is NOT a
 * security boundary and is not relied on as one: the tenant comes from the
 * session and the subject from the request, both re-applied as SQL predicates
 * on every statement, so the worst a forged cursor can do is pick a different
 * resume point inside a set the caller may already read — and the anchor
 * lookup carries those same predicates, so an id belonging to another tenant
 * resolves to no row at all.
 */
import { createHash } from "node:crypto";
import {
  UNUSABLE_CURSOR,
  type PageAnchor,
} from "../auth/api-key/catalog-page.js";
import { ApiKeyValidationError } from "../auth/api-key/service.js";

/** What travels inside the base64url payload. */
type CursorPayload = {
  /** Sort field and direction this cursor was issued under. */
  f: string;
  d: "asc" | "desc";
  /** Fingerprint of the subject and filters. */
  q: string;
  /** The last row's id — the anchor the resume point is read from. */
  i: string;
  /** Digest of that row's sort value when the cursor was issued. */
  v: string;
};

/**
 * The 8-4-4-4-12 hex shape, deliberately NOT the stricter RFC 4122 pattern the
 * session layer applies: this only has to be a value the uuid type accepts, and
 * a row id is whatever the database minted, not something to re-validate.
 *
 * This is the one check standing between a request and a cast, since the anchor
 * is compared against a `uuid` column. Everything else in the payload is
 * compared for equality against a value this process computed.
 */
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The digest's own shape: 16 base64url characters, as `sortValueDigest`
 * (`auth/api-key/catalog-page.ts`) produces. Checked for shape only — it is then compared for equality against
 * a digest this process computes from the row, so an admissible value that was
 * never issued simply does not match.
 */
const CURSOR_DIGEST = /^[A-Za-z0-9_-]{16}$/;

/**
 * The JSON frame plus the longest `f`, `d`, `q`, `i` and `v` it can hold: 42
 * characters of punctuation, an 11-character sort field, a 4-character
 * direction, a 16-character query fingerprint, a 36-character uuid and a
 * 16-character value digest — 125. Rounded up to a round number, with room for
 * a field this payload may grow later.
 */
const CURSOR_ENVELOPE_BYTES = 160;

/**
 * The longest `after` string this listing can have produced, as base64 of the
 * payload above.
 *
 * Derived from the payload rather than picked, and the payload is a fixed set
 * of fixed-width fields, so this is a bound on malformed input — which is all
 * a cheap length check was ever for — and every cursor the listing issues fits
 * under it by construction, for every row in the table. The authored `after`
 * bound sits above this one, pinned by a test
 * (`api-key-operations.test.ts`).
 */
export const MAX_CURSOR_LENGTH = Math.ceil(CURSOR_ENVELOPE_BYTES / 3) * 4;

export function fingerprint(parts: readonly (string | undefined)[]): string {
  return createHash("sha256").update(JSON.stringify(parts.map((part) => part ?? null)))
    .digest("base64url").slice(0, 16);
}

function invalidCursor(): never {
  // One message for every rejection, here and at the anchor lookup — see
  // UNUSABLE_CURSOR.
  throw new ApiKeyValidationError(UNUSABLE_CURSOR);
}

export function decodeCursor(
  value: unknown,
  sort: { f: string; d: string },
  query: string,
): PageAnchor | undefined {
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
  if (typeof payload.v !== "string" || !CURSOR_DIGEST.test(payload.v)) invalidCursor();
  // Sort or filter tampering: the keyset is only meaningful under the order
  // and the set it was produced in.
  if (payload.f !== sort.f || payload.d !== sort.d || payload.q !== query) invalidCursor();
  return { id: payload.i, value: payload.v };
}

export function encodeCursor(
  cursor: PageAnchor | null,
  sort: { f: string; d: "asc" | "desc" },
  query: string,
): string | null {
  if (!cursor) return null;
  const payload: CursorPayload = {
    f: sort.f, d: sort.d, q: query, i: cursor.id, v: cursor.value,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** `exactOptionalPropertyTypes` forbids `after: undefined`; omit the key instead. */
export function cursorSpread(after: PageAnchor | undefined): { after?: PageAnchor } {
  return after ? { after } : {};
}
