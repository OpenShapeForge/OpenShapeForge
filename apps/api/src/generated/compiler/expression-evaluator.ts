// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
// Source file for the shared canonical expression evaluator.
// This file is copied verbatim into consumer repos by the workflow-contract generator.
// Keep it self-contained — no imports outside the generated canonical-condition module.
//
// Evaluation rules:
//  - group(all)   → boolean AND over all child conditions (vacuous truth on empty)
//  - group(any)   → boolean OR over all child conditions
//  - rule         → comparison operator applied to evaluated left/right operands → boolean
//  - path         → dot-walk the payload
//  - literal      → raw value
//  - function:today → today's date at 00:00 UTC (+ optional day offset)
//  - formula(add|sub|mul|div|mod) → arithmetic over evaluated operands (left-fold)
//  - formula(concat) → string join
//  - formula(lower|upper|substring|matches) → string utilities
//  - if            → evaluate condition; return then/else
//  - coalesce      → first non-null/undefined operand
//  - aggregate     → walk payload[collection]; optionally filter by `where`; project via `of`; reduce
//  - date(now|dateDiff) → runtime date helpers

import type {
  CompilerExpressionInput,
  CompilerConditionInput,
} from "./canonical-condition.js";

export type ExpressionPayload = Record<string, unknown>;

// Bounds for the `matches` formula operator. The regex pattern is
// author-controlled and executed against runtime payloads, so an unbounded
// input combined with a backtracking-prone pattern is a ReDoS vector. Capping
// both lengths keeps the worst case finite without needing a linear-time regex
// engine (this file must stay dependency-free — see the header comment).
const MATCHES_MAX_PATTERN_LENGTH = 1000;
const MATCHES_MAX_INPUT_LENGTH = 10_000;

export function evaluateExpression(
  expr: CompilerExpressionInput | null | undefined,
  payload: ExpressionPayload,
): unknown {
  if (expr === null || expr === undefined) return undefined;

  const kind = inferKind(expr);
  switch (kind) {
    case "group":
      return evalGroup(expr as GroupExpr, payload);
    case "rule":
      return evalRule(expr as RuleExpr, payload);
    case "path":
      return evalPath(expr as PathExpr, payload);
    case "literal":
      return (expr as LiteralExpr).value;
    case "function":
      return evalFunction(expr as FunctionExpr);
    case "formula":
      return evalFormula(expr as FormulaExpr, payload);
    case "if":
      return evalIf(expr as IfExpr, payload);
    case "coalesce":
      return evalCoalesce(expr as CoalesceExpr, payload);
    case "aggregate":
      return evalAggregate(expr as AggregateExpr, payload);
    case "date":
      return evalDate(expr as DateExpr, payload);
    default:
      return undefined;
  }
}

// Keep the boolean-returning shape for callers that previously used
// `evaluateCanonicalCondition`. Drops to `false` when the expression evaluates to
// a non-boolean or is missing — mirrors the prior semantics.
export function evaluateCanonicalCondition(
  expr: CompilerConditionInput | null | undefined,
  payload: ExpressionPayload,
): boolean {
  const result = evaluateExpression(expr, payload);
  return result === true;
}

type GroupExpr = Extract<CompilerExpressionInput, { kind?: "group" }>;
type RuleExpr = Extract<CompilerExpressionInput, { kind?: "rule" }>;
type PathExpr = Extract<CompilerExpressionInput, { kind: "path" }>;
type LiteralExpr = Extract<CompilerExpressionInput, { kind: "literal" }>;
type FunctionExpr = Extract<CompilerExpressionInput, { kind: "function" }>;
type FormulaExpr = Extract<CompilerExpressionInput, { kind: "formula" }>;
type IfExpr = Extract<CompilerExpressionInput, { kind: "if" }>;
type CoalesceExpr = Extract<CompilerExpressionInput, { kind: "coalesce" }>;
type AggregateExpr = Extract<CompilerExpressionInput, { kind: "aggregate" }>;
type DateExpr = Extract<CompilerExpressionInput, { kind: "date" }>;

