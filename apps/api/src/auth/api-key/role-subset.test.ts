// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { API_KEY_MANAGE_ROLE, assertMayGrantRoles } from "./ceiling.js";
import {
  ApiKeyRolePolicyError,
  normalizeRequestedRoleSubset,
  parseStoredRoleSubset,
  resolveIssuedKeyRolePolicy,
} from "./role-subset.js";

describe("normalizeRequestedRoleSubset", () => {
  test("omitted and explicit null retain unrestricted semantics", () => {
    expect(normalizeRequestedRoleSubset(undefined)).toBeNull();
    expect(normalizeRequestedRoleSubset(null)).toBeNull();
  });

  test("an explicit empty subset remains empty", () => {
    expect(normalizeRequestedRoleSubset([])).toEqual([]);
  });

  test("a malformed subset fails closed instead of filtering valid-looking elements", () => {
    expect(normalizeRequestedRoleSubset({ role: "A" })).toEqual([]);
    expect(normalizeRequestedRoleSubset(["A", ""])).toEqual([]);
    expect(normalizeRequestedRoleSubset(["A", 42])).toEqual([]);
  });

  test("a valid narrowing subset is preserved", () => {
    expect(normalizeRequestedRoleSubset(["A", "B"])).toEqual(["A", "B"]);
  });
});

describe("parseStoredRoleSubset", () => {
  test("only SQL NULL is unrestricted", () => {
    expect(parseStoredRoleSubset(null, true)).toBeNull();
    expect(parseStoredRoleSubset(null, false)).toEqual([]);
    expect(parseStoredRoleSubset("null", false)).toEqual([]);
  });

  test("empty and malformed stored subsets authorize no roles", () => {
    expect(parseStoredRoleSubset([], false)).toEqual([]);
    expect(parseStoredRoleSubset({ unexpected: true }, false)).toEqual([]);
    expect(parseStoredRoleSubset('["A",42]', false)).toEqual([]);
    expect(parseStoredRoleSubset("not-json", false)).toEqual([]);
  });

  test("a valid stored narrowing subset is preserved", () => {
    expect(parseStoredRoleSubset(["A"], false)).toEqual(["A"]);
    expect(parseStoredRoleSubset('["A","B"]', false)).toEqual(["A", "B"]);
  });
});

describe("resolveIssuedKeyRolePolicy", () => {
  test("omitted and null subsets persist exactly the complete checked role set", () => {
    expect(resolveIssuedKeyRolePolicy(["A", "B"], undefined)).toEqual({
      roleSubset: ["A", "B"],
      rolesForCeiling: ["A", "B"],
    });
    expect(resolveIssuedKeyRolePolicy(["A", "B"], null)).toEqual({
      roleSubset: ["A", "B"],
      rolesForCeiling: ["A", "B"],
    });

    const policy = resolveIssuedKeyRolePolicy(["A", "B"], undefined);
    expect(policy.roleSubset).toEqual(policy.rolesForCeiling);
  });

  test("a caller that lost an integration role is refused", () => {
    const policy = resolveIssuedKeyRolePolicy(["A", "B"], undefined);
    expect(() =>
      assertMayGrantRoles(
        { roles: [API_KEY_MANAGE_ROLE, "A"], credential: "bearer" },
        policy.rolesForCeiling,
      ),
    ).toThrow("Cannot grant roles you do not hold: B.");
  });

  test("empty, malformed and valid narrowing subsets define the checked role set", () => {
    expect(resolveIssuedKeyRolePolicy(["A", "B"], [])).toEqual({
      roleSubset: [],
      rolesForCeiling: [],
    });
    expect(resolveIssuedKeyRolePolicy(["A", "B"], ["A", 42])).toEqual({
      roleSubset: [],
      rolesForCeiling: [],
    });
    expect(resolveIssuedKeyRolePolicy(["A", "B"], ["A"])).toEqual({
      roleSubset: ["A"],
      rolesForCeiling: ["A"],
    });
  });

  test("malformed stored integration roles abort issuance", () => {
    expect(() =>
      resolveIssuedKeyRolePolicy({ unexpected: true }, undefined),
    ).toThrow(ApiKeyRolePolicyError);
    expect(() =>
      resolveIssuedKeyRolePolicy({ unexpected: true }, undefined),
    ).toThrow("no API key was issued");
    expect(() =>
      resolveIssuedKeyRolePolicy({ unexpected: true }, ["A"]),
    ).toThrow(ApiKeyRolePolicyError);
  });
});
