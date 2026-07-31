// SPDX-License-Identifier: BUSL-1.1
import type { Field as CompilerField } from "../../../../generated/compiler/field-contract";
import { getEntityFieldSuggestions } from "../../runtime/entity-field-suggestions";
import type { VariableSuggestion } from "../../runtime/variable-suggestions";
import type { FieldRenderContext } from "./field-renderers/types";

/**
 * Legacy compatibility boundary for compiler-generated forms that still emit
 * `suggestions.sourceField` instead of form-level `variableSources` plus
 * `suggestions.sourceKey`.
 */
export function getLegacySourceFieldVariableSuggestions(
  field: CompilerField,
  ctx: FieldRenderContext,
): VariableSuggestion[] {
  const entityType = getLegacySourceFieldStructuredValue(
    field,
    ctx.structuredValues,
  );
  return typeof entityType === "string" && entityType.length > 0
    ? getEntityFieldSuggestions(entityType, ctx.lang)
    : [];
}

export function getLegacySourceFieldStructuredValue(
  field: CompilerField,
  values: Record<string, unknown> | undefined,
): unknown {
  const sourceField = getLegacySourceFieldKey(field);
  return sourceField ? values?.[sourceField] : undefined;
}

function getLegacySourceFieldKey(field: CompilerField) {
  const sourceField = field.suggestions?.sourceField;
  return typeof sourceField === "string" && sourceField.length > 0
    ? sourceField
    : undefined;
}