function inferKind(expr: CompilerExpressionInput): string {
  const k = (expr as { kind?: string }).kind;
  if (k) return k;
  // Back-compat: untagged node with `conditions`/`all`/`any` is a group;
  // untagged node with `operator` is a rule.
  if (
    "conditions" in (expr as object) ||
    "all" in (expr as object) ||
    "any" in (expr as object)
  ) {
    return "group";
  }
  if ("operator" in (expr as object)) return "rule";
  return "";
}

function evalGroup(expr: GroupExpr, payload: ExpressionPayload): boolean {
  const children = expr.conditions ?? expr.all ?? expr.any ?? [];
  const mode = expr.mode ?? (expr.any ? "any" : "all");
  if (mode === "any") {
    return children.some((c) => evaluateCanonicalCondition(c, payload));
  }
  return children.every((c) => evaluateCanonicalCondition(c, payload));
}

function evalRule(expr: RuleExpr, payload: ExpressionPayload): boolean {
  const left = evaluateExpression(expr.left, payload);
  const right =
    expr.right === undefined ? undefined : evaluateExpression(expr.right, payload);

  switch (expr.operator) {
    case "equals":
      return isEqual(left, right);
    case "notEquals":
      return !isEqual(left, right);
    case "greaterThan":
      return toNumber(left) > toNumber(right);
    case "greaterThanOrEquals":
      return toNumber(left) >= toNumber(right);
    case "lessThan":
      return toNumber(left) < toNumber(right);
    case "lessThanOrEquals":
      return toNumber(left) <= toNumber(right);
    case "isEmpty":
      return isEmptyValue(left);
    case "isNotEmpty":
      return !isEmptyValue(left);
    case "contains":
      return containsValue(left, right);
    case "notContains":
      return !containsValue(left, right);
    case "startsWith":
      return typeof left === "string" && typeof right === "string" && left.startsWith(right);
    case "endsWith":
      return typeof left === "string" && typeof right === "string" && left.endsWith(right);
    case "in":
      return Array.isArray(right) && right.some((v) => isEqual(left, v));
    case "notIn":
      return !Array.isArray(right) || !right.some((v) => isEqual(left, v));
    default:
      return false;
  }
}

function evalPath(expr: PathExpr, payload: ExpressionPayload): unknown {
  const segments = expr.path.split(".");
  let cursor: unknown = payload;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      // Array access via numeric index; otherwise map over array.
      const idx = Number(segment);
      cursor = Number.isFinite(idx) ? cursor[idx] : cursor.map((v) => (v as ExpressionPayload)?.[segment]);
      continue;
    }
    cursor = (cursor as ExpressionPayload)[segment];
  }
  if (expr.offset && cursor instanceof Date) {
    return new Date(cursor.getTime() + expr.offset.days * 86_400_000);
  }
  return cursor;
}

function evalFunction(expr: FunctionExpr): unknown {
  if (expr.name === "today") {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (expr.offset) today.setUTCDate(today.getUTCDate() + expr.offset.days);
    return today;
  }
  return undefined;
}

