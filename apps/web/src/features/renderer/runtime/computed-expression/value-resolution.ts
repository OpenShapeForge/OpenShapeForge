// SPDX-License-Identifier: BUSL-1.1
import {
  getValueAtPath,
  parseRendererPath,
} from "../path-utils";

type DirectTemplateResolution = {
  value: unknown;
};

export function resolvePlaceholderValue(
  path: string,
  rootValues: Record<string, unknown>,
) {
  return getValueAtPath(rootValues, parseRendererPath(path));
}

export function resolveDirectTemplateExpression(
  expression: string,
  rootValues: Record<string, unknown>,
): DirectTemplateResolution | undefined {
  const direct = expression.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (!direct) {
    return undefined;
  }

  return {
    value: resolvePlaceholderValue(direct[1].trim(), rootValues),
  };
}
