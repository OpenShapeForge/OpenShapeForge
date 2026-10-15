// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { bindingColumnReadable } from "./field-binding-policy.js";
import { projectGeneratedEntityRow, projectRows } from "./catalog.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

const column = (name: string, props: Partial<GeneratedCrudColumn> = {}): GeneratedCrudColumn =>
  ({ name, sourceField: name, type: "text", required: false, primaryKey: false, generated: null, ...props });
const table: GeneratedCrudTable = {
  name: "memos", schema: "erp", table: "memos", tenantScoped: true,
  domainInternal: false, generatedCrudEligible: true, primaryKey: "id",
  source: { authorization: { roles: { read: ["Reader"], create: ["Editor"], update: ["Editor"], delete: ["Editor"] } } },
  columns: [column("public"), column("hidden", { fieldPolicy: { readRoles: ["Secret.Reader"] } }),
    column("field_bindings", { type: "jsonb", fieldBindings: { fields: [
      { field: "public", column: "public", variables: "template" },
      { field: "hidden", column: "hidden", variables: "template" },
    ] } })],
};
const reader = { roles: ["Reader"] };

test("hidden destination withholds its value and authored binding on get and list projection", () => {
  const row = { public: "Visible", hidden: "Stored secret", field_bindings: {
    public: { kind: "template", source: "{{local.public}}" },
    hidden: { kind: "template", source: "Literal secret {{local.public}}" },
  } };
  const expected = { public: "Visible", hidden: null, field_bindings: { public: row.field_bindings.public } };
  expect(projectGeneratedEntityRow(table, reader, row)).toEqual(expected);
  expect(projectRows(table, reader, [row])).toEqual([expected]);
  expect(JSON.stringify(expected)).not.toContain("secret");
  expect(projectRows(table, { roles: ["Secret.Reader"] }, [row])[0]).toEqual(row);
});

test("classified, nested protected and elicited sources cannot masquerade as ordinary null or text", () => {
  expect(bindingColumnReadable(table, column("plain"), reader)).toBe(true);
  expect(bindingColumnReadable(table, column("classified", { classification: "pii" }), reader)).toBe(false);
  expect(bindingColumnReadable(table, column("classified", { classification: "pii" }), { roles: ["Editor"] })).toBe(true);
  expect(bindingColumnReadable(table, column("object", { fieldPolicy: { children: { child: { readRoles: ["Secret.Reader"] } } } }), reader)).toBe(false);
  const elicited = { ...table, source: { ...table.source, secureInputOnCreate: { into: "plain" } } } as GeneratedCrudTable;
  expect(bindingColumnReadable(elicited, column("plain"), { roles: ["Editor"] })).toBe(false);
});

test("list projection cannot bypass the stored typed-definition guard on an otherwise plain table", () => {
  const typed = { ...table, source: {}, columns: [column("definition", { type: "jsonb" }),
    column("value", { type: "jsonb", typedBy: { definitionField: "definition", definitionColumn: "definition" } })] };
  const row = { definition: { key: "value", osfType: "email", required: true }, value: "private@example.test" };
  expect(() => projectRows(typed, reader, [row])).toThrow(/not a value type this runtime can protect/);
});
