// SPDX-License-Identifier: BUSL-1.1
/**
 * The cursor contract on its own: what `decodeCursor` lets through to a typed
 * expression, and what it refuses as a client error.
 *
 * The values here are not invented. Every "accepts" case below is built from a
 * date, time and offset form PostgreSQL 17 was observed to produce for
 * `timestamptz::text` under DateStyle ISO — `+00` and `+02` and `-07`,
 * `+05:30` and `+05:45` and `-03:30`, and the `+00:19:32` it renders for a
 * pre-1900 instant in a zone that still kept local mean time — plus the widest
 * displacement it accepts at all. Every "refuses" case is one it answers with
 * an error, which reached through a cursor used to be a 500:
 *
 *     select ('2026-02-29 00:00:00+00'::timestamptz)::text
 *       ERROR:  date/time field value out of range
 *     select ('2026-01-01 00:00:00+16'::timestamptz)::text
 *       ERROR:  time zone displacement out of range
 *
 * `2026-99-99 99:99:99+99` and `2026-02-29 00:00:00+00` are both perfectly
 * shaped, which is why a shape test alone was not enough: the fields have to
 * be counted against the calendar.
 *
 * No database and no realm — this is a pure function and the one place the
 * matrix can be stated exhaustively. The cursors a real listing issues are
 * walked against a real PostgreSQL in `api-key-dispatcher-db.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ApiKeyValidationError } from "../auth/api-key/service.js";
import {
  decodeCursor,
  encodeCursor,
  fingerprint,
  isRenderedTimestamptz,
} from "./api-key-cursor.js";

/** Every sort whose cursor value is cast back to timestamptz. */
const TIMESTAMP_SORTS = ["createdAt", "updatedAt", "expiresAt", "lastUsedAt"] as const;
/** Every sort whose cursor value stays text. */
const TEXT_SORTS = ["displayName", "status"] as const;
const DIRECTIONS = ["asc", "desc"] as const;

const QUERY = fingerprint(["integrations", undefined, undefined]);

