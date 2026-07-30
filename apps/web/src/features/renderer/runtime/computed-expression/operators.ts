// SPDX-License-Identifier: BUSL-1.1
import {
  toComparablePrimitive,
  toDisplayString,
  toNumber,
} from "./coercion";
import type {
  ComputedOperator,
  ComputedToken,
} from "./types";

export function getComputedOperatorPrecedence(
  token: ComputedToken | undefined,
) {
  switch (token?.type) {
    case "??":
      return 1;
    case "||":
      return 2;
    case "&&":
      return 3;
    case "==":
    case "!=":
    case "===":
    case "!==":
      return 4;
    case ">":
    case ">=":
    case "<":
    case "<=":
      return 5;
    case "+":
    case "-":
      return 6;
    case "*":
    case "/":
    case "%":
      return 7;
    default:
      return -1;
  }
}

export function applyComputedBinaryOperator(
  operator: ComputedOperator,
  left: unknown,
  right: unknown,
) {
  const comparableLeft = toComparablePrimitive(left);
  const comparableRight = toComparablePrimitive(right);

  switch (operator) {
    case "??":
      return left ?? right;
    case "||":
      return left || right;
    case "&&":
      return left && right;
    case "==":
      return comparableLeft == comparableRight; // eslint-disable-line eqeqeq
    case "!=":
      return comparableLeft != comparableRight; // eslint-disable-line eqeqeq
    case "===":
      return comparableLeft === comparableRight;
    case "!==":
      return comparableLeft !== comparableRight;
    case ">":
      return comparableLeft != null && comparableRight != null
        ? (comparableLeft as string | number | boolean) >
            (comparableRight as string | number | boolean)
        : false;
    case ">=":
      return comparableLeft != null && comparableRight != null
        ? (comparableLeft as string | number | boolean) >=
            (comparableRight as string | number | boolean)
        : false;
    case "<":
      return comparableLeft != null && comparableRight != null
        ? (comparableLeft as string | number | boolean) <
            (comparableRight as string | number | boolean)
        : false;
    case "<=":
      return comparableLeft != null && comparableRight != null
        ? (comparableLeft as string | number | boolean) <=
            (comparableRight as string | number | boolean)
        : false;
    case "+":
      if (typeof left === "string" || typeof right === "string") {
        return `${toDisplayString(left)}${toDisplayString(right)}`;
      }
      return (toNumber(left) ?? 0) + (toNumber(right) ?? 0);
    case "-":
      return (toNumber(left) ?? 0) - (toNumber(right) ?? 0);
    case "*":
      return (toNumber(left) ?? 0) * (toNumber(right) ?? 0);
    case "/":
      return (toNumber(left) ?? 0) / (toNumber(right) ?? 1);
    case "%":
      return (toNumber(left) ?? 0) % (toNumber(right) ?? 1);
    default:
      return undefined;
  }
}