function evalFormula(expr: FormulaExpr, payload: ExpressionPayload): unknown {
  const values = expr.operands.map((o) => evaluateExpression(o, payload));
  switch (expr.op) {
    case "add":
      return values.reduce<number>((acc, v) => acc + toNumber(v), 0);
    case "sub":
      return foldLeft(values, (a, b) => toNumber(a) - toNumber(b));
    case "mul":
      return values.reduce<number>((acc, v) => acc * toNumber(v), 1);
    case "div":
      return foldLeft(values, (a, b) => toNumber(a) / toNumber(b));
    case "mod":
      return foldLeft(values, (a, b) => toNumber(a) % toNumber(b));
    case "concat":
      return values.map((v) => (v === undefined || v === null ? "" : String(v))).join("");
    case "lower":
      return typeof values[0] === "string" ? (values[0] as string).toLowerCase() : "";
    case "upper":
      return typeof values[0] === "string" ? (values[0] as string).toUpperCase() : "";
    case "substring": {
      const [s, start, end] = values;
      if (typeof s !== "string") return "";
      const a = typeof start === "number" ? start : 0;
      const b = typeof end === "number" ? end : undefined;
      return b === undefined ? s.substring(a) : s.substring(a, b);
    }
    case "matches": {
      const [s, pattern] = values;
      if (typeof s !== "string" || typeof pattern !== "string") return false;
      // `pattern` is an author-controlled regex compiled and run at
      // workflow-evaluation time against runtime payloads. A catastrophically
      // backtracking pattern (e.g. `(a+)+$`) against a long input string can
      // hang the evaluating thread (ReDoS). We cannot pull in a linear-time
      // regex engine here (this file is copied verbatim into consumer repos and
      // must stay dependency-free), so we bound the blast radius by capping both
      // the pattern and the input length before compiling. This makes any
      // backtracking blow-up finite and cheap. `matches` patterns are still
      // trusted-author-only by contract.
      if (pattern.length > MATCHES_MAX_PATTERN_LENGTH) return false;
      if (s.length > MATCHES_MAX_INPUT_LENGTH) return false;
      try {
        return new RegExp(pattern).test(s);
      } catch {
        return false;
      }
    }
    default:
      return undefined;
  }
}

function evalIf(expr: IfExpr, payload: ExpressionPayload): unknown {
  const cond = evaluateExpression(expr.condition, payload);
  const branch = cond === true ? expr.then : expr["else"];
  return evaluateExpression(branch, payload);
}

function evalCoalesce(expr: CoalesceExpr, payload: ExpressionPayload): unknown {
  for (const operand of expr.operands) {
    const v = evaluateExpression(operand, payload);
    if (v !== null && v !== undefined) return v;
  }
  return undefined;
}

function evalAggregate(expr: AggregateExpr, payload: ExpressionPayload): unknown {
  const raw = payload[expr.collection];
  const items = Array.isArray(raw) ? (raw as ExpressionPayload[]) : [];
  const filtered = expr.where
    ? items.filter((item) => evaluateCanonicalCondition(expr.where, item))
    : items;

  if (expr.op === "count") return filtered.length;

  const projected = filtered.map((item) =>
    expr.of === undefined ? item : evaluateExpression(expr.of, item),
  );
  const numbers = projected.map(toNumber).filter((n) => Number.isFinite(n));

  if (numbers.length === 0) return expr.op === "sum" ? 0 : undefined;

  switch (expr.op) {
    case "sum":
      return numbers.reduce((a, b) => a + b, 0);
    case "avg":
      return numbers.reduce((a, b) => a + b, 0) / numbers.length;
    case "min":
      return Math.min(...numbers);
    case "max":
      return Math.max(...numbers);
    default:
      return undefined;
  }
}

function evalDate(expr: DateExpr, payload: ExpressionPayload): unknown {
  switch (expr.op) {
    case "now":
      return new Date();
    case "dateDiff": {
      const left = expr.left === undefined ? undefined : evaluateExpression(expr.left, payload);
      const right = expr.right === undefined ? undefined : evaluateExpression(expr.right, payload);
      const l = toDate(left);
      const r = toDate(right);
      if (l === undefined || r === undefined) return undefined;
      return Math.floor((l.getTime() - r.getTime()) / 86_400_000);
    }
    default:
      return undefined;
  }
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  return false;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function containsValue(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string" && typeof needle === "string") return haystack.includes(needle);
  if (Array.isArray(haystack)) return haystack.some((v) => isEqual(v, needle));
  return false;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  if (v instanceof Date) return v.getTime();
  return 0;
}

function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function foldLeft(values: unknown[], fn: (a: unknown, b: unknown) => number): number {
  if (values.length === 0) return 0;
  let acc: unknown = values[0];
  for (let i = 1; i < values.length; i++) acc = fn(acc, values[i]);
  return toNumber(acc);
}
