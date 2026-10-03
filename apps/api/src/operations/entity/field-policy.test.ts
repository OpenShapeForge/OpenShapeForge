// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { FIELD_ITEM_ID } from "@openshapeforge/operations";
import { sql } from "kysely";
import { redactRow, assertClassifiedQueryFieldsAllowed } from "../../graphql/generated-authz.js";
import { assertCallerNestedFields, assertCallerTopLevelFields, prepareProtectedFieldWrites } from "./field-policy.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

const auth = { roles: { read: ["Read", "Edit"], create: ["Edit"], update: ["Edit"], delete: ["Edit"] } };
const one = "11111111-1111-4111-8111-111111111111";
const two = "22222222-2222-4222-8222-222222222222";
const column: GeneratedCrudColumn = {
  name: "payload", type: "jsonb", sourceField: "data", required: false, primaryKey: false, generated: null,
  fieldPolicy: { children: {
    private: { readRoles: ["Secret.Read"], writeRoles: ["Secret.Write"] },
    fixed: { immutable: true }, reviewed: { writtenBy: ["Fixture.review"] },
    contacts: { itemKey: FIELD_ITEM_ID, children: { secret: { readRoles: ["Secret.Read"], writeRoles: ["Secret.Write"] } } },
    list: { itemKey: FIELD_ITEM_ID, item: { children: { secret: { immutable: true } } } },
    pii: { classification: "pii" },
  } },
};
const table = { columns: [column] } as GeneratedCrudTable;
const before = { payload: { visible: "old", private: "sensitive", fixed: "initial", reviewed: "done",
  contacts: [{ [FIELD_ITEM_ID]: one, name: "one", secret: "contact secret" }], list: [{ [FIELD_ITEM_ID]: two, label: "a", secret: "fixed item" }], pii: "private pii" } };
const prepare = (value: unknown, roles = ["Edit"], caller = true) =>
  prepareProtectedFieldWrites(table, { roles }, new Map([[column, value]]), "update", before, caller).get(column);

test("record and ordinary information stay visible while nested and explicit restrictions are redacted", () => {
  const explicit: GeneratedCrudColumn = { ...column, name: "secret", fieldPolicy: { readRoles: ["Secret.Read"], writeRoles: ["Secret.Write"] } };
  const row = { ...before, secret: "top secret", label: "public" };
  const redacted = redactRow<Record<string, unknown>>(row, [column, explicit], auth, { roles: ["Read"] });
  expect(redacted).toEqual({ label: "public", secret: null, payload: { ...before.payload,
    private: null, contacts: [{ [FIELD_ITEM_ID]: one, name: "one", secret: null }], pii: null } });
  expect(before.payload.private).toBe("sensitive");
  const allowed = redactRow(row, [column, explicit], auth, { roles: ["Edit", "Secret.Read"] });
  expect(allowed).toBe(row);
});

test("filter and sort cannot expose restricted values even for an entity editor", () => {
  for (const filter of [{ data: "probe" }, { dataIn: ["probe"] }]) {
    expect(() => assertClassifiedQueryFieldsAllowed([column], auth, { roles: ["Edit"] }, "Fixture", filter))
      .toThrow("Not authorized");
  }
  expect(() => assertClassifiedQueryFieldsAllowed([column], auth, { roles: ["Edit"] }, "Fixture", null, { field: "data" }))
    .toThrow("Not authorized");
  expect(() => assertClassifiedQueryFieldsAllowed([column], auth, { roles: ["Edit", "Secret.Read"] }, "Fixture", { data: "probe" }))
    .not.toThrow();
});

test("saving public edits retains omitted restricted, immutable and operation-owned siblings", () => {
  expect(prepare({ visible: "changed", contacts: [{ [FIELD_ITEM_ID]: one, name: "changed" }], list: [{ [FIELD_ITEM_ID]: two, label: "changed" }] }))
    .toEqual({ visible: "changed", private: "sensitive", fixed: "initial", reviewed: "done", pii: "private pii",
      contacts: [{ [FIELD_ITEM_ID]: one, name: "changed", secret: "contact secret" }], list: [{ [FIELD_ITEM_ID]: two, label: "changed", secret: "fixed item" }] });
  expect(before.payload.visible).toBe("old");
});

test("unauthorized edits and container deletion are refused", () => {
  for (const input of [{ private: "changed" }, { private: null }, { fixed: "changed" },
    { reviewed: "changed" }, { contacts: [] }, { contacts: null }, { list: [] }, { list: {} }, null]) {
    expect(() => prepare(input)).toThrow();
  }
  expect(() => prepare({ contacts: [{ [FIELD_ITEM_ID]: one, name: "one", secret: "changed" }] })).toThrow("Not authorized");
});

