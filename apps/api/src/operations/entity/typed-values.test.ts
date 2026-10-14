// SPDX-License-Identifier: BUSL-1.1
/**
 * A value typed by the FieldDefinition stored beside it, held to that
 * definition on every write and to the policy boundary on every read. These
 * are the decisions the shared write path makes before any database is
 * involved; `field-bindings-db.test.ts` proves the same rules through real
 * canonical Operations.
 */
import { describe, expect, test } from "bun:test";
import {
  assertStoredTypedValuesSupported,
  assertTypedDefinitionSupported,
  assertTypedValuesValid,
  typedValueColumns,
} from "./typed-values.js";
import type { GeneratedCrudColumn, GeneratedCrudTable } from "./types.js";

const definitionColumn: GeneratedCrudColumn = {
  name: "definition", type: "jsonb", sourceField: "definition",
  required: true, primaryKey: false, generated: null,
};
const valueColumn: GeneratedCrudColumn = {
  name: "value", type: "jsonb", sourceField: "value",
  required: true, primaryKey: false, generated: null,
  typedBy: { definitionField: "definition", definitionColumn: "definition" },
};
const table = { columns: [definitionColumn, valueColumn] } as GeneratedCrudTable;
/** The same pair on a nullable column: the definition decides what null means. */
const optional = {
  columns: [definitionColumn, { ...valueColumn, required: false }],
} as GeneratedCrudTable;

const text = { key: "value", osfType: "multilineText", required: true, validation: { maxLength: 8000 } };
const money = { key: "value", osfType: "currency", required: true };
const flag = { key: "value", osfType: "boolean", required: true };
const tags = { key: "value", osfType: "string", cardinality: { min: 0, max: 8 }, item: { key: "item", osfType: "string" } };

const write = (
  values: Record<string, unknown>,
  current?: Record<string, unknown>,
  on: GeneratedCrudTable = table,
) => () => assertTypedValuesValid(on, values, current);

const refusal = (run: () => void): Record<string, unknown> | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { operationError?: Record<string, unknown> }).operationError ?? { thrown: String(error) };
  }
};

describe("the pair the manifest resolves", () => {
  test("a typed column names the column its definition lives in", () => {
    expect(typedValueColumns(table)).toEqual([{ value: valueColumn, definition: definitionColumn }]);
    expect(typedValueColumns({ columns: [definitionColumn] } as GeneratedCrudTable)).toEqual([]);
    // Metadata that does not match its own table is a build fault, not a
    // value this runtime silently stops checking.
    expect(() => typedValueColumns({
      columns: [{ ...valueColumn, typedBy: { definitionField: "elsewhere", definitionColumn: "definition" } }],
    } as GeneratedCrudTable)).toThrow(/does not match its table/);
  });
});

describe("the value against the definition stored beside it", () => {
  test("a create is held to both halves of the pair", () => {
    expect(write({ definition: text, value: "Kom langs op maandag" })).not.toThrow();
    expect(refusal(write({ definition: text, value: 12 }))).toMatchObject({ code: "VALIDATION" });
    expect(refusal(write({ definition: text, value: { nested: true } }))).toMatchObject({ code: "VALIDATION" });
    // A definition that does not describe this field types nothing.
    expect(refusal(write({ definition: { ...text, key: "other" }, value: "x" })))
      .toMatchObject({ code: "VALIDATION", violations: [{ field: "definition", code: "INVALID_VALUE" }] });
    expect(refusal(write({ definition: "multilineText", value: "x" })))
      .toMatchObject({ code: "VALIDATION", violations: [{ field: "definition", code: "INVALID_TYPE" }] });
    // Not a canonical FieldDefinition at all.
    expect(refusal(write({ definition: { key: "value" }, value: "x" }))).toMatchObject({ code: "VALIDATION" });
  });

  test("an exact numeric value is accepted in both of the forms it is projected in", () => {
    expect(write({ definition: money, value: "12.50" })).not.toThrow();
    expect(write({ definition: money, value: 12.5 })).not.toThrow();
    // Every digit of an amount a double would round still compares exactly.
    expect(write({ definition: money, value: "9007199254740993.01" })).not.toThrow();
    expect(refusal(write({ definition: money, value: "twelve fifty" }))).toMatchObject({ code: "VALIDATION" });
    expect(refusal(write({ definition: money, value: true }))).toMatchObject({ code: "VALIDATION" });
  });

  test("false, zero, an empty text and an empty collection are values, not absences", () => {
    expect(write({ definition: flag, value: false })).not.toThrow();
    expect(write({ definition: { ...money, validation: { min: 0 } }, value: "0.00" })).not.toThrow();
    expect(write({ definition: { key: "value", osfType: "string" }, value: "" })).not.toThrow();
    expect(write({ definition: tags, value: [] })).not.toThrow();
    // The definition decides: a minimum length refuses the empty text its
    // own author excluded.
    expect(refusal(write({ definition: { ...text, validation: { minLength: 1 } }, value: "" })))
      .toMatchObject({ code: "VALIDATION" });
  });

  test("null is the absence of a value, and a NOT NULL column holds none", () => {
    // The column is required, so null is refused however the definition reads.
    expect(refusal(write({ definition: text, value: null })))
      .toMatchObject({ code: "VALIDATION", violations: [{ field: "value", code: "REQUIRED" }] });
    expect(refusal(write({ definition: { ...text, required: false }, value: null })))
      .toMatchObject({ code: "VALIDATION", violations: [{ field: "value", code: "REQUIRED" }] });
    // On a nullable column the definition's own `required` decides.
    expect(write({ definition: { ...text, required: false }, value: null }, undefined, optional)).not.toThrow();
    expect(refusal(write({ definition: text, value: null }, undefined, optional)))
      .toMatchObject({ code: "VALIDATION" });
  });

  test("an update of either half is checked against the half the row already holds", () => {
    const stored = { definition: money, value: "12.50" };
    // A new value against the stored definition.
    expect(write({ value: "99.00" }, stored)).not.toThrow();
    expect(refusal(write({ value: "free text" }, stored))).toMatchObject({ code: "VALIDATION" });
    // A new definition against the stored value: retyping a monetary global
    // as a boolean would leave the record holding a value of neither type.
    expect(refusal(write({ definition: flag }, stored))).toMatchObject({ code: "VALIDATION" });
    // Both halves changing together is the way to retype it.
    expect(write({ definition: flag, value: true }, stored)).not.toThrow();
    // A write that touches neither half is none of this check's business.
    expect(write({ name: "Hourly rate" }, stored)).not.toThrow();
  });
});

