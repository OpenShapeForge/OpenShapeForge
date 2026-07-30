// SPDX-License-Identifier: BUSL-1.1
import type {
  ComputedSymbolTokenType,
  ComputedToken,
} from "./types";

const LONG_OPERATORS = [
  "!==",
  "===",
  ">=",
  "<=",
  "&&",
  "||",
  "??",
  "!=",
  "==",
] as const;

export function tokenizeComputedExpression(
  expression: string,
): ComputedToken[] | undefined {
  const tokens: ComputedToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index]!;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }

    if (expression.startsWith("{{", index)) {
      const endIndex = expression.indexOf("}}", index + 2);
      if (endIndex === -1) {
        return undefined;
      }

      const path = expression.slice(index + 2, endIndex).trim();
      if (!path) {
        return undefined;
      }

      tokens.push({ type: "placeholder", value: path });
      index = endIndex + 2;
      continue;
    }

    const matchedLongOperator = LONG_OPERATORS.find((operator) =>
      expression.startsWith(operator, index),
    );
    if (matchedLongOperator) {
      tokens.push({ type: matchedLongOperator });
      index += matchedLongOperator.length;
      continue;
    }

    if ("()+-*/%!><".includes(current)) {
      tokens.push({ type: current as ComputedSymbolTokenType });
      index += 1;
      continue;
    }

    if (current === '"' || current === "'") {
      let nextIndex = index + 1;
      let value = "";

      while (nextIndex < expression.length) {
        const nextChar = expression[nextIndex]!;
        if (nextChar === "\\") {
          const escaped = expression[nextIndex + 1];
          if (escaped) {
            value += escaped;
            nextIndex += 2;
            continue;
          }

          return undefined;
        }

        if (nextChar === current) {
          break;
        }

        value += nextChar;
        nextIndex += 1;
      }

      if (expression[nextIndex] !== current) {
        return undefined;
      }

      tokens.push({ type: "string", value });
      index = nextIndex + 1;
      continue;
    }

    const numberMatch = expression.slice(index).match(/^-?\d+(\.\d+)?/);
    if (numberMatch) {
      tokens.push({ type: "number", value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }

    const keywordMatch = expression.slice(index).match(/^(true|false|null)\b/);
    if (keywordMatch) {
      if (keywordMatch[0] === "null") {
        tokens.push({ type: "null", value: null });
      } else {
        tokens.push({ type: "boolean", value: keywordMatch[0] === "true" });
      }
      index += keywordMatch[0].length;
      continue;
    }

    return undefined;
  }

  return tokens;
}