test("unchanged visible immutable values may accompany edits, and explicit write grants authorize changes", () => {
  expect(prepare({ fixed: "initial", reviewed: "done", visible: "changed" })).toEqual({ ...before.payload, visible: "changed" });
  expect(() => prepare({ private: "sensitive" })).toThrow("Not authorized"); // Matching a guessed value must never become an oracle.
  expect(prepare({ private: "changed", fixed: "initial" }, ["Edit", "Secret.Write"]))
    .toMatchObject({ private: "changed", fixed: "initial", reviewed: "done" });
  expect(() => prepare({ fixed: "changed" }, ["Edit", "Secret.Write"])).toThrow("cannot be changed");
});

test("create refuses nested operation-owned and restricted input; trusted runtime can write operation values", () => {
  expect(() => prepareProtectedFieldWrites(table, { roles: ["Edit"] }, new Map([[column, { private: "new" }]]), "create"))
    .toThrow("Not authorized");
  expect(() => prepareProtectedFieldWrites(table, { roles: ["Edit"] }, new Map([[column, { reviewed: "new" }]]), "create"))
    .toThrow("Fixture.review");
  expect(prepare({ ...before.payload, reviewed: "new" }, ["Edit"], false)).toMatchObject({ reviewed: "new", fixed: "initial" });
});

test("top-level field permission and immutable checks precede normalization", () => {
  const explicit = { ...column, fieldPolicy: { readRoles: ["Secret.Read"], writeRoles: ["Secret.Write"] } };
  expect(() => assertCallerTopLevelFields({ columns: [explicit] } as GeneratedCrudTable, { roles: ["Edit"] }, { data: "new" }, "update"))
    .toThrow("Not authorized");
  expect(() => assertCallerTopLevelFields({ columns: [{ ...column, immutable: true }] } as GeneratedCrudTable, { roles: ["Edit"] }, { data: {} }, "update"))
    .toThrow("cannot be changed");
});

test("plugin handlers receive no unauthorized nested fields and can accept their own authored stamps", () => {
  expect(() => assertCallerNestedFields(table, { roles: ["Edit"] }, { data: { private: "changed" } }, "Fixture.review", "update"))
    .toThrow("Not authorized");
  expect(() => assertCallerNestedFields(table, { roles: ["Edit"] }, { payload: { private: "changed" } }, "Fixture.review", "update"))
    .toThrow("Not authorized");
  expect(() => assertCallerNestedFields(table, { roles: ["Edit"] }, { data: { reviewed: "new" } }, "Fixture.other", "update"))
    .toThrow("Fixture.review");
  expect(() => assertCallerNestedFields(table, { roles: ["Edit"] }, { data: { reviewed: "new" } }, "Fixture.review", "update"))
    .not.toThrow();
  const stamped = { ...column, writtenBy: [{ operation: "Fixture.review", rest: "/fixture" }] };
  expect(() => assertCallerTopLevelFields({ columns: [stamped] } as GeneratedCrudTable, { roles: ["Edit"] },
    { data: {} }, "create", "Fixture.review")).not.toThrow();
});


test("moving and editing identified rows retains each row's hidden values", () => {
  const rows = [{ [FIELD_ITEM_ID]: one, name: "One", secret: "one secret" },
    { [FIELD_ITEM_ID]: two, name: "Two", secret: "two secret" }];
  const result = prepareProtectedFieldWrites(table, { roles: ["Edit"] }, new Map([[column,
    { contacts: [{ [FIELD_ITEM_ID]: two, name: "Renamed Two" }, { [FIELD_ITEM_ID]: one }] }]]),
    "update", { payload: { contacts: rows } }).get(column);
  expect(result).toEqual({ contacts: [{ ...rows[1], name: "Renamed Two" }, rows[0]] });
});

test("identities cannot be duplicated, invented, or supplied by a caller on create", () => {
  for (const contacts of [[{ [FIELD_ITEM_ID]: one }, { [FIELD_ITEM_ID]: one }],
    [{ [FIELD_ITEM_ID]: two }], [{ [FIELD_ITEM_ID]: null }]]) {
    expect(() => prepare({ contacts })).toThrow("identity");
  }
  expect(() => prepareProtectedFieldWrites(table, { roles: ["Edit"] }, new Map([[column,
    { contacts: [{ [FIELD_ITEM_ID]: one, name: "New" }] }]]), "create")).toThrow("identity");
});

