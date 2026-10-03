// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { Field } from "@/generated/compiler/field-contract";
import {
  filterVariableSuggestions,
  getVariableFilterForField,
} from "./variable-compatibility";
import type { VariableSuggestion } from "./variable-suggestions";

function field(overrides: Partial<Field>): Field {
  return {
    key: "value",
    osfType: "string",
    baseType: "string",
    label: { en: "Value", nl: "Waarde" },
    ...overrides,
  } as Field;
}

function suggestion(overrides: Partial<VariableSuggestion>): VariableSuggestion {
  return {
    path: "value",
    displayPath: "value",
    fieldPath: "value",
    insertText: "{{value}}",
    label: "Value",
    sourceNodeId: "source",
    sourceNodeLabel: "Source",
    valueType: "string",
    ...overrides,
  };
}

describe("variable compatibility inferred from canonical fields", () => {
  test("a base osfType does not hide an explicit collection item contract", () => {
    const filter = getVariableFilterForField(field({
      cardinality: "collection",
      render: { component: "Collection", props: { expectedItemOsfType: "email" } },
    }));

    expect(filter).toEqual({ valueType: "array", itemOsfType: "email" });
    expect(filterVariableSuggestions([
      suggestion({ path: "emails", valueType: "array", itemOsfType: "email" }),
      suggestion({ path: "names", valueType: "array", itemOsfType: "string" }),
      suggestion({ path: "scalar", osfType: "email" }),
    ], filter).map(({ path }) => path)).toEqual(["emails"]);
  });

  test("a base osfType does not hide an explicit runtime value type", () => {
    expect(getVariableFilterForField(field({
      render: { component: "Input", props: { expectedValueType: "number" } },
    }))).toEqual({ valueType: "number" });
  });

  test("date and datetime fields reach their runtime compatibility branch", () => {
    expect(getVariableFilterForField(field({ osfType: "date", baseType: "date" })))
      .toEqual({ fieldType: "date" });
    expect(getVariableFilterForField(field({ osfType: "datetime", baseType: "datetime" })))
      .toEqual({ fieldType: "datetime" });
  });

  test("a genuine semantic osfType still narrows suggestions", () => {
    expect(getVariableFilterForField(field({ osfType: "email", baseType: "string" })))
      .toEqual({ osfType: "email" });
    expect(getVariableFilterForField(field({ osfType: "string", baseType: "string" })))
      .toBeNull();
  });
});
