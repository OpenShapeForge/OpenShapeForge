// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { resolveFieldInputRender } from "@/lib/field-rendering/compiler-field-rendering";
import { isFieldCollection } from "@/lib/field-contract/field-v2";

export function fieldAllowsVariableTokenInput(
  field: Field,
  component = resolveFieldInputRender(field).component,
) {
  return (
    field.valueType === "string" &&
    !isFieldCollection(field) &&
    field.render?.props?.variableTokens !== false &&
    field.render?.props?.type !== "password" &&
    (component === "Input" || component === "InputMultiline")
  );
}
