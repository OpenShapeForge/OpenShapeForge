// SPDX-License-Identifier: BUSL-1.1
/**
 * The per-definition ACL.
 *
 * The group cases are the reason this file exists: the model this ports from
 * parsed `groups` and never evaluated them, so a definition restricted to a
 * group was invisible to everyone including its author, permanently.
 */
import { describe, expect, test } from "bun:test";
import {
  canDeleteDefinition,
  canEditDefinition,
  canViewDefinition,
  hasWorkflowWriterRole,
  normalizeDefinitionAuthorization,
} from "../definition-authorization.js";

const writer = { userId: "u1", roles: ["directie"], groups: ["team-a"] };
const reader = { userId: "u2", roles: ["controller"], groups: ["team-b"] };

const acl = (value: unknown) => normalizeDefinitionAuthorization(value);

describe("normalizeDefinitionAuthorization", () => {
  test("an absent or unreadable value normalizes to empty, which means visible", () => {
    for (const value of [undefined, null, {}, "nonsense", 42, []]) {
      const authorization = acl(value);
      expect(authorization.view).toEqual({ roles: [], users: [], groups: [] });
      expect(canViewDefinition(authorization, reader)).toBe(true);
    }
  });

  test("non-string entries are discarded rather than trusted", () => {
    const authorization = acl({ view: { roles: ["directie", 7, null, ""], users: "u1" } });
    expect(authorization.view.roles).toEqual(["directie"]);
    expect(authorization.view.users).toEqual([]);
  });
});

describe("view", () => {
  test("naming nobody grants everybody in the tenant", () => {
    expect(canViewDefinition(acl({ view: {} }), reader)).toBe(true);
  });

  test("a named user, role or group matches", () => {
    expect(canViewDefinition(acl({ view: { users: ["u2"] } }), reader)).toBe(true);
    expect(canViewDefinition(acl({ view: { roles: ["controller"] } }), reader)).toBe(true);
    expect(canViewDefinition(acl({ view: { groups: ["team-b"] } }), reader)).toBe(true);
  });

  test("a group-only ACL does not lock everyone out", () => {
    // The regression this module exists to prevent: with groups parsed but not
    // evaluated, this ACL is neither empty nor matching, so it matched nobody.
    const authorization = acl({ view: { groups: ["team-a"] } });
    expect(canViewDefinition(authorization, writer)).toBe(true);
    expect(canViewDefinition(authorization, reader)).toBe(false);
  });
});

describe("edit and delete", () => {
  test("require a writer role regardless of the ACL", () => {
    // An ACL naming a user must not grant workflow authoring to someone without
    // the role, or every definition's ACL becomes an escalation path.
    const authorization = acl({ edit: { users: ["u2"] }, delete: { users: ["u2"] } });
    expect(hasWorkflowWriterRole(reader)).toBe(false);
    expect(canEditDefinition(authorization, reader)).toBe(false);
    expect(canDeleteDefinition(authorization, reader)).toBe(false);
  });

  test("require visibility as well as the role", () => {
    const authorization = acl({ view: { users: ["someone-else"] }, edit: {} });
    expect(hasWorkflowWriterRole(writer)).toBe(true);
    expect(canEditDefinition(authorization, writer)).toBe(false);
  });

  test("a writer with view and an empty edit set may edit", () => {
    expect(canEditDefinition(acl({}), writer)).toBe(true);
    expect(canDeleteDefinition(acl({}), writer)).toBe(true);
  });

  test("edit and delete are independent", () => {
    const authorization = acl({ edit: { users: ["u1"] }, delete: { users: ["someone-else"] } });
    expect(canEditDefinition(authorization, writer)).toBe(true);
    expect(canDeleteDefinition(authorization, writer)).toBe(false);
  });
});
