// SPDX-License-Identifier: BUSL-1.1
/**
 * The decisions the field-binding runtime makes before it reads anything: the
 * metadata it trusts, the queries it refuses, the caller input it accepts, and
 * the clearing rules that need no source. Resolution against real sources is
 * proven in `field-bindings-db.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { FIELD_BINDINGS_COLUMN, FIELD_BINDINGS_FIELD } from "@openshapeforge/operations";
import {
  assertBoundFieldQueryAllowed,
  bindableFields,
  fieldBindingsColumn,
  prepareFieldBindings,
} from "./field-bindings.js";
import { assertNoCallerFieldBindings, isCallerWritableColumn } from "./write-policy.js";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import type { DbSessionInput } from "../../db/session.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

const title: GeneratedCrudColumn = {
  name: "title", type: "text", sourceField: "title", required: true, primaryKey: false, generated: null,
};
const body: GeneratedCrudColumn = {
  name: "body", type: "text", sourceField: "body", required: false, primaryKey: false, generated: null,
};
const note: GeneratedCrudColumn = {
  name: "note", type: "text", sourceField: "note", required: false, primaryKey: false, generated: null,
};
const bindings: GeneratedCrudColumn = {
  name: FIELD_BINDINGS_COLUMN, type: "jsonb", required: false, primaryKey: false, generated: null,
  fieldBindings: {
    fields: [
      { field: "body", column: "body", variables: "template" },
      { field: "title", column: "title", variables: "whole" },
    ],
  },
};
const table = {
  name: "memos", schema: "erp", table: "memos", primaryKey: "id",
  source: { authoringEntityName: "Memo" },
  columns: [title, body, note, bindings],
} as unknown as GeneratedCrudTable;
const plain = { name: "pages", columns: [title, note] } as unknown as GeneratedCrudTable;

/** No source is read in any of these, so the connection is never touched. */
const unusedDb = undefined as unknown as OpenShapeForgeDatabase;
const session = {
  tenantId: "11111111-1111-4111-8111-111111111111", roles: ["Example.Edit"],
} as unknown as DbSessionInput;

const refuse = async (input: Parameters<typeof prepareFieldBindings>[3], current?: Record<string, unknown>) => {
  try {
    await prepareFieldBindings(unusedDb, session, table, input, current);
    return undefined;
  } catch (error) {
    return (error as { operationError?: { code?: string; message?: string } }).operationError;
  }
};

describe("the metadata the runtime resolves bindings from", () => {
  test("the bindings column is the one server-owned map, or there is none", () => {
    expect(fieldBindingsColumn(table)).toBe(bindings);
    expect(fieldBindingsColumn(plain)).toBeUndefined();
    expect([...bindableFields(table).keys()]).toEqual(["body", "title"]);
    expect(bindableFields(plain).size).toBe(0);
  });

  test("storage metadata that does not match its own table is a build fault", () => {
    const named = { columns: [{ ...bindings, name: "bindings" }] } as unknown as GeneratedCrudTable;
    expect(() => fieldBindingsColumn(named)).toThrow(/storage metadata is invalid/);
    const authored = { columns: [{ ...bindings, sourceField: "fieldBindings" }] } as unknown as GeneratedCrudTable;
    expect(() => fieldBindingsColumn(authored)).toThrow(/storage metadata is invalid/);
    const mismatched = {
      columns: [title, { ...bindings, fieldBindings: { fields: [{ field: "title", column: "subtitle", variables: "whole" }] } }],
    } as unknown as GeneratedCrudTable;
    expect(() => bindableFields(mismatched)).toThrow(/does not match its table/);
  });

  test("the map is never a caller-writable value", () => {
    expect(isCallerWritableColumn(table, title, "create")).toBe(true);
    expect(isCallerWritableColumn(table, bindings, "create")).toBe(false);
    expect(isCallerWritableColumn(table, bindings, "update")).toBe(false);
    // And a body that carries it is refused rather than quietly dropped: a
    // dropped binding reads as a binding that was accepted.
    for (const input of [{ [FIELD_BINDINGS_FIELD]: {} }, { [FIELD_BINDINGS_COLUMN]: {} }]) {
      expect(() => assertNoCallerFieldBindings(table, input)).toThrow(/bindings and unbind controls/);
    }
    expect(() => assertNoCallerFieldBindings(table, { title: "Memo" })).not.toThrow();
    expect(() => assertNoCallerFieldBindings(plain, { [FIELD_BINDINGS_FIELD]: {} })).not.toThrow();
  });
});

