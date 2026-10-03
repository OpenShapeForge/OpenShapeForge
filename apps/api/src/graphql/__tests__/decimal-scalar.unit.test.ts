// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { parseDecimalValue } from "../schema.js";

describe("the Decimal scalar's input", () => {
  test("takes a finite number and a decimal string the number prints back", () => {
    expect(parseDecimalValue(12.5)).toBe(12.5);
    expect(parseDecimalValue("12.50")).toBe(12.5);
    expect(parseDecimalValue("-0.25")).toBe(-0.25);
    expect(parseDecimalValue("7")).toBe(7);
    expect(() => parseDecimalValue("007")).toThrow(/finite number or a decimal string/);
    expect(parseDecimalValue("9007199254740991")).toBe(9007199254740991);
  });

  test("refuses a string the double cannot carry exactly, and anything else", () => {
    expect(() => parseDecimalValue("9007199254740993")).toThrow(/cannot be carried exactly/);
    expect(() => parseDecimalValue("0.10000000000000001")).toThrow(/cannot be carried exactly/);
    expect(() => parseDecimalValue("1e3")).toThrow(/finite number or a decimal string/);
    expect(() => parseDecimalValue(Number.NaN)).toThrow(/finite number/);
    expect(() => parseDecimalValue(true)).toThrow(/finite number/);
  });
});