describe("the policy boundary of a definition that arrives at runtime", () => {
  const guarded: Array<[string, Record<string, unknown>]> = [
    ["an authored classification", { ...text, classification: { sensitivity: "pii" } }],
    ["an authored authorization", { ...text, authorization: { roles: { read: ["Secret.Read"] } } }],
    ["authored permissions", { ...text, permissions: { read: ["Secret.Read"] } }],
    ["a secure input", { ...text, secureInput: { type: "secureInput" } }],
    ["an operation-written value", { ...text, writtenBy: ["Chip.update"] }],
    ["an immutable value", { ...text, immutable: true }],
    // The semantic type carries the policy, not the field: `email` and `phone`
    // are pii in the osf-type catalog, and a column of that type is redacted
    // for a read-only caller. One json column cannot be.
    ["an inherited classification", { key: "value", osfType: "email", required: true }],
    // Nested, through the children of an object value.
    ["a nested classification", {
      key: "value", osfType: "object", required: true,
      children: [{ key: "mail", osfType: "email", required: true }],
    }],
    // A reference needs its target read, authorized against the real row,
    // which only a reference COLUMN gets.
    ["an entity reference", { key: "value", osfType: "Relation", required: true }],
    // And an osfType this build does not know types nothing at all.
    ["an unknown type", { key: "value", osfType: "notAType", required: true }],
  ];

  test.each(guarded)("a definition carrying %s is refused on write", (label, definition) => {
    const error = refusal(write({ definition, value: "whatever" }));
    // Unknown types and noncanonical secureInput properties fail authoring
    // validation first; valid protected definitions reach the policy guard.
    const code = ["a secure input", "an unknown type"].includes(label) ? "VALIDATION" : "BAD_USER_INPUT";
    expect(error).toMatchObject({ code });
    // The refusal names the field and the boundary, never the value.
    expect(JSON.stringify(error)).not.toContain("whatever");
  });

  test.each(guarded)("a stored definition carrying %s is refused on read", (_label, definition) => {
    expect(() => assertStoredTypedValuesSupported(table, { definition, value: "stored secret" }))
      .toThrow(/not a value type this runtime can protect/);
  });

  test("a supported definition passes both halves of the boundary", () => {
    for (const definition of [text, money, flag, tags]) {
      expect(() => assertTypedDefinitionSupported(definition, "definition", "submitted")).not.toThrow();
      expect(() => assertStoredTypedValuesSupported(table, { definition, value: null })).not.toThrow();
    }
  });

  test("a row whose definition is missing is refused rather than projected half-way", () => {
    expect(() => assertStoredTypedValuesSupported(table, { value: "orphan" }))
      .toThrow(/stored type of value is not available/);
    expect(() => assertStoredTypedValuesSupported(table, { definition: null, value: "orphan" }))
      .toThrow(/stored type of value is not available/);
    // A projection that carries neither half has nothing to check.
    expect(() => assertStoredTypedValuesSupported(table, { name: "Hourly rate" })).not.toThrow();
  });
});