describe("a bound field is no filter and no sort", () => {
  test("every spelling of a filter on a bindable field, and the map itself, is refused", () => {
    for (const input of [
      { filter: { title: "probe" } },
      { filter: { titleIn: ["probe"] } },
      { filter: { body: "probe" } },
      { filter: { [FIELD_BINDINGS_FIELD]: {} } },
      { sort: { field: "title", direction: "asc" } },
      { sort: { field: "body", direction: "desc" } },
    ]) {
      expect(() => assertBoundFieldQueryAllowed(table, input)).toThrow(/not supported/);
    }
  });

  test("a field that takes literals only stays filterable, and so does every field of a plain entity", () => {
    expect(() => assertBoundFieldQueryAllowed(table, { filter: { note: "probe" } })).not.toThrow();
    expect(() => assertBoundFieldQueryAllowed(table, { sort: { field: "note", direction: "asc" } })).not.toThrow();
    expect(() => assertBoundFieldQueryAllowed(plain, { filter: { title: "probe" } })).not.toThrow();
    // A sub-filter names related fields exactly, so `titleIn` is a field name
    // there rather than a membership spelling.
    expect(() => assertBoundFieldQueryAllowed(table, { filter: { titleIn: ["probe"] } }, true)).not.toThrow();
    expect(() => assertBoundFieldQueryAllowed(table, { filter: { title: "probe" } }, true)).toThrow(/not supported/);
  });
});

describe("what a caller may ask for", () => {
  test("a literal and a binding for the same field are refused as conflicting intent", async () => {
    expect(await refuse({ values: { title: "Literal" }, bindings: { title: "chips.title" } }))
      .toMatchObject({ code: "BAD_USER_INPUT" });
  });
  test("a binding for a field or an entity that accepts none is refused by name", async () => {
    expect(await refuse({ values: {}, bindings: { note: "chips.phone" } }))
      .toMatchObject({ code: "BAD_USER_INPUT", message: expect.stringContaining("Memo.note") });
    expect(await refuse({ values: {}, unbind: ["note"] }))
      .toMatchObject({ code: "BAD_USER_INPUT", message: expect.stringContaining("Memo.note") });
    const onPlain = await prepareFieldBindings(unusedDb, session, plain, { values: { title: "x" } }, undefined);
    expect(onPlain).toEqual({ values: { title: "x" } });
    await expect(prepareFieldBindings(unusedDb, session, plain, { values: {}, bindings: { title: "chips.x" } }, undefined))
      .rejects.toThrow(/No field of pages accepts a variable/);
  });

  test("a shape the runtime cannot resolve is refused, not guessed", async () => {
    expect(await refuse({ values: {}, bindings: [] as unknown })).toMatchObject({ code: "BAD_USER_INPUT" });
    expect(await refuse({ values: {}, bindings: { title: 7 } })).toMatchObject({ code: "BAD_USER_INPUT" });
    expect(await refuse({ values: {}, bindings: { title: { template: "x", extra: 1 } } }))
      .toMatchObject({ code: "BAD_USER_INPUT" });
    expect(await refuse({ values: {}, unbind: "title" as unknown })).toMatchObject({ code: "BAD_USER_INPUT" });
    expect(await refuse({ values: {}, unbind: [7] as unknown })).toMatchObject({ code: "BAD_USER_INPUT" });
    // The authored mode decides the shape: a whole-value field takes no
    // template, and a template field takes no whole-value reference.
    expect(await refuse({ values: {}, bindings: { title: { template: "Call {{chips.phone}}" } } }))
      .toMatchObject({ code: "BAD_USER_INPUT", message: expect.stringContaining("does not accept variables in its text") });
    expect(await refuse({ values: {}, bindings: { body: "chips.phone" } }))
      .toMatchObject({ code: "BAD_USER_INPUT", message: expect.stringContaining("does not accept a variable as its whole value") });
    // One write does not both bind and unbind the same field.
    expect(await refuse({ values: {}, bindings: { title: "chips.phone" }, unbind: ["title"] }))
      .toMatchObject({ code: "BAD_USER_INPUT" });
    // A template is authored text, not a program.
    expect(await refuse({
      values: {},
      bindings: { body: { template: "{{chips.phone}} ".repeat(65) } },
    })).toMatchObject({ code: "BAD_USER_INPUT", message: expect.stringContaining("more than 64 variables") });
  });

  test("a literal clears that field's binding, with no source read at all", async () => {
    const current = { title: "resolved earlier", [FIELD_BINDINGS_COLUMN]: { title: { kind: "whole", ref: "chips.phone" } } };
    // The literal replaces both the value and the binding, and nothing is
    // left bound, so the map is cleared rather than rewritten.
    expect(await prepareFieldBindings(unusedDb, session, table, { values: { title: "typed by hand" } }, current))
      .toEqual({ values: { title: "typed by hand" }, bindings: { column: FIELD_BINDINGS_COLUMN, value: null } });
    // A record that had nothing bound is written exactly as it arrived.
    expect(await prepareFieldBindings(unusedDb, session, table, { values: { title: "x" } }, { title: "y" }))
      .toEqual({ values: { title: "x" } });
    // And a stored map the runtime cannot read is a fault, never a silent
    // "this record has no bindings".
    await expect(prepareFieldBindings(unusedDb, session, table, { values: { title: "x" } },
      { [FIELD_BINDINGS_COLUMN]: { title: "chips.phone" } })).rejects.toThrow(/stored field bindings/);
  });
});
