// SPDX-License-Identifier: BUSL-1.1
import type { CompilerExpressionInput } from "./canonical/canonical-condition.js";

/** A formula compiles to the canonical expression AST the evaluator runs. */
export type FormulaAst = CompilerExpressionInput;

/** The types a formula can produce, one per typed index column. */
export type FormulaType = "text" | "number" | "boolean" | "date" | "timestamp";

/**
 * Where a field lives as seen from the record that owns the formula: on the
 * record itself, or on an owned single child reached through `relation`
 * (`pricing.amount`). Anything further away is a lookup or rollup.
 */
export type FormulaFieldScope = "self" | { relation: string };

/** How a field gets its value. Only computed kinds count toward formula depth. */
export type FormulaFieldKind = "stored" | "formula" | "lookup" | "rollup";

/** A stable reference to a field, as a formula stores it. */
export type FormulaFieldRef = { id: string; scope: FormulaFieldScope };

/**
 * One field a formula may name. Authored fields, customer fields and the
 * fields of owned single children all appear here; `id` is what the AST
 * keeps, `label` and `key` are what a person types.
 */
export type FormulaField = {
  id: string;
  label: string;
  key: string;
  /** A {@link FormulaType}; any other value is a field a formula cannot use. */
  type: FormulaType | (string & {});
  classified?: boolean;
  /**
   * Set on a field that is listed only to refuse it: why a formula may not
   * read it (`outOfScope`), e.g. because the platform changes it outside the
   * record's own write.
   */
  outOfScope?: string;
  /** Absent means stored. */
  kind?: FormulaFieldKind;
  scope: FormulaFieldScope;
  /** Computed fields: how many formulas deep this field already is (a formula over stored fields is 1). */
  depth?: number;
  /** Formula fields: what the field's own formula reads, for cycle detection. */
  dependencies?: readonly FormulaFieldRef[];
};

/** The fields in reach of a formula. */
export type FormulaEnvironment = readonly FormulaField[];

/** Why a formula is refused when it is saved. */
export type FormulaDiagnosticCode =
  | "syntaxError"
  | "tooComplex"
  | "unknownField"
  | "ambiguousField"
  | "unknownFunction"
  | "argumentCount"
  | "invalidArgument"
  | "typeMismatch"
  | "mixedBranches"
  | "undeterminedType"
  | "timeFunction"
  | "outOfScope"
  | "unsupportedFieldType"
  | "classifiedField"
  | "cycle"
  | "depthExceeded";

/**
 * A refusal with the stretch of text it is about: `start` and `end` are
 * UTF-16 offsets into the formula text, `end` exclusive. `params` carries the
 * message's variable parts so a client can localise it.
 */
export type FormulaDiagnostic = {
  code: FormulaDiagnosticCode;
  message: string;
  start: number;
  end: number;
  params?: Record<string, string | number>;
};

/** Why one record's formula value could not be computed. */
export type FormulaErrorCode =
  | "divideByZero"
  | "invalidNumber"
  | "numberOutOfRange"
  | "invalidDate"
  | "textTooLong"
  | "typeError";

/** A formula value ready for the source (`extension_values`) and the typed index. */
export type FormulaValue = string | number | boolean | null;

export type FormulaEvaluation =
  | { ok: true; value: FormulaValue }
  | { ok: false; error: FormulaErrorCode };

/** The record a formula reads: field ids at the top, owned children under their relation name. */
export type FormulaRecord = Record<string, unknown>;
