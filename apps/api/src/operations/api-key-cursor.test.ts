// SPDX-License-Identifier: BUSL-1.1
/**
 * The cursor contract on its own: what `decodeCursor` lets through, and what
 * it refuses as a client error.
 *
 * What it lets through is one uuid and one 16-character digest. A cursor names
 * the previous page's last row by id and by a digest of that row's sort value,
 * never by the value (`api-key-cursor.ts`), which is what makes every cursor
 * one length and what takes caller-supplied text out of the typed expressions
 * the page builds. The tests below are the two halves of that:
 *
 *   - the anchor really is checked against something the `uuid` type accepts,
 *     because it is the one caller-supplied value that still reaches a cast;
 *   - a cursor carrying anything ELSE — a `v` of the kind this listing used to
 *     emit, an injected statement, a megabyte — cannot move the resume point.
 *     The digest is compared for EQUALITY against one the page computes from
 *     the row it read (`auth/api-key/catalog-page.ts`, `anchorDigest`), so an
 *     admissible-looking digest that was never issued refuses the page rather
 *     than resuming it somewhere; an inadmissible one does not get that far.
 *
 * The second one is the regression that matters. A value-carrying cursor was
 * cast to `timestamptz`, so every spelling the validator and PostgreSQL's
 * input parser disagreed about was a 500 for a caller who sent a bad cursor:
 *
 *     select '2026-02-29 00:00:00.000000+00'::timestamptz
 *       ERROR:  date/time field value out of range
 *     select '294277-01-01 00:00:00.000000+00'::timestamptz
 *       ERROR:  timestamp out of range
 *
 * Both are perfectly shaped, which is why the shape test that guarded them was
 * not enough and why the calendar had to be counted in JavaScript. None of
 * that is reachable now, and these tests say so by sending those very values
 * and watching them be ignored.
 *
 * No database and no realm — these are pure functions. That a page RESOLVES an
 * anchor against the row it names, under the tenant and the subject binding,
 * is a property of the SQL and is proven against a real PostgreSQL in
 * `api-key-cursor-db.test.ts` and `api-key-catalog-db.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ApiKeyValidationError } from "../auth/api-key/service.js";
import {
  decodeCursor,
  encodeCursor,
  fingerprint,
  MAX_CURSOR_LENGTH,
} from "./api-key-cursor.js";

const SORTS = ["displayName", "status", "createdAt", "updatedAt", "expiresAt", "lastUsedAt"] as const;
const DIRECTIONS = ["asc", "desc"] as const;

const QUERY = fingerprint(["integrations", undefined, undefined]);
/**
 * A digest of the shape the listing issues. Its VALUE is the database's
 * business (`auth/api-key/catalog-page.ts`, `sortValueDigest`); what this file
 * decides is which shapes the decoder lets reach the page at all.
 */
const DIGEST = "bD0Or6VNxYTDUslg";

