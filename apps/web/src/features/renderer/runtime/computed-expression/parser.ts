// SPDX-License-Identifier: BUSL-1.1
import { toNumber } from "./coercion";
import {
  applyComputedBinaryOperator,
  getComputedOperatorPrecedence,
} from "./operators";
import type {
  ComputedOperator,
  ComputedParseResult,
  ComputedToken,
} from "./types";
import { resolvePlaceholderValue } from "./value-resolution";

function parseComputedPrimary(
  tokens: readonly ComputedToken[],
  rootValues: Record<string, unknown>,
  startIndex: number,
): ComputedParseResult | undefined {
  const token = tokens[startIndex];
  if (!token) {
    return undefined;
  }

  if (token.type === "(") {
    const nested = parseComputedExpression(tokens, rootValues, startIndex + 1, 0);
    if (!nested || tokens[nested.nextIndex]?.type !== ")") {
      return undefined;
    }
    return { value: nested.value, nextIndex: nested.nextIndex + 1 };
  }

  if (token.type === "!") {
    const nested = parseComputedPrimary(tokens, rootValues, startIndex + 1);
    if (!nested) {
      return undefined;
    }
    return { value: !nested.value, nextIndex: nested.nextIndex };
  }

  if (token.type === "-") {
    const nested = parseComputedPrimary(tokens, rootValues, startIndex + 1);
    if (!nested) {
      return undefined;
    }
    const numericValue = toNumber(nested.value);
    if (numericValue === undefined) {
      return undefined;
    }
    return { value: -numericValue, nextIndex: nested.nextIndex };
  }

  if (token.type === "placeholder") {
    return {
      value: resolvePlaceholderValue(token.value, rootValues),
      nextIndex: startIndex + 1,
    };
  }

  if (
    token.type === "string" ||
    token.type === "number" ||
    token.type === "boolean" ||
    token.type === "null"
  ) {
    return { value: token.value, nextIndex: startIndex + 1 };
  }

  return undefined;
}

export function parseComputedExpression(
  tokens: readonly ComputedToken[],
  rootValues: Record<string, unknown>,
  startIndex = 0,
  minimumPrecedence = 0,
): ComputedParseResult | undefined {
  let left = parseComputedPrimary(tokens, rootValues, startIndex);
  if (!left) {
    return undefined;
  }

  while (true) {
    const operator: ComputedToken | undefined = tokens[left.nextIndex];
    const precedence = getComputedOperatorPrecedence(operator);

    if (precedence < minimumPrecedence) {
      break;
    }

    const right = parseComputedExpression(
      tokens,
      rootValues,
      left.nextIndex + 1,
      precedence + 1,
    );
    if (!right || !operator) {
      return undefined;
    }

    left = {
      value: applyComputedBinaryOperator(
        operator.type as ComputedOperator,
        left.value,
        right.value,
      ),
      nextIndex: right.nextIndex,
    };
  }

  return left;
}
