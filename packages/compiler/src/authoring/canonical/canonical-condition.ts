// @ts-nocheck
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
