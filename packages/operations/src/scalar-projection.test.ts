// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { isScalarType, SCALAR_PROJECTION, SCALAR_TYPES, scalarJsonSchema } from "./scalar-projection.js";

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

  test("a bigint is one integer everywhere it crosses JSON", () => {
    expect(scalarJsonSchema("bigint")).toEqual({ type: "integer" });
    expect(scalarJsonSchema("numeric")).toEqual({ type: "number" });
    expect(isScalarType("text[]")).toBe(true);
    expect(isScalarType("varchar")).toBe(false);
  });

  test("a projected schema is a fresh object", () => {
    const first = scalarJsonSchema("uuid");
    first.format = undefined;
    expect(scalarJsonSchema("uuid")).toEqual({ type: "string", format: "uuid" });
  });
});
