// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { resolveFieldInputRender } from "./compiler-field-rendering";

describe("default field controls resolve through the one type axis", () => {
  test("an integer connector configuration field gets the number control, not a text box", () => {
    // Exact Online's `division`: the generated connector configuration
    // supplies `osfType: integer` and nothing else about presentation. A text
    // box would submit "123" for a contract that validates an integer.
    expect(resolveFieldInputRender({ key: "division", osfType: "integer" })).toMatchObject({
      component: "NumberInput",
      source: "fieldType",
    });
    expect(resolveFieldInputRender({ key: "enabled", osfType: "boolean" }).component).toBe("Switch");
    expect(resolveFieldInputRender({ key: "tags", osfType: "string", cardinality: "collection" }).source).toBe("fieldType");
  });

  test("a compiled field's baseType and a catalog key resolve the same way; an unknown osfType is refused", () => {
    expect(resolveFieldInputRender({ key: "count", osfType: "count", baseType: "integer" }).component).toBe("NumberInput");
    expect(resolveFieldInputRender({ key: "note", osfType: "multilineText" }).source).toBe("osfType");
    expect(() => resolveFieldInputRender({ key: "x", osfType: "noSuchType" })).toThrow("x: unknown osfType noSuchType.");
    // No osfType at all: nothing to resolve, the generic input.
    expect(resolveFieldInputRender({ key: "free" })).toEqual({ component: "Input", source: "fallback" });
  });
});
