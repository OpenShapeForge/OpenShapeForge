// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { evaluateFieldCondition } from "./index.js";

for (const [operator, left, right, expected] of [
  ["equals", ["a", "b"], "b", true], ["equals", "2", 2, false],
  ["in", ["a", "b"], ["b", "c"], true], ["notIn", ["a"], ["b"], true],
  ["greaterThan", "10", 2, true], ["lessThan", "10", "2", true],
  ["greaterThanOrEquals", "not-a-number", 2, false], ["lessThanOrEquals", NaN, 2, false],
  ["isEmpty", [], null, true], ["isEmpty", 0, null, false],
  ["isNotEmpty", false, null, true], ["contains", "hello", "ell", true],
  ["notContains", ["a"], "a", false], ["unsupported", 1, 1, false],
] as const) {
  test(`field condition ${operator}: ${JSON.stringify(left)} / ${JSON.stringify(right)}`, () => {
    expect(evaluateFieldCondition({ operator, left: { path: "value" }, right: { value: right } }, path => path === "value" ? left : undefined)).toBe(expected);
  });
}

test("nested and empty groups retain their canonical truth semantics", () => {
  const yes = { operator: "equals", left: { path: "x" }, right: { value: true } };
  expect(evaluateFieldCondition({ all: [yes, { any: [yes] }] }, () => true)).toBe(true);
  expect(evaluateFieldCondition({ conditions: [yes], mode: "any" }, () => false)).toBe(false);
  expect(evaluateFieldCondition({ all: [] }, () => null)).toBe(true);
  expect(evaluateFieldCondition({ any: [] }, () => null)).toBe(false);
  expect(evaluateFieldCondition(null, () => null)).toBe(true);
  expect(evaluateFieldCondition("invalid", () => null)).toBe(false);
});
