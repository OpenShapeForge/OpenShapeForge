// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import {
  compareExactNumeric,
  exactNumericEquals,
  exactNumericViolation,
  isExactDecimalText,
  isExactIntegerText,
  isExactWholeNumber,
  MAX_EXACT_NUMERIC_LENGTH,
  operationFieldObjectSchema,
} from "./index.js";

test("exact text is recognized only in its canonical decimal spelling", () => {
  expect(isExactDecimalText("12.50")).toBe(true);
  expect(isExactDecimalText("-0.001")).toBe(true);
  expect(isExactDecimalText("012")).toBe(false);
  expect(isExactDecimalText("1e3")).toBe(false);
  expect(isExactDecimalText(" 1")).toBe(false);
  expect(isExactDecimalText("1.")).toBe(false);
  expect(isExactDecimalText("9007199254740993")).toBe(true);
  expect(isExactIntegerText("9007199254740993")).toBe(true);
  expect(isExactIntegerText("12.50")).toBe(false);
  expect(isExactDecimalText(`1.${"0".repeat(MAX_EXACT_NUMERIC_LENGTH)}`)).toBe(false);
});

test("spelling is not identity: the same number compares equal in any form", () => {
  expect(exactNumericEquals("1", "1.000")).toBe(true);
  expect(exactNumericEquals("-0", "0")).toBe(true);
  expect(exactNumericEquals("12.50", 12.5)).toBe(true);
  expect(exactNumericEquals("12.50", "12.51")).toBe(false);
  expect(exactNumericEquals(2n, "2.0")).toBe(true);
  expect(exactNumericEquals("abc", "abc")).toBe(false);
});

test("comparison keeps every digit a double would lose", () => {
  // Both of these are 9007199254740992 as IEEE doubles.
  expect(compareExactNumeric("9007199254740993", "9007199254740992")).toBe(1);
  expect(compareExactNumeric("0.10000000000000001", "0.1")).toBe(1);
  expect(compareExactNumeric("-2", "-10")).toBe(1);
  expect(compareExactNumeric("1", "x")).toBeUndefined();
});

test("bounds and the closed domain are applied by exact comparison", () => {
  expect(exactNumericViolation("5.00", { minimum: 5, maximum: 10 })).toBeUndefined();
  expect(exactNumericViolation("4.999", { minimum: 5 })).toBe("belowMinimum");
  expect(exactNumericViolation("10.0001", { maximum: 10 })).toBe("aboveMaximum");
  expect(exactNumericViolation("7.5", { integer: true })).toBe("notInteger");
  expect(exactNumericViolation("7.0", { integer: true })).toBeUndefined();
  expect(exactNumericViolation("2.0", { enum: [1, 2] })).toBeUndefined();
  expect(exactNumericViolation("3", { enum: [1, 2] })).toBe("notInEnum");
  expect(exactNumericViolation("not a number", {})).toBe("notNumeric");
  // A double would round this into range; exact comparison does not.
  expect(exactNumericViolation("9007199254740993", { maximum: 9007199254740992 })).toBe("aboveMaximum");
});

test("a numeric property publishes both of its forms with the same authored bounds", () => {
  const schema = operationFieldObjectSchema([
    { key: "amount", osfType: "number", required: true, validation: { min: 0, max: 100 } },
    { key: "counter", osfType: "integer", validation: { min: 1 } },
  ], {});
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  expect(properties.amount).toMatchObject({
    type: ["number", "string"],
    pattern: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
    minimum: 0,
    maximum: 100,
    "x-osf-exact": { minimum: 0, maximum: 100 },
  });
  expect(properties.counter).toMatchObject({
    type: ["integer", "string"],
    minimum: 1,
    "x-osf-exact": { integer: true, minimum: 1 },
  });
});

test("a closed numeric domain is published for exact comparison, in both forms", () => {
  const schema = operationFieldObjectSchema([
    { key: "priority", osfType: "integer", options: { type: "static", items: [{ value: "1" }, { value: "2" }] } },
  ], {});
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  expect(properties.priority).toMatchObject({
    type: ["integer", "string"],
    "x-osf-exact": { integer: true, enum: ["1", "2"] },
  });
  // Not `enum`: strict equality would read the number 1 and the text "1" —
  // the form every numeric column is projected in — as different values.
  expect(properties.priority!.enum).toBeUndefined();
});
