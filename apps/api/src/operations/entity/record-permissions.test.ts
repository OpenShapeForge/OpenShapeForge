// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { DbSessionInput } from "../../db/session.js";
import {
  assertCreateRecordPermissions,
  parseRecordPermissions,
  recordPermissionAllows,
  recordPermissionsAllowRow,
} from "./record-permissions.js";
import type { GeneratedCrudTable } from "./types.js";

const userId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const session: DbSessionInput = {
  tenantId: "33333333-3333-4333-8333-333333333333",
  userId,
  roles: ["Records.All.Manage"],
  groups: [groupId, "/untrusted/token/path"],
};

const table = {
  schema: "example",
  table: "records",
  name: "records",
  tenantScoped: true,
  primaryKey: "id",
  columns: [
    { name: "id", type: "uuid", primaryKey: true },
    { name: "authorization", type: "jsonb", sourceField: "authorization" },
  ],
  source: {
    authoringEntityName: "Record",
    authorization: {
      roles: { read: [], create: [], update: [], delete: [] },
      recordPermissions: {
        field: "authorization",
        column: "authorization",
        empty: "public",
        createRequires: ["view", "edit"],
        defaultValue: {},
      },
    },
  },
} as unknown as GeneratedCrudTable;

function subjects(overrides: Partial<Record<"users" | "groups" | "roles", string[]>> = {}) {
  return { users: [], groups: [], roles: [], ...overrides };
}

describe("record permissions", () => {
  test("a valid empty document uses the authored empty=public behavior", () => {
    expect(parseRecordPermissions({})).toEqual({
      view: subjects(),
      edit: subjects(),
      delete: subjects(),
    });
    for (const action of ["view", "edit", "delete"] as const) {
      expect(recordPermissionAllows({}, action, session, "public")).toBe(true);
      expect(recordPermissionAllows({}, action, session, "restricted")).toBe(false);
    }
  });

  test("matches users, roles and exact internal group ids", () => {
    expect(
      recordPermissionAllows(
        { view: { users: [userId] } },
        "view",
        session,
        "restricted",
      ),
    ).toBe(true);
    expect(
      recordPermissionAllows(
        { view: { roles: ["Records.All.Manage"] } },
        "view",
        session,
        "restricted",
      ),
    ).toBe(true);
    expect(
      recordPermissionAllows(
        { view: { groups: [groupId] } },
        "view",
        session,
        "restricted",
      ),
    ).toBe(true);
    expect(
      recordPermissionAllows(
        { view: { groups: ["/untrusted/token/path"] } },
        "view",
        session,
        "restricted",
      ),
    ).toBe(false);
  });

  test("edit and delete require both view and their own action", () => {
    const editOnly = { edit: { users: [userId] } };
    const viewAndEdit = {
      view: { users: [userId] },
      edit: { users: [userId] },
    };
    const viewAndDelete = {
      view: { users: [userId] },
      delete: { users: [userId] },
    };

    expect(recordPermissionAllows(editOnly, "edit", session, "restricted")).toBe(false);
    expect(recordPermissionAllows(viewAndEdit, "edit", session, "restricted")).toBe(true);
    expect(recordPermissionAllows(viewAndEdit, "delete", session, "restricted")).toBe(false);
    expect(recordPermissionAllows(viewAndDelete, "delete", session, "restricted")).toBe(true);
  });

  test("malformed documents fail closed even when empty is public", () => {
    const malformed = [
      null,
      [],
      "{}",
      { unknown: {} },
      { view: [] },
      { view: { unknown: [] } },
      { view: { users: "user" } },
      { view: { users: [""] } },
      { view: { users: [7] } },
    ];

    for (const value of malformed) {
      expect(parseRecordPermissions(value)).toBeUndefined();
      expect(recordPermissionAllows(value, "view", session, "public")).toBe(false);
    }
  });

  test("create validates the stored document and prevents author lockout", () => {
    expect(() => assertCreateRecordPermissions(table, session, {})).not.toThrow();
    expect(() =>
      assertCreateRecordPermissions(table, session, {
        authorization: { view: { users: ["someone-else"] } },
      }),
    ).toThrow("Not authorized to create a record with these permissions.");
    expect(() =>
      assertCreateRecordPermissions(table, session, {
        authorization: { view: { users: "not-an-array" } },
      }),
    ).toThrow("The record permissions are not valid.");
  });

  test("record offer checks use the authored field and all required actions", () => {
    const row = {
      id: "44444444-4444-4444-8444-444444444444",
      authorization: {
        view: { users: [userId] },
        edit: { users: [userId] },
        delete: { users: ["someone-else"] },
      },
    };
    expect(recordPermissionsAllowRow(table, row, ["view", "edit"], session)).toBe(true);
    expect(recordPermissionsAllowRow(table, row, ["delete"], session)).toBe(false);
  });
});
