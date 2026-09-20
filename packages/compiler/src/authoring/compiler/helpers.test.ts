// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { constrainedType } from "@openshapeforge/operations";
import type { Field } from "../types.js";
import { fieldGraphqlBaseType, fieldSqlType } from "./helpers.js";

function integerField(
  validation?: Field["validation"],
  cardinality?: Field["cardinality"],
): Pick<Field, "baseType" | "validation" | "cardinality"> {
  return {
    baseType: "integer",
    ...(validation ? { validation } : {}),
    ...(cardinality ? { cardinality } : {}),
  };
}

describe("bounded integer storage and GraphQL projection", () => {
  test("keeps inclusive PostgreSQL integer boundaries narrow", () => {
    const field = integerField({ min: -2_147_483_648, max: 2_147_483_647 });
    expect(fieldSqlType(field)).toBe("integer");
    expect(fieldGraphqlBaseType(field)).toBe("Int");
  });

  test("uses bigint and Float when a numeric rule exceeds either 32-bit boundary", () => {
    const high = integerField({ max: Number.MAX_SAFE_INTEGER });
    const low = integerField({ min: -2_147_483_649 });
    expect(fieldSqlType(high)).toBe("bigint");
    expect(fieldGraphqlBaseType(high)).toBe("Float");
    expect(fieldSqlType(low)).toBe("bigint");
    expect(fieldGraphqlBaseType(low)).toBe("Float");
  });

  test("reads message-bearing validation rules without changing JSON Schema constraints", () => {
    const field = integerField({
      min: { value: -2_147_483_649, message: { en: "Too small" } },
      max: { value: Number.MAX_SAFE_INTEGER, message: { en: "Too large" } },
    });
    expect(fieldSqlType(field)).toBe("bigint");
    expect(fieldGraphqlBaseType(field)).toBe("Float");
    expect(constrainedType({ ...field, baseType: "integer" })).toEqual({
      type: "integer",
      minimum: -2_147_483_649,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });

  test("uses the wide scalar for collection items while retaining JSONB storage", () => {
    const wide = integerField({ max: 2_147_483_648 }, { min: 0, max: 2 });
    const unbounded = integerField({ max: 2_147_483_648 }, { max: "unbounded" });
    const narrow = integerField({ max: 2_147_483_647 }, "collection");
    expect(fieldSqlType(wide)).toBe("jsonb");
    expect(fieldGraphqlBaseType(wide)).toBe("[Float]");
    expect(fieldGraphqlBaseType(unbounded)).toBe("[Float]");
    expect(fieldSqlType(narrow)).toBe("jsonb");
    expect(fieldGraphqlBaseType(narrow)).toBe("[Int]");
  });

  test("does not change number or UUID mappings", () => {
    const number = { baseType: "number", validation: { max: Number.MAX_SAFE_INTEGER } } as const;
    const uuid = { baseType: "string", validation: { format: "uuid" } } as const;
    expect(fieldSqlType(number)).toBe("numeric");
    expect(fieldGraphqlBaseType(number)).toBe("Float");
    expect(fieldSqlType(uuid)).toBe("uuid");
    expect(fieldGraphqlBaseType(uuid)).toBe("ID");
  });
});
