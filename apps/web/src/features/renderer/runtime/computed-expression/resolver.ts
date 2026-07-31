// SPDX-License-Identifier: BUSL-1.1
import { parseComputedExpression } from "./parser";
import { tokenizeComputedExpression } from "./tokenizer";
import { resolveDirectTemplateExpression } from "./value-resolution";

export function resolveTemplateExpression(
  expression: string,
  rootValues: Record<string, unknown>,
): unknown {
  const direct = resolveDirectTemplateExpression(expression, rootValues);
  if (direct) {
    return direct.value;
  }

  const tokens = tokenizeComputedExpression(expression);
  if (!tokens || tokens.length === 0) {
    return expression;
  }

  const parsed = parseComputedExpression(tokens, rootValues);
  if (!parsed || parsed.nextIndex !== tokens.length) {
    return expression;
  }

  return parsed.value;
}
