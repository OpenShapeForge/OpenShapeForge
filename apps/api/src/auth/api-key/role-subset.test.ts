// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { parseRoleSubset } from "./store.js";

/**
 * The key check and the key listing read `role_subset` through this one
 * function, so a key restricts itself in use exactly as the overview shows.
 */
describe("parseRoleSubset", () => {
  test("reads a stored subset unchanged", () => {
    expect(parseRoleSubset(["Reader"])).toEqual(["Reader"]);
  });

  test("no subset stays no subset", () => {
    expect(parseRoleSubset(null)).toBeNull();
    expect(parseRoleSubset(undefined)).toBeNull();
  });

  test("a malformed or empty subset reads as no narrowing, never as an empty one", () => {
    // An empty array would authorize nothing and read as a mysterious 403.
    expect(parseRoleSubset([])).toBeNull();
    expect(parseRoleSubset("[\"Reader\"]")).toBeNull();
    expect(parseRoleSubset(["", "  "])).toBeNull();
    expect(parseRoleSubset(['"Reader"'])).toEqual(['"Reader"']);
  });
});