function forge(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("what PostgreSQL can have rendered", () => {
  const renders = [
    // The ordinary shapes, as the default UTC session renders them.
    "2026-10-28 02:01:45+00",
    "2026-10-28 02:01:45.1+00",
    "2026-10-28 02:01:45.123456+00",
    // A session in another zone, including the half-hour and quarter-hour ones.
    "2026-07-01 02:00:00+02",
    "2026-07-01 02:00:00+05:30",
    "2026-07-01 02:00:00+05:45",
    "2026-07-01 02:00:00-08",
    "2026-07-01 02:00:00-03:30",
    // A pre-1900 instant in a zone whose offset was local mean time, which
    // PostgreSQL renders with SECONDS of offset.
    "1850-01-01 00:19:32+00:19:32",
    // The widest displacement PostgreSQL accepts at all.
    "2026-01-01 00:00:00+15:59:59",
    "2026-01-01 00:00:00-15:59:59",
    // Leap days, every rule of them: divisible by four, by a hundred, by four
    // hundred.
    "2024-02-29 00:00:00+00",
    "2000-02-29 00:00:00+00",
    "2400-02-29 00:00:00+00",
    // The edges of the calendar within a year.
    "2026-01-01 00:00:00+00",
    "2026-12-31 23:59:59.999999+00",
    "2026-02-28 00:00:00+00",
    "2026-04-30 00:00:00+00",
  ];
  for (const value of renders) {
    test(`accepts ${value}`, () => {
      expect(isRenderedTimestamptz(value)).toBe(true);
    });
  }

  const impossible: [string, string][] = [
    ["2026-99-99 99:99:99+99", "every field out of range, perfectly shaped"],
    ["2026-13-01 00:00:00+00", "a thirteenth month"],
    ["2026-00-01 00:00:00+00", "a zeroth month"],
    ["2026-01-00 00:00:00+00", "a zeroth day"],
    ["2026-01-32 00:00:00+00", "a thirty-second January"],
    ["2026-02-29 00:00:00+00", "February 29th of a common year"],
    ["2100-02-29 00:00:00+00", "February 29th of a century that is not a leap year"],
    ["2026-04-31 00:00:00+00", "a thirty-first April"],
    ["0000-01-01 00:00:00+00", "year zero"],
    ["2026-01-01 24:00:00+00", "an hour PostgreSQL rolls over rather than renders"],
    ["2026-01-01 00:60:00+00", "a sixtieth minute"],
    ["2026-01-01 00:00:60+00", "a second PostgreSQL rolls over rather than renders"],
    ["2026-01-01 00:00:00+16", "a displacement past PostgreSQL's limit"],
    ["2026-01-01 00:00:00+15:60", "a sixtieth minute of offset"],
    ["2026-01-01 00:00:00+15:59:60", "a sixtieth second of offset"],
    ["2026-10-28T02:01:45+00", "the ISO T separator, which this column never renders"],
    ["2026-10-28 02:01:45Z", "a Z suffix, which this column never renders"],
    ["2026-10-28 02:01:45", "no offset at all"],
    ["2026-10-28 02:01:45.1234567+00", "more precision than timestamptz keeps"],
    ["2026-10-28 02:01:45+00 ", "a trailing space"],
    [" 2026-10-28 02:01:45+00", "a leading space"],
    ["2026-10-28 02:01:45+00'); select 1 --", "a value with a statement appended"],
    ["2026-10-28 02:01:45+00\n", "a trailing newline"],
    ["now()", "an expression instead of a value"],
    ["yesterday", "a word PostgreSQL would otherwise happily parse"],
    ["infinity", "the special value, which no row renders"],
    ["", "nothing"],
  ];
  for (const [value, why] of impossible) {
    test(`refuses ${JSON.stringify(value)} — ${why}`, () => {
      expect(isRenderedTimestamptz(value)).toBe(false);
    });
  }
});

describe("decodeCursor across both listings and both directions", () => {
  // The crafted value this whole check exists for, plus the shaped-but-unreal
  // date that a pure regular expression cannot catch.
  const rejected = ["2026-99-99 99:99:99+99", "2026-02-29 00:00:00+00", "yesterday"];

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
        // Leap day and an offset with seconds: both real, both must pass.
        for (const value of ["2024-02-29 12:00:00+00", "1850-01-01 00:19:32+00:19:32"]) {
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
      test(`${field} ${direction}: a text value is not held to the timestamp shape`, () => {
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
        // But not an unbounded one: no display name this listing sorted on is
        // longer than the authored maximum.
        expect(() => decodeCursor(
          forge({ f: field, d: direction, q: QUERY, v: "x".repeat(201), i: id }),
          { f: field, d: direction },
          QUERY,
        )).toThrow(ApiKeyValidationError);
      });
    }
  }

  test("refuses an id that is not something the uuid type accepts", () => {
    for (const id of ["", "not-a-uuid", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", `${randomUUID()} `]) {
      expect(() => decodeCursor(
        forge({ f: "createdAt", d: "asc", q: QUERY, v: "2026-01-01 00:00:00+00", i: id }),
        { f: "createdAt", d: "asc" },
        QUERY,
      )).toThrow(ApiKeyValidationError);
    }
  });

  test("still refuses a cursor from another sort, direction or filter", () => {
    const cursor = encodeCursor(
      { value: "2026-01-01 00:00:00+00", id: randomUUID() },
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
      { f: "createdAt", d: "asc", q: QUERY, v: "2026-02-29 00:00:00+00", i: randomUUID() },
      { f: "createdAt", d: "asc", q: QUERY, v: "2026-01-01 00:00:00+00", i: "not-a-uuid" },
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
        const keyset = {
          value: TIMESTAMP_SORTS.includes(field as never)
            ? "2026-10-28 02:01:45.123456+00"
            : "partner portal",
          id: randomUUID(),
        };
        const encoded = encodeCursor(keyset, { f: field, d: direction }, QUERY)!;
        expect(decodeCursor(encoded, { f: field, d: direction }, QUERY)).toEqual(keyset);
      }
    }
    expect(encodeCursor(null, { f: "createdAt", d: "asc" }, QUERY)).toBeNull();
  });

  test("an absent cursor is the first page, not a refusal", () => {
    expect(decodeCursor(undefined, { f: "createdAt", d: "asc" }, QUERY)).toBeUndefined();
  });
});
