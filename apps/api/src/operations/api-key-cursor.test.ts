// SPDX-License-Identifier: BUSL-1.1
/**
 * The cursor contract on its own: what `decodeCursor` lets through to a typed
 * expression, and what it refuses as a client error.
 *
 * The accepted set is NOT "everything PostgreSQL can render". The listing
 * renders a timestamp sort's value itself, with an explicit template against
 * UTC (`auth/api-key/catalog-page.ts`, `renderSortValue`), so there is exactly
 * one spelling it can issue and everything else — including the `+05:30` and
 * `+00:19:32` and bare-second forms `timestamptz::text` really does produce
 * under other session settings — is a cursor this listing did not hand out.
 * Narrow on purpose: the check is only worth having if it admits the listing's
 * own cursors and nothing more.
 *
 * Every "refuses" case below is either such a form or one PostgreSQL answers
 * with an error, which reached through a cursor used to be a 500:
 *
 *     select '2026-02-29 00:00:00.000000+00'::timestamptz
 *       ERROR:  date/time field value out of range
 *     select '294277-01-01 00:00:00.000000+00'::timestamptz
 *       ERROR:  timestamp out of range
 *
 * `2026-99-99 99:99:99.000000+00` and `2026-02-29 00:00:00.000000+00` are both
 * perfectly shaped, which is why a shape test alone was not enough: the fields
 * have to be counted against the calendar.
 *
 * No database and no realm — these are pure functions and this is the one place
 * the matrix can be stated exhaustively. That the DATABASE renders exactly this
 * form, under any DateStyle and any TimeZone, and that a name the contract
 * permits still pages, are properties of the SQL and are proven against a real
 * PostgreSQL in `api-key-cursor-db.test.ts` and `api-key-dispatcher-db.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ApiKeyValidationError, MAX_DISPLAY_NAME_LENGTH } from "../auth/api-key/service.js";
import {
  decodeCursor,
  encodeCursor,
  fingerprint,
  isCursorTimestamp,
} from "./api-key-cursor.js";

/** Every sort whose cursor value is cast back to timestamptz. */
const TIMESTAMP_SORTS = ["createdAt", "updatedAt", "expiresAt", "lastUsedAt"] as const;
/** Every sort whose cursor value stays text. */
const TEXT_SORTS = ["displayName", "status"] as const;
const DIRECTIONS = ["asc", "desc"] as const;

const QUERY = fingerprint(["integrations", undefined, undefined]);

/**
 * A display name at the contract's limit, in code points that are NOT one
 * UTF-16 unit each. 200 emoji are 200 characters to the input schema, 400 units
 * to `String.length` and 800 bytes to UTF-8 — the realistic name that used to
 * make the next page unreachable.
 */
const MAX_EMOJI_NAME = "🎉".repeat(MAX_DISPLAY_NAME_LENGTH);

