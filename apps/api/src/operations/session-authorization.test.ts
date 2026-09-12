// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { sessionOperationRolesAllow } from "./session-authorization.js";

describe("session Operation role restrictions", () => {
  test("distinguishes an omitted role restriction from explicit deny-all", () => {
    expect(sessionOperationRolesAllow(undefined, [])).toBe(true);
    expect(sessionOperationRolesAllow([], ["admin"])).toBe(false);
  });

  test("keeps existing non-empty role matching exact", () => {
    expect(sessionOperationRolesAllow(["reader", "editor"], ["editor"])).toBe(true);
    expect(sessionOperationRolesAllow(["reader"], ["Reader", "admin"])).toBe(false);
  });
});
