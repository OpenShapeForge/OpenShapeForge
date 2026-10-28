// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { operationErrorOf } from "@openshapeforge/operations";
import type { DbSessionInput } from "../../db/session.js";
import {
  assertCreateRecordPermissions,
  assertRecordActionAxisUnchanged,
  assertUpdateRecordPermissions,
  parseRecordPermissions,
  recordActionAllows,
  recordActionsAllowRow,
  recordPermissionAllows,
  recordPermissionsAllowRow,
  reconcileRecordActionAxisWrite,
  RECORD_ACTION_DELEGATION_OPERATION,
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
const credentialId = "55555555-5555-4555-8555-555555555555";

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

/**
 * A verified identity ↔ Relation link naming a PERSON party, on a carrier
 * that states no principal kind — the payload-v2 trusted-context bundle this
 * deployment still accepts. The most person-like session the server can hold
 * without having classified one, and so the shape the matrix below is about.
 */
const linked = {
  relation: {
    identityId: "55555555-5555-4555-8555-555555555555",
    issuer: "https://identity.example/realms/test",
    subject: userId,
    status: "linked",
    relationId: "77777777-7777-4777-8777-777777777777",
    relationType: "person",
  },
} as Partial<DbSessionInput>;

/** The same link, still a candidate nobody has confirmed. */
const pending = {
  relation: { ...(linked.relation as Record<string, unknown>), status: "pending_confirmation" },
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
      principalKind: "service", appPrincipal: { integrationId, credentialId },
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

  /**
   * The `person` subjects are satisfied by a session the server CLASSIFIED as
   * a person, and by nothing that merely resembles one.
   *
   * An identity link is the near miss, and it is not evidence of a human: a
   * link row is recorded for every API-key service account on its first
   * session, and `link_identity` lets an administrator point any identity at
   * any Relation the tenant holds — so the party's own `relation_type` is a
   * fact about a row somebody chose, not about how this session
   * authenticated. A `pending_confirmation` link is an unconfirmed candidate
   * on top of that. All three linked shapes below hold the grant that names
   * this very user and this very role, and none of them holds the action.
   */
  test("a subject kind is matched against the verified principal class", () => {
    const roles = ["Records.All.Manage"];
    const personGrant = { actions: { start: { roles, users: [userId] } } };
    const applicationGrant = grant({ integrations: [integrationId] });
    const carriers: Array<[string, DbSessionInput, boolean, boolean]> = [
      // label, session, may use a person subject, may use an integration one
      ["stated person", { ...session, roles, principalKind: "person" }, true, false],
      // A signed class decides; the link neither grants nor withdraws one.
      ["stated person, linked", { ...session, roles, ...linked, principalKind: "person" }, true, false],
      ["linked to a person party", { ...session, roles, ...linked }, false, false],
      ["pending against a person party", { ...session, roles, ...pending }, false, false],
      [
        "service linked to a person party",
        { ...session, roles, ...linked, principalKind: "service" },
        false, false,
      ],
      ["service bearer", { ...session, roles, principalKind: "service" }, false, false],
      [
        "api-key application",
        { ...session, roles, principalKind: "service", appPrincipal: { integrationId, credentialId } },
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

  /**
   * And the ordinary permissions are untouched by that narrowing.
   *
   * `view`/`edit`/`delete` never looked at the principal class — they match a
   * user, a role or a RelationGroup — so a linked v2 session reads and writes
   * exactly what it read and wrote before. Stating it here is what keeps a
   * later tightening of the class from being mistaken for a tightening of
   * these.
   */
  test("the view/edit/delete axis is not narrowed with it", () => {
    const linkedSession: DbSessionInput = { ...session, ...linked };
    // Each subject kind the axis matches, named on `view` (which edit and
    // delete both require) and on the permission under test.
    for (const named of [
      ["user", subjects({ users: [userId] })],
      ["role", subjects({ roles: ["Records.All.Manage"] })],
      ["group", subjects({ groups: [groupId] })],
    ] as const) {
      const [subject, allowed] = named;
      for (const permission of ["view", "edit", "delete"] as const) {
        expect([subject, permission, recordPermissionAllows(
          { view: allowed, [permission]: allowed }, permission, linkedSession, "restricted",
        )]).toEqual([subject, permission, true]);
      }
    }
  });

  test("row-local evaluation agrees, and refuses an entity without the policy", () => {
    const application: DbSessionInput = {
      ...session, principalKind: "service", appPrincipal: { integrationId, credentialId },
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
    // Both kinds declared, so the shape check passes; changing the axis is a
    // separate authority, refused in the delegation-boundary tests below.
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

});

/**
 * The delegation boundary. Shape validation above says what the axis MAY
 * contain; this says who may change it, which is nobody through an ordinary
 * write.
 */
describe("the named-action axis is not writable through an ordinary write", () => {
  const granted = { actions: { start: { integrations: [integrationId] } } };
  const reconcile = (submitted: unknown, inForce: unknown) =>
    assertRecordActionAxisUnchanged(actionTable, submitted, inForce);

  test("a grant, a revocation and a swapped subject are all refused", () => {
    const other = "77777777-7777-4777-8777-777777777777";
    for (const [submitted, inForce] of [
      // The reported escalation: an editor grants a tenant integration.
      [granted, {}],
      [{ view: { users: [userId] }, ...granted }, { view: { users: [userId] } }],
      // A revocation is a change too, and equally not an editor's to make.
      // (Omitting the key entirely is the carry-forward case below.)
      [{ actions: {} }, granted],
      // Same action, another application.
      [{ actions: { start: { integrations: [other] } } }, granted],
      // Same application, another action.
      [{ actions: { both: { integrations: [integrationId] } } }, granted],
      // An added subject inside an entry the caller already held.
      [
        { actions: { start: { integrations: [integrationId, other] } } },
        granted,
      ],
    ] as Array<[unknown, unknown]>) {
      expect(() => reconcile(submitted, inForce))
        .toThrow("Not authorized to change the record's named actions.");
    }
  });

  test("the refusal names the one Operation that may change it", () => {
    try {
      reconcile(granted, {});
      throw new Error("expected a refusal");
    } catch (error) {
      const failure = operationErrorOf(error);
      expect(failure?.code).toBe("FORBIDDEN");
      expect(failure?.detail).toContain(RECORD_ACTION_DELEGATION_OPERATION);
    }
  });

  test("a document that does not state the axis keeps the grants in force", () => {
    // The old-client case: a body that predates the axis, or any partial
    // rewrite of the permissions, must not remove a grant by omission.
    expect(reconcile({ view: { users: [userId] } }, granted)).toEqual({
      view: { users: [userId] },
      actions: { start: { integrations: [integrationId] } },
    });
    // With nothing in force there is nothing to carry, and no empty husk.
    expect(reconcile({ view: { users: [userId] } }, {})).toEqual({
      view: { users: [userId] },
    });
  });

  test("an unchanged axis round-trips and is stored canonically", () => {
    const other = "77777777-7777-4777-8777-777777777777";
    const inForce = {
      actions: { start: { integrations: [other, integrationId] } },
    };
    // Read-modify-write of the permissions, with the axis handed back as read.
    expect(reconcile({ edit: { users: [userId] }, ...inForce }, inForce)).toEqual({
      edit: { users: [userId] },
      // Stored without the three kinds that name nobody: the column reads
      // back as what was granted, and the parser restores the comparison
      // shape from it.
      actions: { start: { integrations: [integrationId, other].sort() } },
    });
    // Order and duplicates are not a change.
    expect(() => reconcile(
      { actions: { start: { integrations: [integrationId, other, other] } } },
      inForce,
    )).not.toThrow();
  });

  test("an entry that names nobody is the same as no entry", () => {
    expect(() => reconcile({ actions: { start: { integrations: [] } } }, {})).not.toThrow();
    expect(reconcile({ actions: { start: { integrations: [] } } }, {})).toEqual({});
  });

  test("an entity without the policy, and a malformed document, are left alone", () => {
    const noPolicy = { ...actionTable, source: {} } as unknown as GeneratedCrudTable;
    expect(assertRecordActionAxisUnchanged(noPolicy, granted, {})).toEqual(granted);
    // The validity refusal belongs to assertUpdateRecordPermissions.
    expect(assertRecordActionAxisUnchanged(actionTable, { view: [] }, granted))
      .toEqual({ view: [] });
  });

  test("the write path reconciles the prepared column value", () => {
    const column = actionTable.columns.find((candidate) => candidate.name === "authorization")!;
    const prepared = new Map<typeof column, unknown>([[column, { view: { users: [userId] } }]]);
    reconcileRecordActionAxisWrite(actionTable, prepared, granted);
    expect(prepared.get(column)).toEqual({
      view: { users: [userId] },
      actions: { start: { integrations: [integrationId] } },
    });
    const escalating = new Map<typeof column, unknown>([[column, granted]]);
    expect(() => reconcileRecordActionAxisWrite(actionTable, escalating, {}))
      .toThrow("Not authorized to change the record's named actions.");
  });

  test("create seeds the entity default and refuses anything else", () => {
    const seeded = {
      ...actionTable,
      source: {
        ...actionTable.source,
        authorization: {
          ...actionTable.source!.authorization,
          recordPermissions: {
            ...actionTable.source!.authorization!.recordPermissions,
            defaultValue: granted,
          },
        },
      },
    } as unknown as GeneratedCrudTable;
    const permitted = { view: { users: [userId] }, edit: { users: [userId] } };
    // Nothing supplied: the authored default applies, actions included.
    expect(() => assertCreateRecordPermissions(seeded, session, {})).not.toThrow();
    // The default handed back verbatim is not a change.
    expect(() => assertCreateRecordPermissions(seeded, session, {
      authorization: { ...permitted, ...granted },
    })).not.toThrow();
    // A grant the entity does not seed is refused on create as well, so the
    // axis cannot be reached by creating the record instead of editing it.
    expect(() => assertCreateRecordPermissions(actionTable, session, {
      authorization: { ...permitted, ...granted },
    })).toThrow("Not authorized to change the record's named actions.");
    // An undeclared action still fails validation first.
    expect(() => assertCreateRecordPermissions(actionTable, session, {
      authorization: { ...permitted, actions: { publish: { users: [userId] } } },
    })).toThrow(/does not declare/);
  });
});

