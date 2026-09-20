// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { DECIMAL_PATTERN, decimalText, INTEGER_TEXT_PATTERN, isScalarType, SCALAR_PROJECTION, SCALAR_TYPES, scalarJsonSchema } from "./scalar-projection.js";

describe("scalar projection", () => {
  test("every scalar projects to all four transports", () => {
    for (const type of SCALAR_TYPES) {
      const row = SCALAR_PROJECTION[type];
      expect(row.sql.length).toBeGreaterThan(0);
      expect(row.ts.length).toBeGreaterThan(0);
      expect(row.gql.length).toBeGreaterThan(0);
      expect(typeof row.json).toBe("object");
    }
  });

  test("a numeric and a bigint cross JSON as exact decimal strings", () => {
    expect(scalarJsonSchema("bigint")).toMatchObject({ type: "string", pattern: INTEGER_TEXT_PATTERN });
    expect(scalarJsonSchema("numeric")).toMatchObject({ type: "string", pattern: DECIMAL_PATTERN });
    expect(SCALAR_PROJECTION.numeric.gql).toBe("Decimal");
    expect(decimalText("12.50")).toBe("12.50");
    expect(decimalText(BigInt("9007199254740993"))).toBe("9007199254740993");
    expect(decimalText(1e21)).toBe("1000000000000000000000");
    expect(decimalText(12.5)).toBe("12.5");
    expect(new RegExp(DECIMAL_PATTERN).test("12.50")).toBe(true);
    expect(new RegExp(DECIMAL_PATTERN).test("1e3")).toBe(false);
    expect(isScalarType("text[]")).toBe(true);
    expect(isScalarType("varchar")).toBe(false);
  });

  test("a projected schema is a fresh object", () => {
    const first = scalarJsonSchema("uuid");
    delete first.format;
    expect(scalarJsonSchema("uuid")).toEqual({ type: "string", format: "uuid" });
  });
});
