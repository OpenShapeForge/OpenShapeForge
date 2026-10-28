// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { DbSessionInput } from "../../db/session.js";
import {
  assertCreateRecordPermissions,
  assertUpdateRecordPermissions,
  parseRecordPermissions,
  recordActionAllows,
  recordActionsAllowRow,
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
  groups: [groupId, "/keycloak/group/path"],
  relationGroupIds: [groupId],
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
      // The named-action axis is always normalized, and always empty until an
      // entity declares an action and a record grants one.
      actions: {},
    });
    for (const action of ["view", "edit", "delete"] as const) {
      expect(recordPermissionAllows({}, action, session, "public")).toBe(true);
      expect(recordPermissionAllows({}, action, session, "restricted")).toBe(false);
    }
  });

  test("matches users, roles and server-derived RelationGroup ids", () => {
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
        { view: { groups: ["/keycloak/group/path"] } },
        "view",
        session,
        "restricted",
      ),
    ).toBe(false);
    expect(
      recordPermissionAllows(
        { view: { groups: [groupId] } },
        "view",
        { ...session, relationGroupIds: [] },
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

  test("update refuses malformed replacements before SQL without forcing self-retention", () => {
    expect(() => assertUpdateRecordPermissions(table, { name: "unchanged ACL" })).not.toThrow();
    expect(() => assertUpdateRecordPermissions(table, {
      authorization: { view: { users: ["someone-else"] } },
    })).not.toThrow();
    for (const values of [
      { authorization: { view: [] } },
      { authorization: { edit: { roles: "admin" } } },
      { authorization: null },
    ]) {
      expect(() => assertUpdateRecordPermissions(table, values)).toThrow(
        "The record permissions are not valid.",
      );
    }
    const aliased = {
      ...table,
      source: {
        ...table.source,
        authorization: {
          ...table.source!.authorization,
          recordPermissions: {
            ...table.source!.authorization!.recordPermissions!,
            field: "access.permissions",
          },
        },
      },
    } as GeneratedCrudTable;
    expect(() => assertUpdateRecordPermissions(aliased, {
      authorization: { view: [] },
    })).toThrow("The record permissions are not valid.");
    expect(() => assertUpdateRecordPermissions(aliased, {
      "access.permissions": { view: [] },
    })).toThrow("The record permissions are not valid.");
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

const integrationId = "44444444-4444-4444-8444-444444444444";

/** The same entity, with a declared action axis. */
const actionTable = {
  ...table,
  source: {
    ...table.source,
    authorization: {
      ...table.source!.authorization,
      recordPermissions: {
        ...table.source!.authorization!.recordPermissions,
        actions: [
          { name: "start", principals: ["integration"], reads: ["definition"] },
          { name: "review", principals: ["person"] },
          { name: "both", principals: ["integration", "person"] },
        ],
      },
    },
  },
} as unknown as GeneratedCrudTable;

const linked = {
  relation: {
    identityId: "55555555-5555-4555-8555-555555555555",
    issuer: "https://identity.example/realms/test",
    subject: userId,
    status: "linked",
  },
} as Partial<DbSessionInput>;

describe("named record actions", () => {
  const grant = (subjects: Record<string, string[]>) => ({ actions: { start: subjects } });

  test("parses the action axis and refuses anything outside its shape", () => {
    expect(parseRecordPermissions(grant({ integrations: [integrationId] }))?.actions).toEqual({
      start: { users: [], groups: [], roles: [], integrations: [integrationId] },
    });
    for (const malformed of [
      { actions: [] },
      { actions: "start" },
      { actions: { start: [] } },
      { actions: { start: { unknown: [] } } },
      { actions: { start: { integrations: "x" } } },
      { actions: { start: { integrations: [""] } } },
      // An action may never restate a record permission, in either direction.
      { actions: { view: { users: [userId] } } },
      { actions: { Start: { users: [userId] } } },
      { actions: { "start-run": { users: [userId] } } },
      // `integrations` is refused on the permissions themselves.
      { view: { integrations: [integrationId] } },
    ]) {
      expect(parseRecordPermissions(malformed)).toBeUndefined();
    }
  });

  test("an action is independent of view, and empty never means public", () => {
    const application: DbSessionInput = {
      ...session, userId: "66666666-6666-4666-8666-666666666666",
      principalKind: "service", appPrincipal: { integrationId },
    };
    // Granted the action, granted no view.
    const document = grant({ integrations: [integrationId] });
    expect(recordActionAllows(document, "start", application)).toBe(true);
    expect(recordPermissionAllows(document, "view", application, "restricted")).toBe(false);
    // Holding view grants no action, however permissive the ACL is.
    expect(recordActionAllows({}, "start", { ...session, ...linked })).toBe(false);
    expect(recordActionAllows({ actions: { start: {} } }, "start", application)).toBe(false);
    expect(recordPermissionAllows({}, "view", session, "public")).toBe(true);
    // A malformed document and an unnamed action are denials, not errors.
    expect(recordActionAllows({ actions: { start: { users: 1 } } }, "start", application)).toBe(false);
    expect(recordActionAllows(document, "follow", application)).toBe(false);
    expect(recordActionAllows(document, "view", application)).toBe(false);
  });

  test("a subject kind is matched against the verified principal class", () => {
    const roles = ["Records.All.Manage"];
    const personGrant = { actions: { start: { roles, users: [userId] } } };
    const applicationGrant = grant({ integrations: [integrationId] });
    const carriers: Array<[string, DbSessionInput, boolean, boolean]> = [
      // label, session, may use a person subject, may use an integration one
      ["stated person", { ...session, roles, principalKind: "person" }, true, false],
      ["linked person", { ...session, roles, ...linked }, true, false],
      ["service bearer", { ...session, roles, principalKind: "service" }, false, false],
      [
        "api-key application",
        { ...session, roles, principalKind: "service", appPrincipal: { integrationId } },
        false, true,
      ],
      ["unclassified", { ...session, roles }, false, false],
    ];
    for (const [label, carrier, person, application] of carriers) {
      expect([label, recordActionAllows(personGrant, "start", carrier)]).toEqual([label, person]);
      expect([label, recordActionAllows(applicationGrant, "start", carrier)])
        .toEqual([label, application]);
    }
  });

  test("row-local evaluation agrees, and refuses an entity without the policy", () => {
    const application: DbSessionInput = {
      ...session, principalKind: "service", appPrincipal: { integrationId },
    };
    const row = { authorization: grant({ integrations: [integrationId] }) };
    expect(recordActionsAllowRow(actionTable, row, ["start"], application)).toBe(true);
    expect(recordActionsAllowRow(actionTable, row, ["review"], application)).toBe(false);
    expect(recordActionsAllowRow(actionTable, row, [], application)).toBe(true);
    expect(recordActionsAllowRow(
      { ...actionTable, source: {} } as unknown as GeneratedCrudTable,
      row, ["start"], application,
    )).toBe(false);
  });
});

describe("assigning a record action", () => {
  const write = (values: Record<string, unknown>) =>
    () => assertUpdateRecordPermissions(actionTable, values);

  test("refuses an action the entity does not declare", () => {
    expect(write({ authorization: { actions: { publish: { users: [userId] } } } }))
      .toThrow(/does not declare/);
    // ...and on an entity with no action axis at all.
    expect(() => assertUpdateRecordPermissions(table, {
      authorization: { actions: { start: { users: [userId] } } },
    })).toThrow(/does not declare/);
  });

  test("refuses a principal kind the action does not admit", () => {
    expect(write({ authorization: { actions: { start: { users: [userId] } } } }))
      .toThrow(/does not admit/);
    expect(write({ authorization: { actions: { review: { integrations: [integrationId] } } } }))
      .toThrow(/does not admit/);
    // Both kinds declared, both accepted.
    expect(write({
      authorization: { actions: { both: { users: [userId], integrations: [integrationId] } } },
    })).not.toThrow();
  });

  test("refuses an application that is not an integration id", () => {
    for (const named of ["osf_live_abc", "my integration", userId.slice(0, 8)]) {
      expect(write({ authorization: { actions: { start: { integrations: [named] } } } }))
        .toThrow(/not an integration id/);
    }
  });

  test("an empty subject set round-trips, so reading and rewriting an ACL works", () => {
    expect(write({
      authorization: {
        view: { users: [], groups: [], roles: [] },
        actions: { start: { users: [], groups: [], roles: [], integrations: [integrationId] } },
      },
    })).not.toThrow();
  });

  test("create applies the same rules", () => {
    expect(() => assertCreateRecordPermissions(actionTable, session, {
      authorization: {
        view: { users: [userId] }, edit: { users: [userId] },
        actions: { start: { integrations: [integrationId] } },
      },
    })).not.toThrow();
    expect(() => assertCreateRecordPermissions(actionTable, session, {
      authorization: {
        view: { users: [userId] }, edit: { users: [userId] },
        actions: { start: { users: [userId] } },
      },
    })).toThrow(/does not admit/);
  });
});
