// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { canonicalFieldComponentName, resolveFieldDisplayRender, resolveFieldInputRender } from "./compiler-field-rendering";

describe("default field controls resolve through the one type axis", () => {
  test("an integer connector configuration field gets the number control, not a text box", () => {
    // Exact Online's `division`: the generated connector configuration
    // supplies `osfType: integer` and nothing else about presentation. A text
    // box would submit "123" for a contract that validates an integer.
    expect(resolveFieldInputRender({ key: "division", osfType: "integer" })).toMatchObject({
      component: "FieldIntegerDecimal",
      source: "fieldType",
    });
    expect(resolveFieldInputRender({ key: "enabled", osfType: "boolean" }).component).toBe("FieldNullableBoolean");
    expect(resolveFieldInputRender({ key: "tags", osfType: "string", cardinality: "collection" }).source).toBe("fieldType");
  });

  test("a compiled field's baseType and a catalog key resolve the same way; an unknown osfType is refused", () => {
    expect(resolveFieldInputRender({ key: "count", osfType: "count", baseType: "integer" }).component).toBe("FieldIntegerDecimal");
    expect(resolveFieldInputRender({ key: "note", osfType: "multilineText" }).source).toBe("osfType");
    expect(() => resolveFieldInputRender({ key: "x", osfType: "noSuchType" })).toThrow("x: unknown osfType noSuchType.");
    // No osfType at all: nothing to resolve, the generic input.
    expect(resolveFieldInputRender({ key: "free" })).toEqual({ component: "FieldSingleLine", source: "fallback" });
  });
});


test("persisted field control names resolve to the controls already stored for the tenant", () => {
  const cases = [
    ["Input", "FieldSingleLine"],
    ["InputMultiline", "InputMultiline"],
    ["NumberInput", "FieldIntegerDecimal"],
    ["ReferenceSelect", "FieldSingleRelatedRecord"],
    ["Switch", "FieldBoolean"],
    ["DatePicker", "FieldDate"],
    ["JsonFieldEditor", "FieldCodeStructuredJson"],
  ] as const;

  for (const [component, expected] of cases) {
    const props = { testSetting: true };
    const field = { render: { component, props } };
    expect(resolveFieldInputRender(field)).toEqual({ component: expected, props, source: "explicit" });
    expect(resolveFieldDisplayRender(field)).toEqual({ component: expected, props, source: "explicit" });
  }
  expect(canonicalFieldComponentName("InputMultiline")).toBe("FieldMultiline");
  expect(canonicalFieldComponentName("CustomControl")).toBe("CustomControl");
});
