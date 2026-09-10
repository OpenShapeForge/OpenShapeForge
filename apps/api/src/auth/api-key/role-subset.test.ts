// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { parseRoleSubset } from "./store.js";

/**
 * `role_subset` used to be read two different ways. The key check went through
 * `parseRoleSubset`, which parses a jsonb *string* back into the array it
 * encodes; the key listing in `service.ts` did a bare `Array.isArray`, which a
 * string fails. A row written by the pre-fix writer therefore restricted the
 * key in use while showing itself as unrestricted in the overview — the one
 * shape below that the two readings disagree on.
 */
describe("parseRoleSubset", () => {
  test("reads a double-encoded subset as the array it encodes", () => {
    const stored = JSON.stringify(["Reader", "Writer"]);
    // What the overview used to do, and why it was wrong.
    expect(Array.isArray(stored)).toBe(false);
    expect(parseRoleSubset(stored)).toEqual(["Reader", "Writer"]);
  });

  test("reads a properly stored subset unchanged", () => {
    expect(parseRoleSubset(["Reader"])).toEqual(["Reader"]);
  });

  test("no subset stays no subset", () => {
    expect(parseRoleSubset(null)).toBeNull();
    expect(parseRoleSubset(undefined)).toBeNull();
  });

  test("a malformed or empty subset reads as no narrowing, never as an empty one", () => {
    // An empty array would authorize nothing and read as a mysterious 403.
    expect(parseRoleSubset("[]")).toBeNull();
    expect(parseRoleSubset([])).toBeNull();
    expect(parseRoleSubset("{not json")).toBeNull();
    expect(parseRoleSubset(["", "  "])).toBeNull();
    expect(parseRoleSubset(['"Reader"'])).toEqual(['"Reader"']);
  });
});
