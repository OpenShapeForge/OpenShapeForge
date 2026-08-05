// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { intersectRoles } from "./resolve.js";

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
