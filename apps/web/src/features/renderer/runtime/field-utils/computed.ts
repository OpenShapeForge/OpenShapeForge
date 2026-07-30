// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { resolveTemplateExpression } from "../computed-expression";

export function resolveComputedRendererFieldValue(
  field: Field,
  rootValues: Record<string, unknown>,
): unknown {
  if (!field.computed?.expression) {
    return undefined;
  }

  return resolveTemplateExpression(field.computed.expression, rootValues);
}
