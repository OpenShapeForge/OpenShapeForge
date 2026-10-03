// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { Field } from "@/generated/compiler/field-contract";
import { fieldValueType, tryFieldValueType } from "@/lib/field-contract/field-v2";
import { prepareRuntimeFields } from "./runtime-field-contract";

const field = (key: string, osfType: string, children?: readonly Field[]): Field => ({
  key,
  osfType,
  cardinality: { min: 0, max: 1 },
  required: false,
  ...(children ? { children } : {}),
} as Field);

describe("runtime field contract isolation", () => {
  test("strict resolution never trusts a baseType attached to an unknown osfType", () => {
    expect(() => fieldValueType({ key: "stale", osfType: "removedType", baseType: "string" }))
      .toThrow(/unknown osfType removedType/);
    expect(tryFieldValueType({ key: "stale", osfType: "removedType", baseType: "string" }))
      .toMatchObject({ ok: false, message: expect.stringContaining("stale") });
  });

  test("removes only unsupported nodes from form state while retaining their error identity", () => {
    const invalid = field("stale", "removedType");
    const validSibling = field("title", "string");
    const parent = field("details", "object", [validSibling, invalid]);
    const prepared = prepareRuntimeFields([parent, field("active", "boolean")]);

    expect(prepared.fields.map((candidate) => candidate.key)).toEqual(["details", "active"]);
    expect(prepared.fields[0]?.children?.map((candidate) => candidate.key)).toEqual(["title"]);
    expect(prepared.unsupported.get(invalid)).toContain("Unsupported field contract");
    expect(prepared.unsupported.has(validSibling)).toBe(false);
  });
});

