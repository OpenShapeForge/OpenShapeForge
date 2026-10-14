// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  bindingKindPermitted,
  fieldBindingMap,
  isFieldBinding,
  FIELD_BINDINGS_COLUMN,
  FIELD_BINDINGS_FIELD,
  MAX_BINDING_TEMPLATE_LENGTH,
} from "./field-bindings.js";

describe("the stored shape of a field binding", () => {
  test("a binding is a whole-value reference or an authored template, and nothing else", () => {
    expect(isFieldBinding({ kind: "whole", ref: "chips.company.phone" })).toBe(true);
    expect(isFieldBinding({ kind: "template", source: "Call {{chips.company.phone}}" })).toBe(true);
    // A template is text and may legitimately be empty; a reference may not be
    // a non-string, and neither shape carries anything beside its own two keys.
    expect(isFieldBinding({ kind: "template", source: "" })).toBe(true);
    expect(isFieldBinding({ kind: "whole", ref: 7 })).toBe(false);
    expect(isFieldBinding({ kind: "whole", ref: "chips.x", extra: 1 })).toBe(false);
    expect(isFieldBinding({ kind: "elsewhere", ref: "chips.x" })).toBe(false);
    expect(isFieldBinding({ ref: "chips.x" })).toBe(false);
    expect(isFieldBinding(null)).toBe(false);
    expect(isFieldBinding([{ kind: "whole", ref: "chips.x" }])).toBe(false);
    expect(isFieldBinding({ kind: "template", source: "x".repeat(MAX_BINDING_TEMPLATE_LENGTH + 1) })).toBe(false);
  });

  test("an empty column is an empty map, and anything that is not a map of bindings is refused", () => {
    // The column is nullable: a record with nothing bound holds null, which
    // reads as "no bindings" rather than as invalid storage.
    expect(fieldBindingMap(null)).toEqual({});
    expect(fieldBindingMap(undefined)).toEqual({});
    expect(fieldBindingMap({})).toEqual({});
    expect(fieldBindingMap({ body: { kind: "whole", ref: "chips.x" } }))
      .toEqual({ body: { kind: "whole", ref: "chips.x" } });
    // Refused, so a write cannot be built on a map the runtime misread.
    expect(fieldBindingMap({ body: "chips.x" })).toBeUndefined();
    expect(fieldBindingMap({ body: { kind: "whole" } })).toBeUndefined();
    expect(fieldBindingMap([])).toBeUndefined();
    expect(fieldBindingMap("chips.x")).toBeUndefined();
  });

  test("the mode a field authored decides which shape it admits", () => {
    const whole = { kind: "whole", ref: "chips.x" } as const;
    const template = { kind: "template", source: "{{chips.x}}" } as const;
    expect(bindingKindPermitted("whole", whole)).toBe(true);
    expect(bindingKindPermitted("whole", template)).toBe(false);
    expect(bindingKindPermitted("template", template)).toBe(true);
    expect(bindingKindPermitted("template", whole)).toBe(false);
    expect(bindingKindPermitted("both", whole)).toBe(true);
    expect(bindingKindPermitted("both", template)).toBe(true);
    expect(bindingKindPermitted("none", whole)).toBe(false);
    expect(bindingKindPermitted("none", template)).toBe(false);
  });

  test("the column and the field it projects as are one name each", () => {
    expect(FIELD_BINDINGS_COLUMN).toBe("field_bindings");
    expect(FIELD_BINDINGS_FIELD).toBe("fieldBindings");
  });
});
