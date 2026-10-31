// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
// Source file for canonical condition / expression TypeScript types.
// This file is copied verbatim into consumer repos by the workflow-contract generator.
// Keep it self-contained — no imports.

export type CompilerConditionOperator =
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "greaterThanOrEquals"
  | "lessThan"
  | "lessThanOrEquals"
  | "isEmpty"
  | "isNotEmpty"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "notIn";

export type CompilerConditionMode = "all" | "any";

export type CompilerFormulaOperator =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "mod"
  | "concat"
  | "lower"
  | "upper"
  | "substring"
  | "matches";

export type CompilerAggregateOperator = "count" | "sum" | "avg" | "min" | "max";

export type CompilerDateOperator = "now" | "dateDiff";

// Leaf operand expressions (retained for backward compatibility with existing callers).
export type CompilerConditionOperandInput =
  | { kind: "path"; path: string; filter?: Record<string, unknown>; offset?: { days: number } }
  | { kind: "literal"; value: unknown }
  | { kind: "function"; name: "today"; offset?: { days: number } };

// Unified expression tree. Every variant produces a value; the top-level
// container (group / rule / formula / aggregate / date / if / coalesce) decides
// how children combine. Leaf operand kinds (path / literal / function) are also
// valid expressions in their own right so that nested usage works uniformly.
export type CompilerExpressionInput =
  | {
      kind?: "group";
      id?: string;
      mode?: CompilerConditionMode;
      conditions?: CompilerExpressionInput[];
      all?: CompilerExpressionInput[];
      any?: CompilerExpressionInput[];
    }
  | {
      kind?: "rule";
      id?: string;
      operator: CompilerConditionOperator;
      left: CompilerExpressionInput;
      right?: CompilerExpressionInput;
    }
  | { kind: "path"; path: string; filter?: Record<string, unknown>; offset?: { days: number } }
  | { kind: "literal"; value: unknown }
  | { kind: "function"; name: "today"; offset?: { days: number } }
  | {
      kind: "formula";
      id?: string;
      op: CompilerFormulaOperator;
      operands: CompilerExpressionInput[];
    }
  | {
      kind: "if";
      id?: string;
      condition: CompilerExpressionInput;
      then: CompilerExpressionInput;
      "else": CompilerExpressionInput;
    }
  | {
      kind: "coalesce";
      id?: string;
      operands: CompilerExpressionInput[];
    }
  | {
      kind: "aggregate";
      id?: string;
      op: CompilerAggregateOperator;
      collection: string;
      where?: CompilerExpressionInput;
      of?: CompilerExpressionInput;
    }
  | {
      kind: "date";
      id?: string;
      op: CompilerDateOperator;
      left?: CompilerExpressionInput;
      right?: CompilerExpressionInput;
    };

// Back-compat alias: workflow conditions are expressions that evaluate to boolean.
// Kept as a structural alias so existing imports keep working; callers should
// still only construct group/rule shapes where a boolean is expected.
export type CompilerConditionInput = CompilerExpressionInput;

// ---------------------------------------------------------------------------
// Authorization-safe condition subset (opt-in)
// ---------------------------------------------------------------------------
// The contract above is open-world: an operand that is absent from the payload
// is an ordinary missing value, so a negative operator reads it as a match —
// `notIn` and `notEquals` against an operand the payload never carried are
// `true`. That is the right answer for a workflow gate or a computed field, and
// the wrong one for a condition that decides access, where an operand nobody
// could resolve must never read as a grant.
//
// These types describe the narrower subset a caller opts into for that use. It
// is a validation and evaluation contract over the same AST — not an
// authorization decision, not a permission model, and not a statement about
// what a caller may see: whoever asks still owns the decision, the operand
// payload it is asked about, and every other check around it.

export type CompilerAuthorizationSafeOperator =
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "greaterThanOrEquals"
  | "lessThan"
  | "lessThanOrEquals"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "notIn";

// Why an expression is refused rather than answered. `unknownOperand` is the
// evaluation-time case: the expression is well-formed, but an operand did not
// resolve, so no completion of the missing values is provable.
export type CompilerAuthorizationSafeRejection =
  | "unsupportedExpression"
  | "unsupportedOperator"
  | "unsupportedOperand"
  | "complexityExceeded"
  | "unknownOperand";

// Ceilings and the accepted operand roots. Every field is a ceiling or an
// allow-list, so omitting one widens nothing beyond the documented default.
export type CompilerAuthorizationSafeOptions = {
  // Root segment every `path` operand must start with. Default: actorRelation, resource.
  operandRoots?: readonly string[];
  maxNodes?: number;
  maxDepth?: number;
  maxPathSegments?: number;
};

export type CompilerAuthorizationSafeValidation =
  | { valid: true }
  | {
      valid: false;
      rejection: CompilerAuthorizationSafeRejection;
      // Names the offending construct and the type of the offending value,
      // never a payload value: callers log this.
      detail: string;
    };

export type CompilerAuthorizationSafeEvaluation =
  | { outcome: "satisfied" }
  | { outcome: "notSatisfied" }
  | {
      outcome: "rejected";
      rejection: CompilerAuthorizationSafeRejection;
      detail: string;
    };
