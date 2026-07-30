// SPDX-License-Identifier: BUSL-1.1
import type { Field as CompilerField } from "../../../../../generated/compiler/field-contract";
import { isFieldCardinalityCollection } from "../../../edit/controls/complex/field-schema-editor/utils";
import { translateRendererText } from "../../../runtime/field-utils";
import {
  filterVariableSuggestions,
  getVariableFilterForField,
  type VariableFilter,
} from "../../../runtime/variable-compatibility";
import type { VariableSuggestion } from "../../../runtime/variable-suggestions";
import { fieldAllowsVariableTokenInput } from "../../../runtime/variable-token-fields";
import { getLegacySourceFieldVariableSuggestions } from "../legacy-source-field";
import type { FieldRenderContext } from "./types";

/**
 * Resolve the `VariableSuggestion[]` a field should show in its `$`-triggered
 * picker.
 *
 * Order of preference:
 *  1. New form-level source (`field.suggestions.sourceKey`): look up the
 *     pre-resolved pool on the context; apply the field's explicit
 *     `suggestions.filter` if present, otherwise fall back to the inferred
 *     filter from `getVariableFilterForField`.
 *  2. Legacy per-field path (`field.suggestions.sourceField`): read the sibling
 *     field's value as an entity-type name and call `getEntityFieldSuggestions`.
 *     The label rule and similar entity forms still emit this shape; we keep it
 *     working until every compiler-generated form opts into `sourceKey`.
 *  3. Neither set: `[]`.
 *
 * A missing `sourceKey` on the context is a silent empty (design doc section 5)
 * with a dev-mode warning to catch authoring mistakes.
 */
export function getFieldVariableSuggestions(
  field: CompilerField,
  ctx: FieldRenderContext,
): VariableSuggestion[] {
  const suggestions = field.suggestions;

  if (suggestions?.sourceKey) {
    const pool = ctx.resolvedVariableSources?.[suggestions.sourceKey];
    if (!pool) {
      if (
        process.env.NODE_ENV !== "production" &&
        ctx.resolvedVariableSources &&
        !(suggestions.sourceKey in ctx.resolvedVariableSources)
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[getFieldVariableSuggestions] Field "${field.key}" declared sourceKey "${suggestions.sourceKey}" but the form did not declare a matching variableSource. Returning no suggestions.`,
        );
      }
      return [];
    }
    // Consumer semantic types (variableTemplate, condition) are containers of
    // variables, not typed slots — any suggestion can be dropped in as a
    // placeholder. Inferring a semanticType filter from the field's own type
    // would incorrectly filter the pool to zero. Only apply the inferred
    // filter when the field is a typed consumer; an explicit
    // `suggestions.filter` still wins so authors can narrow when they need to.
    const isConsumerField =
      field.semanticType === "variableTemplate" ||
      field.semanticType === "condition";
    // `filter` is an optional authoring narrowing that the compiled
    // `FieldSuggestions` contract in this repo does not model, so it is read
    // structurally: authored narrowing still wins where a catalog provides it,
    // and its absence falls through to the inferred filter as before.
    const authoredFilter = (suggestions as { filter?: VariableFilter | null })
      .filter;
    const filter =
      authoredFilter ??
      (isConsumerField ? null : getVariableFilterForField(field));
    return filterVariableSuggestions(pool, filter);
  }

  const legacySuggestions = getLegacySourceFieldVariableSuggestions(field, ctx);
  if (legacySuggestions.length > 0) return legacySuggestions;

  return [];
}

export function getTextFieldVariableSuggestions(
  field: CompilerField,
  ctx: FieldRenderContext,
): VariableSuggestion[] | undefined {
  if (!fieldAllowsVariableTokenInput(field)) {
    return undefined;
  }
  const chips = ctx.resolvedVariableSources?.chips ?? [];
  const fieldSuggestions = getFieldVariableSuggestions(field, ctx);
  if (fieldSuggestions.length === 0) {
    return chips;
  }
  if (chips.length === 0) {
    return fieldSuggestions;
  }
  return mergeVariableSuggestionPools(fieldSuggestions, chips);
}

export function getConditionFieldVariableSuggestions(
  field: CompilerField,
  ctx: FieldRenderContext,
): VariableSuggestion[] {
  const chips = ctx.resolvedVariableSources?.chips ?? [];
  const fieldSuggestions = getFieldVariableSuggestions(field, ctx);
  if (fieldSuggestions.length === 0) {
    return chips;
  }
  if (chips.length === 0) {
    return fieldSuggestions;
  }
  return mergeVariableSuggestionPools(fieldSuggestions, chips);
}

export function findVariableSuggestionForRendererValue(
  suggestions: readonly VariableSuggestion[],
  storedValue: unknown,
): VariableSuggestion | null {
  if (typeof storedValue !== "string" || storedValue.trim().length === 0) {
    return null;
  }
  const normalized = storedValue.trim().replace(
    /^\{\{\s*([^{}]+?)\s*\}\}$/,
    "{{$1}}",
  );
  return (
    suggestions.find((suggestion) => {
      const values = [suggestion.insertText, suggestion.path].map((value) =>
        value.trim().replace(/^\{\{\s*([^{}]+?)\s*\}\}$/, "{{$1}}"),
      );
      return (
        values.includes(normalized) ||
        normalized === `{{${suggestion.path.trim()}}}`
      );
    }) ?? null
  );
}

export function variableSuggestionFromFieldDefinitionRow(
  row: Record<string, unknown> | null,
): VariableSuggestion | null {
  if (!row || row.kind !== "variable" || typeof row.source !== "string") {
    return null;
  }
  const label =
    translateRendererText(
      row.label as CompilerField["label"] | undefined,
      "nl",
    ) ?? (typeof row.key === "string" ? row.key : "");
  if (!label.trim()) {
    return null;
  }
  const source = row.source.trim();
  return {
    path: source.replace(/^\{\{\s*([^{}]+?)\s*\}\}$/, "$1"),
    displayPath: source,
    fieldPath: typeof row.key === "string" ? row.key : source,
    insertText: source,
    label,
    sourceNodeId: "stored-field-definition",
    sourceNodeLabel: "Opgeslagen variabele",
    valueType: isFieldCardinalityCollection(row.cardinality)
      ? "array"
      : row.valueType === "number" || row.valueType === "integer"
        ? "number"
        : row.valueType === "boolean"
          ? "boolean"
          : row.valueType === "object"
            ? "object"
            : "string",
    fieldType:
      typeof row.valueType === "string"
        ? (row.valueType as VariableSuggestion["fieldType"])
        : "string",
    ...(typeof row.semanticType === "string"
      ? { semanticType: row.semanticType }
      : {}),
  };
}

function mergeVariableSuggestionPools(
  ...pools: Array<readonly VariableSuggestion[] | undefined>
): VariableSuggestion[] {
  const merged: VariableSuggestion[] = [];
  const seen = new Set<string>();
  for (const pool of pools) {
    for (const suggestion of pool ?? []) {
      const key = suggestion.insertText || suggestion.path;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(suggestion);
    }
  }
  return merged;
}