function forge(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("the one form a timestamp sort's cursor carries", () => {
  const renders = [
    // The form `renderSortValue` emits: fixed-width fields, six fraction
    // digits whether or not they are zero, and the displacement always +00.
    "2026-10-28 02:01:45.000000+00",
    "2026-10-28 02:01:45.123456+00",
    // Leap days, every rule of them: divisible by four, by a hundred, by four
    // hundred.
    "2024-02-29 00:00:00.000000+00",
    "2000-02-29 00:00:00.000000+00",
    "2400-02-29 00:00:00.000000+00",
    // The edges of the calendar within a year.
    "2026-01-01 00:00:00.000000+00",
    "2026-12-31 23:59:59.999999+00",
    "2026-02-28 00:00:00.000000+00",
    "2026-04-30 00:00:00.000000+00",
    // The ends of the type. The template writes as many year digits as the
    // year has, and `294276-12-31 23:59:59.999999+00` is the last instant
    // timestamptz holds.
    "0001-01-01 00:00:00.000000+00",
    "294276-12-31 23:59:59.999999+00",
  ];
  for (const value of renders) {
    test(`accepts ${value}`, () => {
      expect(isCursorTimestamp(value)).toBe(true);
    });
  }

  const impossible: [string, string][] = [
    ["2026-99-99 99:99:99.000000+00", "every field out of range, perfectly shaped"],
    ["2026-13-01 00:00:00.000000+00", "a thirteenth month"],
    ["2026-00-01 00:00:00.000000+00", "a zeroth month"],
    ["2026-01-00 00:00:00.000000+00", "a zeroth day"],
    ["2026-01-32 00:00:00.000000+00", "a thirty-second January"],
    ["2026-02-29 00:00:00.000000+00", "February 29th of a common year"],
    ["2100-02-29 00:00:00.000000+00", "February 29th of a century that is not a leap year"],
    ["2026-04-31 00:00:00.000000+00", "a thirty-first April"],
    ["0000-01-01 00:00:00.000000+00", "year zero"],
    ["294277-01-01 00:00:00.000000+00", "a year past the end of timestamptz"],
    ["1234567-01-01 00:00:00.000000+00", "a seven-digit year"],
    ["2026-01-01 24:00:00.000000+00", "an hour PostgreSQL rolls over rather than renders"],
    ["2026-01-01 00:60:00.000000+00", "a sixtieth minute"],
    ["2026-01-01 00:00:60.000000+00", "a second PostgreSQL rolls over rather than renders"],
    // Forms `timestamptz::text` really does produce under other session
    // settings, and the listing's own projection therefore never does.
    ["2026-10-28 02:01:45+00", "no fraction, as DateStyle ISO renders a whole second"],
    ["2026-10-28 02:01:45.1+00", "a trimmed fraction"],
    ["2026-07-01 02:00:00.000000+02", "a session zone's whole-hour displacement"],
    ["2026-07-01 02:00:00.000000+05:30", "a half-hour displacement"],
    ["1850-01-01 00:19:32.000000+00:19:32", "a local-mean-time displacement with seconds"],
    ["28.10.2026 02:01:45.000000+00", "the German DateStyle's rendering"],
    ["2026-01-01 00:00:00.000000+16", "a displacement past PostgreSQL's limit"],
    ["2026-10-28T02:01:45.000000+00", "the ISO T separator, which this template never writes"],
    ["2026-10-28 02:01:45.000000Z", "a Z suffix, which this template never writes"],
    ["2026-10-28 02:01:45.000000", "no offset at all"],
    ["2026-10-28 02:01:45.1234567+00", "more precision than timestamptz keeps"],
    ["2026-10-28 02:01:45.000000+00 ", "a trailing space"],
    [" 2026-10-28 02:01:45.000000+00", "a leading space"],
    ["2026-10-28 02:01:45.000000+00'); select 1 --", "a value with a statement appended"],
    ["2026-10-28 02:01:45.000000+00\n", "a trailing newline"],
    ["now()", "an expression instead of a value"],
    ["yesterday", "a word PostgreSQL would otherwise happily parse"],
    ["infinity", "the special value, which no row renders"],
    ["", "nothing"],
  ];
  for (const [value, why] of impossible) {
    test(`refuses ${JSON.stringify(value)} — ${why}`, () => {
      expect(isCursorTimestamp(value)).toBe(false);
    });
  }
});

describe("decodeCursor across both listings and both directions", () => {
  // The crafted value this whole check exists for, plus the shaped-but-unreal
  // date that a pure regular expression cannot catch.
  const rejected = [
    "2026-99-99 99:99:99.000000+00",
    "2026-02-29 00:00:00.000000+00",
    "yesterday",
  ];

  for (const field of TIMESTAMP_SORTS) {
    for (const direction of DIRECTIONS) {
      test(`${field} ${direction}: refuses an impossible timestamp, accepts a rendered one`, () => {
        const id = randomUUID();
        for (const value of rejected) {
          expect(() => decodeCursor(
            forge({ f: field, d: direction, q: QUERY, v: value, i: id }),
            { f: field, d: direction },
            QUERY,
          )).toThrow(ApiKeyValidationError);
        }
        // A leap day and the last instant of the type: both real, both must pass.
        for (const value of ["2024-02-29 12:00:00.000000+00", "294276-12-31 23:59:59.999999+00"]) {
          expect(decodeCursor(
            forge({ f: field, d: direction, q: QUERY, v: value, i: id }),
            { f: field, d: direction },
            QUERY,
          )).toEqual({ value, id });
        }
        // The NULL block — "no expiry", "never used" — is still resumable.
        expect(decodeCursor(
          forge({ f: field, d: direction, q: QUERY, v: null, i: id }),
          { f: field, d: direction },
          QUERY,
        )).toEqual({ value: null, id });
      });
    }
  }

  for (const field of TEXT_SORTS) {
    for (const direction of DIRECTIONS) {
      test(`${field} ${direction}: a text value is bounded by the name, not by its units`, () => {
        const id = randomUUID();
        // The same string that is refused as a timestamp is an ordinary
        // display name here, and must still page.
        for (const value of ["2026-99-99 99:99:99+99", "partner portal", "active"]) {
          expect(decodeCursor(
            forge({ f: field, d: direction, q: QUERY, v: value, i: id }),
            { f: field, d: direction },
            QUERY,
          )).toEqual({ value, id });
        }
        // A name at the contract's limit whose code points are two UTF-16
        // units each: 400 units, 800 bytes, and a cursor well past the fixed
        // 512-character ceiling that used to refuse it.
        expect(decodeCursor(
          forge({ f: field, d: direction, q: QUERY, v: MAX_EMOJI_NAME, i: id }),
          { f: field, d: direction },
          QUERY,
        )).toEqual({ value: MAX_EMOJI_NAME, id });
        // Lowercasing can double a name's length, and that is the whole
        // allowance: one code point more is not a value this listing sorted on.
        const widest = "x".repeat(MAX_DISPLAY_NAME_LENGTH * 2);
        expect(decodeCursor(
          forge({ f: field, d: direction, q: QUERY, v: widest, i: id }),
          { f: field, d: direction },
          QUERY,
        )).toEqual({ value: widest, id });
        for (const value of [`${widest}x`, "🎉".repeat(MAX_DISPLAY_NAME_LENGTH * 2 + 1)]) {
          expect(() => decodeCursor(
            forge({ f: field, d: direction, q: QUERY, v: value, i: id }),
            { f: field, d: direction },
            QUERY,
          )).toThrow(ApiKeyValidationError);
        }
      });
    }
  }

  test("refuses an id that is not something the uuid type accepts", () => {
    for (const id of ["", "not-a-uuid", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", `${randomUUID()} `]) {
      expect(() => decodeCursor(
        forge({ f: "createdAt", d: "asc", q: QUERY, v: "2026-01-01 00:00:00.000000+00", i: id }),
        { f: "createdAt", d: "asc" },
        QUERY,
      )).toThrow(ApiKeyValidationError);
    }
  });

  test("refuses a cursor far longer than any this listing can produce, unparsed", () => {
    // The cheap length check is still a bound on malformed input: it is now
    // derived from the widest payload the value bound allows rather than
    // guessed, so it refuses a megabyte before `JSON.parse` sees it.
    expect(() => decodeCursor(
      "A".repeat(1_000_000),
      { f: "displayName", d: "asc" },
      QUERY,
    )).toThrow(ApiKeyValidationError);
    expect(() => decodeCursor(
      forge({ f: "displayName", d: "asc", q: QUERY, v: "x".repeat(100_000), i: randomUUID() }),
      { f: "displayName", d: "asc" },
      QUERY,
    )).toThrow(ApiKeyValidationError);
  });

  test("still refuses a cursor from another sort, direction or filter", () => {
    const cursor = encodeCursor(
      { value: "2026-01-01 00:00:00.000000+00", id: randomUUID() },
      { f: "createdAt", d: "asc" },
      QUERY,
    )!;
    expect(() => decodeCursor(cursor, { f: "updatedAt", d: "asc" }, QUERY))
      .toThrow(ApiKeyValidationError);
    expect(() => decodeCursor(cursor, { f: "createdAt", d: "desc" }, QUERY))
      .toThrow(ApiKeyValidationError);
    expect(() => decodeCursor(cursor, { f: "createdAt", d: "asc" }, fingerprint(["other"])))
      .toThrow(ApiKeyValidationError);
  });

  test("names only that the cursor was rejected, never which half gave it away", () => {
    const messages = new Set<string>();
    for (const payload of [
      { f: "createdAt", d: "asc", q: QUERY, v: "2026-02-29 00:00:00.000000+00", i: randomUUID() },
      { f: "createdAt", d: "asc", q: QUERY, v: "2026-01-01 00:00:00.000000+00", i: "not-a-uuid" },
      { f: "displayName", d: "asc", q: QUERY, v: "x", i: randomUUID() },
    ]) {
      try {
        decodeCursor(forge(payload), { f: "createdAt", d: "asc" }, QUERY);
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });

  test("what encodeCursor produces is what decodeCursor accepts", () => {
    for (const field of [...TIMESTAMP_SORTS, ...TEXT_SORTS]) {
      for (const direction of DIRECTIONS) {
        for (const value of TIMESTAMP_SORTS.includes(field as never)
          ? ["2026-10-28 02:01:45.123456+00"]
          : ["partner portal", MAX_EMOJI_NAME]) {
          const keyset = { value, id: randomUUID() };
          const encoded = encodeCursor(keyset, { f: field, d: direction }, QUERY)!;
          expect(decodeCursor(encoded, { f: field, d: direction }, QUERY)).toEqual(keyset);
        }
      }
    }
    expect(encodeCursor(null, { f: "createdAt", d: "asc" }, QUERY)).toBeNull();
  });

  test("an absent cursor is the first page, not a refusal", () => {
    expect(decodeCursor(undefined, { f: "createdAt", d: "asc" }, QUERY)).toBeUndefined();
  });
});