test("permitted new rows get fresh identities and permitted removal does not copy another secret", () => {
  const rows = [{ [FIELD_ITEM_ID]: one, name: "One", secret: "one secret" },
    { [FIELD_ITEM_ID]: two, name: "Two", secret: "two secret" }];
  const result = prepareProtectedFieldWrites(table, { roles: ["Edit", "Secret.Write"] }, new Map([[column,
    { contacts: [{ [FIELD_ITEM_ID]: two }, { name: "New" }] }]]), "update", { payload: { contacts: rows } }).get(column) as { contacts: Record<string, unknown>[] };
  expect(result.contacts[0]).toEqual(rows[1]);
  expect(result.contacts[1]).toMatchObject({ name: "New", [FIELD_ITEM_ID]: expect.any(String) });
  expect(result.contacts[1]![FIELD_ITEM_ID]).not.toBe(one);
  expect(result.contacts[1]!.secret).toBeUndefined();
});

test("hidden whole rows expose only the opaque identity needed to move them", () => {
  const policy = { itemKey: FIELD_ITEM_ID, item: { readRoles: ["Secret.Read"], writeRoles: ["Secret.Write"] } };
  const secretColumn: GeneratedCrudColumn = { ...column, fieldPolicy: policy };
  const source = { payload: [{ [FIELD_ITEM_ID]: one, secret: "one secret" }, { [FIELD_ITEM_ID]: two, secret: "two secret" }] };
  const redacted = redactRow<Record<string, unknown>>(source, [secretColumn], auth, { roles: ["Edit"] });
  expect(redacted.payload).toEqual([{ [FIELD_ITEM_ID]: one }, { [FIELD_ITEM_ID]: two }]);
  const moved = prepareProtectedFieldWrites({ columns: [secretColumn] } as GeneratedCrudTable, { roles: ["Edit"] },
    new Map<GeneratedCrudColumn, unknown>([[secretColumn, [{ [FIELD_ITEM_ID]: two }, { [FIELD_ITEM_ID]: one }]]]), "update", source).get(secretColumn);
  expect(moved).toEqual([source.payload[1], source.payload[0]]);
});

test("immutable readable scalar items can move but cannot be removed", () => {
  const scalar: GeneratedCrudColumn = { ...column, fieldPolicy: { item: { immutable: true } } };
  const scalarTable = { columns: [scalar] } as GeneratedCrudTable;
  const input = new Map([[scalar, ["two", "one"]]]);
  expect(prepareProtectedFieldWrites(scalarTable, { roles: ["Edit"] }, input, "update", { payload: ["one", "two"] }).get(scalar)).toEqual(["two", "one"]);
  expect(() => prepareProtectedFieldWrites(scalarTable, { roles: ["Edit"] }, new Map([[scalar, ["two"]]]), "update", { payload: ["one", "two"] })).toThrow("cannot be changed");
});

test("trusted object replacement removes omitted ordinary members while respecting immutability", () => {
  const replacementColumn: GeneratedCrudColumn = { ...column, fieldPolicy: { children: { private: { writeRoles: ["Secret.Write"] } } } };
  const replacementTable = { columns: [replacementColumn] } as GeneratedCrudTable;
  expect(prepareProtectedFieldWrites(replacementTable, { roles: ["Edit"] }, new Map([[replacementColumn, { visible: "new" }]]),
    "update", { payload: { visible: "old", private: "old secret", other: "removed" } }, false).get(replacementColumn)).toEqual({ visible: "new" });
  expect(() => prepare({ visible: "new" }, ["Edit"], false)).toThrow("cannot be changed");
});

test("protected JSON writes refuse unevaluated SQL values instead of erasing the object", () => {
  expect(() => prepare(sql`coalesce(payload, '{}'::jsonb) || '{}'::jsonb`, ["Edit"], false))
    .toThrow("concrete value");
});

test("an unreadable immutable item refuses a guess the same way whether or not it matches", () => {
  const hidden: GeneratedCrudColumn = { ...column, fieldPolicy: { item: { immutable: true, readRoles: ["Hidden.Read"] } } };
  const hiddenTable = { columns: [hidden] } as GeneratedCrudTable;
  const refusal = (guess: string) => {
    try {
      prepareProtectedFieldWrites(hiddenTable, { roles: ["Edit"] }, new Map([[hidden, [guess]]]), "update", { payload: ["stored"] });
    } catch (error) {
      return (error as Error).message;
    }
    return "accepted";
  };
  expect(refusal("stored")).toBe(refusal("guess"));
});