function forge(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("decodeCursor across both listings and both directions", () => {
  for (const field of SORTS) {
    for (const direction of DIRECTIONS) {
      test(`${field} ${direction}: reads the anchor and the digest, nothing else`, () => {
        const id = randomUUID();
        expect(decodeCursor(forge({ f: field, d: direction, q: QUERY, i: id, v: DIGEST }), {
          f: field,
          d: direction,
        }, QUERY)).toEqual({ id, value: DIGEST });

        // Values of the kind that used to reach a `timestamptz` cast, carried
        // in `v` on a cursor that is otherwise well formed. None of them is a
        // digest, so none of them gets past the decoder at all — and a digest
        // never reaches a cast in the first place: the page compares it for
        // equality against one it computed from the row it read.
        for (const value of [
          "now()", "infinity", "yesterday", "'); select 1 --", null, 42,
          "2026-02-29 00:00:00.000000+00", DIGEST.slice(0, 15), `${DIGEST}A`, `${DIGEST.slice(0, 15)}+`,
        ]) {
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
    for (const id of [
      "",
      "not-a-uuid",
      "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
      `${randomUUID()} `,
      `${randomUUID()}'); drop table platform.api_keys --`,
      randomUUID().replace("-", ""),
      42,
      null,
    ]) {
      expect(() => decodeCursor(
        forge({ f: "createdAt", d: "asc", q: QUERY, i: id, v: DIGEST }),
        { f: "createdAt", d: "asc" },
        QUERY,
      )).toThrow(ApiKeyValidationError);
    }
  });

  test("refuses a cursor longer than the payload allows, unparsed", () => {
    // The cheap length check is a bound on MALFORMED input and nothing else
    // now: the payload is a fixed set of fixed-width fields, so there is no
    // row and no accepted input that can push a real cursor past it.
    for (const value of [
      "A".repeat(MAX_CURSOR_LENGTH + 1),
      "A".repeat(1_000_000),
      // A well-formed cursor with a sort value stuffed into it: the spelling
      // that used to be a 500 is now refused before `JSON.parse`, and so is a
      // megabyte of it.
      forge({
        f: "displayName",
        d: "asc",
        q: QUERY,
        v: "2026-02-29 00:00:00.000000+00",
        i: randomUUID(),
      }),
      forge({ f: "displayName", d: "asc", q: QUERY, v: "x".repeat(100_000), i: randomUUID() }),
    ]) {
      expect(() => decodeCursor(value, { f: "displayName", d: "asc" }, QUERY))
        .toThrow(ApiKeyValidationError);
    }
    // And the widest cursor this listing can issue fits under it, with the
    // longest sort field, the longest direction, a full fingerprint, a uuid
    // and a digest — which is the same 16 characters for a name of 20,000.
    const widest = encodeCursor(
      { id: randomUUID(), value: DIGEST },
      { f: "displayName", d: "desc" },
      fingerprint(["credentials", randomUUID(), "x", "active"]),
    )!;
    expect(widest.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH);
  });

  test("refuses a payload that is not an object with an anchor", () => {
    for (const payload of ["[]", '"x"', "7", "null", "{}", "not base64 at all !!"]) {
      expect(() => decodeCursor(
        Buffer.from(payload, "utf8").toString("base64url"),
        { f: "createdAt", d: "asc" },
        QUERY,
      )).toThrow(ApiKeyValidationError);
    }
  });

  test("still refuses a cursor from another sort, direction or filter", () => {
    const cursor = encodeCursor(
      { id: randomUUID(), value: DIGEST }, { f: "createdAt", d: "asc" }, QUERY,
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
      { f: "createdAt", d: "asc", q: QUERY, i: "not-a-uuid", v: DIGEST },
      { f: "createdAt", d: "desc", q: QUERY, i: randomUUID(), v: DIGEST },
      { f: "createdAt", d: "asc", q: fingerprint(["other"]), i: randomUUID(), v: DIGEST },
      { f: "createdAt", d: "asc", q: QUERY, i: randomUUID(), v: "not-a-digest" },
      { f: "createdAt", d: "asc", q: QUERY, i: randomUUID() },
      {},
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
    for (const field of SORTS) {
      for (const direction of DIRECTIONS) {
        const anchor = { id: randomUUID(), value: DIGEST };
        const encoded = encodeCursor(anchor, { f: field, d: direction }, QUERY)!;
        expect(decodeCursor(encoded, { f: field, d: direction }, QUERY)).toEqual(anchor);
        // One length, whatever the sort and whatever the row — the digest is
        // 16 characters for a name of any size: that is the property an
        // id-and-digest cursor buys over a value-carrying one.
        expect(encoded.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH);
      }
    }
    expect(encodeCursor(null, { f: "createdAt", d: "asc" }, QUERY)).toBeNull();
  });

  test("an absent cursor is the first page, not a refusal", () => {
    expect(decodeCursor(undefined, { f: "createdAt", d: "asc" }, QUERY)).toBeUndefined();
  });
});
