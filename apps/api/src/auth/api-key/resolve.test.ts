// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { integrationRoles, intersectRoles } from "./resolve.js";
import { isRoleFreeIntegration } from "./store.js";

test("only explicit empty integration grants remove Keycloak defaults", () => {
  for (const stored of [null, undefined, ["A"], "invalid"]) {
    expect(isRoleFreeIntegration(stored)).toBe(false);
    expect(integrationRoles(["A", "B"], null, isRoleFreeIntegration(stored))).toEqual(["A", "B"]);
    expect(integrationRoles(["A", "B"], ["B"], isRoleFreeIntegration(stored))).toEqual(["B"]);
  }
  expect(isRoleFreeIntegration([])).toBe(true);
  expect(integrationRoles(["default", "A"], null, true)).toEqual([]);
  expect(integrationRoles(["default", "A"], ["A"], true)).toEqual([]);
});

describe("intersectRoles", () => {
  test("a null subset passes the granted roles through unchanged", () => {
    expect(intersectRoles(["A", "B"], null)).toEqual(["A", "B"]);
  });

  test("a subset narrows to the overlap", () => {
    expect(intersectRoles(["A", "B", "C"], ["B", "C"])).toEqual(["B", "C"]);
  });

  test("a subset cannot widen beyond what the service account holds", () => {
    // This is the property the whole design rests on: a key row written when
    // the integration held more roles must not resurrect them.
    expect(intersectRoles(["A"], ["A", "B", "SuperAdmin"])).toEqual(["A"]);
    expect(intersectRoles([], ["A", "B"])).toEqual([]);
  });

  test("a subset naming only unheld roles authorizes nothing", () => {
    expect(intersectRoles(["A"], ["B"])).toEqual([]);
  });

  test("does not mutate its inputs", () => {
    const granted = ["A", "B"];
    const subset = ["B"];
    intersectRoles(granted, subset);
    expect(granted).toEqual(["A", "B"]);
    expect(subset).toEqual(["B"]);
  });
});
