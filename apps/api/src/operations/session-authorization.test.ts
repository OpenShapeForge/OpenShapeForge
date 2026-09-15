// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { sessionOperationRoleGroupsAllow, sessionOperationRolesAllow } from "./session-authorization.js";

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

test("role groups require one held role from every group", () => {
  expect(sessionOperationRoleGroupsAllow(undefined, [])).toBe(true);
  expect(sessionOperationRoleGroupsAllow([], ["a"])).toBe(false);
  expect(sessionOperationRoleGroupsAllow([["a", "b"], ["c"]], ["b", "c"])).toBe(true);
  expect(sessionOperationRoleGroupsAllow([["a", "b"], ["c"]], ["a"])).toBe(false);
  expect(sessionOperationRoleGroupsAllow([["a"], []], ["a"])).toBe(false);
});
