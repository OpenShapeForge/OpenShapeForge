// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { createEntityValueRegistry } from "../../modules/entity-value-registry.js";
import { assertEntityValueFieldPolicy, projectEntityValueRow } from "./entity-value-io.js";
import type { GeneratedCrudTable } from "./types.js";

for (const [policy, value] of Object.entries({ classification: { sensitivity: "pii" }, authorization: { roles: ["Fixture.Read"] }, permissions: { read: ["Fixture.Read"] }, writtenBy: ["fixture"], secureInput: {}, immutable: true })) {
  for (const shape of ["own", "children", "item", "shape"] as const) {
    test(`entityValue rejects ${policy} on ${shape} fields`, () => {
      const leaf = { key: "protected", valueType: "string", [policy]: value };
      const field = shape === "own" ? leaf : { key: "container", valueType: "object", [shape]: shape === "item" ? leaf : [leaf] };
      expect(() => assertEntityValueFieldPolicy(field, {})).toThrow("Guarded or malformed");
    });
  }
  test(`entityValue rejects inherited ${policy} even when the field tries to override it`, () => {
    expect(() => assertEntityValueFieldPolicy({ key: "value", valueType: "string", semanticType: "protectedText", [policy]: false }, { protectedText: { valueType: "string", [policy]: value } })).toThrow("Guarded or malformed");
    expect(() => assertEntityValueFieldPolicy({ key: "container", semanticType: "nested" }, { nested: { kind: "scalar", valueType: "object", item: { key: "leaf", valueType: "string", [policy]: value } } })).toThrow("Guarded or malformed");
  });
}
test("entityValue permits immutable:false, but never false-valued authorization or permission policies", () => {
  expect(() => assertEntityValueFieldPolicy({ key: "text", valueType: "string", immutable: false }, {})).not.toThrow();
  for (const key of ["authorization", "permissions", "classification", "writtenBy", "secureInput"]) {
    expect(() => assertEntityValueFieldPolicy({ key: "text", valueType: "string", [key]: false }, {})).toThrow();
  }
});
test("entityValue rejects malformed/deep field shapes without treating JSON defaults as metadata", () => {
  for (const field of [{ key: "bad", children: {} }, { key: "bad", item: [] }, { key: "bad", semanticType: {} }, { key: "bad", semanticType: "Missing" }]) {
    expect(() => assertEntityValueFieldPolicy(field, {})).toThrow();
  }
  expect(() => assertEntityValueFieldPolicy({ key: "text", valueType: "object", defaultValue: { permissions: "content" } }, {})).not.toThrow();
  expect(() => assertEntityValueFieldPolicy({ key: "target", semanticType: "Target" }, { Target: { kind: "entity", shape: [{ key: "guarded", permissions: {} }] } })).not.toThrow();
  expect(() => assertEntityValueFieldPolicy({ key: "nested", children: [{ key: "target", semanticType: "Target" }] }, { Target: { kind: "entity" } })).toThrow();
  expect(() => assertEntityValueFieldPolicy({ key: "root", semanticType: "Recursive" }, { Recursive: { item: { key: "nested", semanticType: "Recursive" } } })).toThrow();
});

test("entityValue reads preserve persisted fields from an older definition while validating references", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const registry = createEntityValueRegistry({ version: 1, collections: [], carriers: [{
    entityName: "Placement", fieldKey: "values", definitionField: "definitionKey",
    schema: "erp", table: "placements", valuesColumn: "payload", definitionColumn: "definition_key",
    definitions: { Copy: {
      entityName: "Copy", schemaVersion: 1, definitionHash: "a".repeat(64),
      fields: [{ key: "current", valueType: "string", required: true }],
      valueSchema: { type: "object", required: ["current"], properties: { current: { type: "string" } }, additionalProperties: false },
      references: [{ fieldKey: "source", targetEntity: "Resource", schema: "erp", table: "resources", column: "ev_source_id", required: true }],
    } },
  }] });
  const table = {
    schema: "erp", table: "placements", name: "erp.placements", primaryKey: "id", tenantScoped: true,
    columns: [
      { name: "definition_key", sourceField: "definitionKey", type: "text" },
      { name: "payload", sourceField: "values", type: "jsonb" },
      { name: "ev_source_id", type: "uuid" },
    ],
    source: { authoringEntityName: "Placement" },
  } as GeneratedCrudTable;

  expect(projectEntityValueRow(table, {
    definition_key: "Copy", payload: { legacy: "kept" }, ev_source_id: id,
  }, registry)).toMatchObject({ payload: { legacy: "kept", source: id } });
  expect(() => projectEntityValueRow(table, {
    definition_key: "Copy", payload: { legacy: "kept" }, ev_source_id: "bad",
  }, registry)).toThrow("stored typed relationship is invalid");
});
