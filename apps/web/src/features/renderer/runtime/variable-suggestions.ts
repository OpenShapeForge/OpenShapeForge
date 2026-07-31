// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import type { FieldRuntimeKind } from "@/lib/field-contract/field-v2";

export type AggregateFunction = "count" | "sum" | "min" | "max";

/**
 * Colours for a variable-suggestion chip, keyed off the category of the node
 * that produced the variable. The renderer only ever *carries* a tone through
 * to the chip; whichever feature owns the source-node taxonomy decides what
 * the values are and passes them in. With no such feature in this repo, every
 * suggestion leaves `sourceNodeTone` unset and chips fall back to their
 * default styling.
 */
export type WorkflowNodeTone = {
  background: string;
  border: string;
  text: string;
};

export type AggregateFilterableField = {
  /** The camelCase field key used in the GraphQL filter input. */
  key: string;
  /** Human-readable label for the field. */
  label: string;
  /** The field type (string, integer, boolean, date, etc.). */
  type: string;
  /** Static options for dropdown rendering (e.g., status values). */
  options?: Array<{ value: string; label: string }>;
};

export type VariableSuggestionAggregate = {
  /** The aggregate function applied (count, sum, min, max). */
  function: AggregateFunction;
  /** The relationship key this aggregate is derived from (e.g., "invoices"). */
  relationship: string;
  /** The target field for sum/min/max (e.g., "amount"). Absent for count. */
  targetField?: string;
  /** Filterable scalar fields on the target entity. Used by the condition builder to render inline filter inputs. */
  filterableFields?: AggregateFilterableField[];
};

export type VariableSuggestion = {
  path: string;
  displayPath: string;
  fieldPath: string;
  insertText: string;
  /** Alternate stored path/template forms that should resolve to this suggestion. */
  aliases?: string[];
  label: string;
  /** Full human-readable label path for nested fields (e.g., "Subtaken (aggregaat) > Aantal"). Falls back to label when absent. */
  displayLabel?: string;
  sourceNodeId: string;
  sourceNodeLabel: string;
  sourceNodeTone?: WorkflowNodeTone;
  /**
   * Optional graph distance from the currently edited workflow node to the
   * suggestion's source node. Lower means closer. Generic/non-graph sources
   * leave this unset and are sorted after graph-local sources.
   */
  sourceNodeDistance?: number;
  fieldType?: FieldRuntimeKind;
  valueType: "string" | "number" | "boolean" | "object" | "array";
  semanticType?: string;
  itemSemanticType?: string;
  options?: Array<{
    value: string;
    label: string;
  }>;
  referentieGroep?: string;
  /**
   * For globally-rendered text variables such as chips, this is the current
   * tenant value used by read-mode previews and runtime-safe replacement.
   */
  resolvedValue?: string;
  /** Present when this suggestion represents an aggregate over a collection relationship. */
  aggregate?: VariableSuggestionAggregate;
  /**
   * Origin of the suggestion. `"entityField"` — a persisted/static entity field.
   * `"labelRule"` — a runtime computed value from the `label_rules` table
   * (resolved by `ctx.labelService.resolve` at workflow execution time).
   * Used by the variable dropdown to visually differentiate computed runtime
   * values from persisted fields.
   */
  variableSource?: "chip" | "entityField" | "labelRule";
};
