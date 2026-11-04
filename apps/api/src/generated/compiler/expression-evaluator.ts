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
//  - function:recordId|createdTime → payload.id / payload.createdAt (as a Date)
//  - formula(add|sub|mul|div|mod) → arithmetic over evaluated operands (left-fold)
//  - formula(concat) → string join
//  - formula(lower|upper|substring|matches) → string utilities
//  - formula(left|right|mid|len|trim|substitute) → spreadsheet text functions
//  - formula(not|negate|isError) → logical negation, unary minus, error test
//  - formula(round|roundUp|roundDown|abs|value|power|sqrt|ceiling|floor) → numeric functions
//  - formula(min|max|sum|average) → over the operands that are present
//  - if            → evaluate condition; return then/else
//  - switch        → first case whose `when` equals `subject`; else `default`
//  - coalesce      → first non-null/undefined operand
//  - aggregate     → walk payload[collection]; optionally filter by `where`; project via `of`; reduce
//  - date(now|dateDiff|dateAdd|datetimeFormat|year|month|day) → runtime date helpers (UTC)
//
// Arithmetic never throws: a division by zero is Infinity or NaN and an
// impossible date is an invalid Date, exactly as JavaScript computes them, and
// formula(isError) recognises both. A caller that needs a reason per value
// classifies them (the customer-formula package does).
//
// These rules are open-world: a missing operand is an ordinary absent value. A
// caller that needs a missing operand to never read as a match opts into the
// closed-world subset at the bottom of this file instead.

import type {
  CompilerExpressionInput,
  CompilerConditionInput,
  CompilerConditionOperator,
  CompilerAuthorizationSafeEvaluation,
  CompilerAuthorizationSafeOptions,
  CompilerAuthorizationSafeRejection,
  CompilerAuthorizationSafeValidation,
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
      return evalFunction(expr as FunctionExpr, payload);
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
    case "switch":
      return evalSwitch(expr as SwitchExpr, payload);
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
type SwitchExpr = Extract<CompilerExpressionInput, { kind: "switch" }>;

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
  return applyConditionOperator(expr.operator, left, right);
}

// The comparison table of a `rule`, over already-evaluated operands. Exported so
// the authorization-safe subset below compares with exactly these semantics once
// it has established that both operands resolved and are comparable.
export function applyConditionOperator(
  operator: CompilerConditionOperator,
  left: unknown,
  right: unknown,
): boolean {
  switch (operator) {
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

function evalFunction(expr: FunctionExpr, payload: ExpressionPayload): unknown {
  switch (expr.name) {
    case "today": {
      const now = new Date();
      const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      if (expr.offset) today.setUTCDate(today.getUTCDate() + expr.offset.days);
      return today;
    }
    case "recordId":
      return payload.id;
    case "createdTime":
      return toDate(payload.createdAt);
    default:
      return undefined;
  }
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
    case "left":
      return toText(values[0]).slice(0, wholeCount(values[1]));
    case "right": {
      const count = wholeCount(values[1]);
      return count === 0 ? "" : toText(values[0]).slice(-count);
    }
    case "mid": {
      // 1-based start, as in a spreadsheet.
      const start = Math.max(1, Math.trunc(toNumber(values[1]))) - 1;
      return toText(values[0]).slice(start, start + wholeCount(values[2]));
    }
    case "len":
      return toText(values[0]).length;
    case "trim":
      return toText(values[0]).trim();
    case "substitute":
      return substitute(toText(values[0]), toText(values[1]), toText(values[2]), values[3]);
    case "not":
      return values[0] !== true;
    case "negate":
      return -toNumber(values[0]);
    case "isError":
      return isErrorValue(values[0]);
    case "round":
      return roundTo(toNumber(values[0]), precisionOf(values[1]), Math.round);
    case "roundUp":
      return roundTo(toNumber(values[0]), precisionOf(values[1]), Math.ceil);
    case "roundDown":
      return roundTo(toNumber(values[0]), precisionOf(values[1]), Math.floor);
    case "abs":
      return Math.abs(toNumber(values[0]));
    case "value":
      return parseNumberText(values[0]);
    case "power":
      return Math.pow(toNumber(values[0]), toNumber(values[1]));
    case "sqrt":
      return Math.sqrt(toNumber(values[0]));
    case "ceiling":
      return toMultiple(toNumber(values[0]), values[1], Math.ceil);
    case "floor":
      return toMultiple(toNumber(values[0]), values[1], Math.floor);
    case "min":
    case "max":
    case "sum":
    case "average": {
      // Blank operands are skipped, as a spreadsheet skips empty cells; with
      // nothing left, sum is 0 and the others are blank.
      const numbers = values.filter((v) => v !== null && v !== undefined && v !== "").map(toNumber);
      if (expr.op === "sum") return numbers.reduce((a, b) => a + b, 0);
      if (numbers.length === 0) return undefined;
      if (expr.op === "min") return Math.min(...numbers);
      if (expr.op === "max") return Math.max(...numbers);
      return numbers.reduce((a, b) => a + b, 0) / numbers.length;
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

function evalSwitch(expr: SwitchExpr, payload: ExpressionPayload): unknown {
  const subject = normalizeAbsent(evaluateExpression(expr.subject, payload));
  for (const entry of expr.cases ?? []) {
    if (isEqual(subject, normalizeAbsent(evaluateExpression(entry.when, payload)))) {
      return evaluateExpression(entry.then, payload);
    }
  }
  return expr["default"] === undefined ? undefined : evaluateExpression(expr["default"], payload);
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
      if (expr.unit !== undefined) return dateDifference(l, r, expr.unit);
      return Math.floor((l.getTime() - r.getTime()) / 86_400_000);
    }
    case "dateAdd": {
      const base = toDate(expr.left === undefined ? undefined : evaluateExpression(expr.left, payload));
      if (base === undefined) return undefined;
      const amount = toNumber(expr.right === undefined ? undefined : evaluateExpression(expr.right, payload));
      return addToDate(base, amount, expr.unit ?? "days");
    }
    case "datetimeFormat": {
      const date = toDate(expr.left === undefined ? undefined : evaluateExpression(expr.left, payload));
      if (date === undefined) return undefined;
      const format = expr.right === undefined ? undefined : evaluateExpression(expr.right, payload);
      return formatDate(date, typeof format === "string" && format !== "" ? format : undefined);
    }
    case "year":
    case "month":
    case "day": {
      const date = toDate(expr.left === undefined ? undefined : evaluateExpression(expr.left, payload));
      if (date === undefined) return undefined;
      if (expr.op === "year") return date.getUTCFullYear();
      return expr.op === "month" ? date.getUTCMonth() + 1 : date.getUTCDate();
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

// ---------------------------------------------------------------------------
// Spreadsheet helpers (text, numeric and calendar functions)
// ---------------------------------------------------------------------------

function normalizeAbsent(v: unknown): unknown {
  return v === undefined ? null : v;
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  return String(v);
}

function wholeCount(v: unknown): number {
  const n = Math.trunc(toNumber(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function precisionOf(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Math.trunc(toNumber(v));
  return Number.isFinite(n) ? n : 0;
}

export function isErrorValue(v: unknown): boolean {
  if (typeof v === "number") return !Number.isFinite(v);
  return v instanceof Date && Number.isNaN(v.getTime());
}

function substitute(text: string, needle: string, replacement: string, occurrence: unknown): string {
  if (needle === "") return text;
  if (occurrence === null || occurrence === undefined) return text.split(needle).join(replacement);
  const nth = Math.trunc(toNumber(occurrence));
  if (!(nth >= 1)) return text;
  let from = 0;
  let at = -1;
  for (let i = 0; i < nth; i++) {
    at = text.indexOf(needle, from);
    if (at < 0) return text;
    from = at + needle.length;
  }
  return text.slice(0, at) + replacement + text.slice(at + needle.length);
}

// Rounds the magnitude, so `round` is half away from zero, `roundUp` away from
// zero and `roundDown` toward zero, as in a spreadsheet. The decimal shift goes
// through the number's own decimal notation so 1.005 rounds as written rather
// than as its binary approximation.
function roundTo(value: number, digits: number, round: (n: number) => number): number {
  if (!Number.isFinite(value)) return value;
  const magnitude = round(shiftDecimal(Math.abs(value), digits));
  const result = (value < 0 ? -1 : 1) * shiftDecimal(magnitude, -digits);
  return result === 0 ? 0 : result;
}

function shiftDecimal(value: number, digits: number): number {
  const [mantissa, exponent = "0"] = String(value).split("e");
  return Number(`${mantissa}e${Number(exponent) + digits}`);
}

// The nearest multiple of `significance` (default 1) in the direction of `round`.
function toMultiple(value: number, significance: unknown, round: (n: number) => number): number {
  const step = significance === null || significance === undefined ? 1 : toNumber(significance);
  if (!Number.isFinite(value) || !Number.isFinite(step)) return NaN;
  if (step === 0) return 0;
  const result = Number((round(Number((value / step).toPrecision(15))) * step).toPrecision(15));
  return result === 0 ? 0 : result;
}

// Text to number: blank stays blank, currency symbols, spaces and thousands
// separators are ignored, and text without a number is NaN.
function parseNumberText(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const text = String(v).trim();
  if (text === "") return undefined;
  const cleaned = text.replace(/[^0-9.eE+-]/g, "");
  return /[0-9]/.test(cleaned) ? Number(cleaned) : NaN;
}

const FIXED_UNIT_MS: Record<string, number> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

const CALENDAR_UNIT_MONTHS: Record<string, number> = { months: 1, quarters: 3, years: 12 };

function addToDate(date: Date, amount: number, unit: string): Date {
  const months = CALENDAR_UNIT_MONTHS[unit];
  if (months !== undefined) return addMonths(date, Math.trunc(amount) * months);
  const size = FIXED_UNIT_MS[unit];
  return new Date(size === undefined ? NaN : date.getTime() + amount * size);
}

// Calendar months, clamped to the end of a shorter month (31 Jan + 1 month is
// 28 or 29 Feb), keeping the time of day.
function addMonths(date: Date, months: number): Date {
  if (!Number.isFinite(months)) return new Date(NaN);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

// `left - right` in whole units, truncated toward zero. Calendar units count
// whole months the way `addMonths` steps them.
function dateDifference(left: Date, right: Date, unit: string): number | undefined {
  const months = CALENDAR_UNIT_MONTHS[unit];
  if (months !== undefined) {
    let whole =
      (left.getUTCFullYear() - right.getUTCFullYear()) * 12 + (left.getUTCMonth() - right.getUTCMonth());
    const anchor = addMonths(right, whole).getTime();
    if (whole > 0 && anchor > left.getTime()) whole -= 1;
    else if (whole < 0 && anchor < left.getTime()) whole += 1;
    const result = Math.trunc(whole / months);
    return result === 0 ? 0 : result;
  }
  const size = FIXED_UNIT_MS[unit];
  if (size === undefined) return undefined;
  const result = Math.trunc((left.getTime() - right.getTime()) / size);
  return result === 0 ? 0 : result;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DATE_FORMAT_TOKEN =
  /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|DD|D|dddd|ddd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|X|x|ZZ|Z/g;

// Moment-style format tokens (the ones spreadsheet users meet in Airtable's
// DATETIME_FORMAT), always in UTC. `[text]` is literal; without a format the
// result is ISO 8601.
function formatDate(date: Date, format: string | undefined): string {
  if (Number.isNaN(date.getTime())) return "";
  if (format === undefined) return date.toISOString();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const hours = date.getUTCHours();
  return format.replace(DATE_FORMAT_TOKEN, (token, literal) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case "YYYY": return pad(date.getUTCFullYear(), 4);
      case "YY": return pad(date.getUTCFullYear() % 100);
      case "Q": return String(Math.floor(date.getUTCMonth() / 3) + 1);
      case "MMMM": return MONTH_NAMES[date.getUTCMonth()];
      case "MMM": return MONTH_NAMES[date.getUTCMonth()].slice(0, 3);
      case "MM": return pad(date.getUTCMonth() + 1);
      case "M": return String(date.getUTCMonth() + 1);
      case "DD": return pad(date.getUTCDate());
      case "D": return String(date.getUTCDate());
      case "dddd": return DAY_NAMES[date.getUTCDay()];
      case "ddd": return DAY_NAMES[date.getUTCDay()].slice(0, 3);
      case "d": return String(date.getUTCDay());
      case "HH": return pad(hours);
      case "H": return String(hours);
      case "hh": return pad(hours % 12 === 0 ? 12 : hours % 12);
      case "h": return String(hours % 12 === 0 ? 12 : hours % 12);
      case "mm": return pad(date.getUTCMinutes());
      case "m": return String(date.getUTCMinutes());
      case "ss": return pad(date.getUTCSeconds());
      case "s": return String(date.getUTCSeconds());
      case "SSS": return pad(date.getUTCMilliseconds(), 3);
      case "A": return hours < 12 ? "AM" : "PM";
      case "a": return hours < 12 ? "am" : "pm";
      case "X": return String(Math.floor(date.getTime() / 1000));
      case "x": return String(date.getTime());
      case "ZZ": return "+0000";
      case "Z": return "+00:00";
      default: return token;
    }
  });
}

// ---------------------------------------------------------------------------
// Authorization-safe subset (opt-in)
// ---------------------------------------------------------------------------
// A closed-world reading of the same AST, through the same operand evaluation
// and the same comparison table, for a caller that cannot treat an unresolved
// operand as a match. Two differences from the rules above, and nothing else:
//
//  1. The accepted shape is narrow, and checked in full before any evaluation:
//     group / rule containers, path / literal / function:today operands, the
//     operators in `authorizationSafeOperandShape`, within the configured
//     node / depth / path-segment ceilings. Anything else is refused, never
//     silently evaluated — including the ambiguous shapes the open-world
//     evaluator tolerates (a group carrying both `all` and `any`, a keyed group
//     contradicted by `mode`, an empty group whose `all` would be vacuously
//     true).
//  2. Evaluation is three-valued. An operand that does not resolve, or a pair
//     the operator cannot compare without coercion, makes its rule *unknown*
//     rather than true or false, and unknown propagates: `all` is satisfied
//     only when every child is true, `any` only when some child is true. So a
//     negative operator over an operand the payload never carried is never
//     satisfied, while an `any` profile whose other branch is provably true
//     still is — the result is exactly "provable under every completion of the
//     missing values".
//
// This is validation and evaluation only. It decides nothing about access, adds
// no runtime policy and exposes no data; the caller owns the decision, owns the
// operand payload it passes in, and still needs every other check it had.

export const AUTHORIZATION_SAFE_DEFAULT_OPERAND_ROOTS: readonly string[] = ["actorRelation", "resource"];
export const AUTHORIZATION_SAFE_DEFAULT_MAX_NODES = 200;
export const AUTHORIZATION_SAFE_DEFAULT_MAX_DEPTH = 16;
export const AUTHORIZATION_SAFE_DEFAULT_MAX_PATH_SEGMENTS = 8;

// A day offset is author-controlled, but it reaches `Date` arithmetic, so bound
// it to a range that cannot produce an invalid date.
const AUTHORIZATION_SAFE_MAX_OFFSET_DAYS = 36_500;
const AUTHORIZATION_SAFE_MAX_LIST_ITEMS = 100;
const AUTHORIZATION_SAFE_MAX_STRING_LENGTH = 2000;

type AuthorizationSafeLimits = {
  operandRoots: readonly string[];
  maxNodes: number;
  maxDepth: number;
  maxPathSegments: number;
};

type AuthorizationSafeRejected = {
  rejection: CompilerAuthorizationSafeRejection;
  detail: string;
};

// Carries the node budget during validation, and the first reason a rule went
// unknown during evaluation — reported only if the whole expression is unknown.
type AuthorizationSafeState = {
  nodes: number;
  unknown?: AuthorizationSafeRejected;
};

// Which operand pair an operator can decide. Written as a switch rather than a
// lookup object so an operator name that happens to exist on Object.prototype
// cannot resolve to a shape.
type AuthorizationSafeOperandShape =
  | "scalar"
  | "ordering"
  | "textual"
  | "membership"
  | "containment";

function authorizationSafeOperandShape(
  operator: unknown,
): AuthorizationSafeOperandShape | undefined {
  switch (operator) {
    case "equals":
    case "notEquals":
      return "scalar";
    case "greaterThan":
    case "greaterThanOrEquals":
    case "lessThan":
    case "lessThanOrEquals":
      return "ordering";
    case "startsWith":
    case "endsWith":
      return "textual";
    case "in":
    case "notIn":
      return "membership";
    case "contains":
    case "notContains":
      return "containment";
    default:
      // Includes isEmpty / isNotEmpty: this payload contract cannot tell an
      // operand that is absent from one that was never fetched, so an operator
      // whose whole answer is that distinction has no safe reading here.
      return undefined;
  }
}

// Validate an expression against the subset without evaluating it. Useful on
// its own at authoring or load time: a profile refused here can never be
// satisfied, whatever payload it is later asked about.
export function validateAuthorizationSafeCondition(
  expr: CompilerConditionInput | null | undefined,
  options?: CompilerAuthorizationSafeOptions,
): CompilerAuthorizationSafeValidation {
  const limits = resolveAuthorizationSafeLimits(options);
  const state: AuthorizationSafeState = { nodes: 0 };
  const rejected = validateSafeBoolean(expr, 1, limits, state);
  return rejected === undefined ? { valid: true } : { valid: false, ...rejected };
}

export function evaluateAuthorizationSafeCondition(
  expr: CompilerConditionInput | null | undefined,
  payload: ExpressionPayload,
  options?: CompilerAuthorizationSafeOptions,
): CompilerAuthorizationSafeEvaluation {
  const validation = validateAuthorizationSafeCondition(expr, options);
  if (!validation.valid) {
    return { outcome: "rejected", rejection: validation.rejection, detail: validation.detail };
  }
  const state: AuthorizationSafeState = { nodes: 0 };
  const verdict = evalSafeBoolean(expr as CompilerExpressionInput, payload, state);
  if (verdict === true) return { outcome: "satisfied" };
  if (verdict === false) return { outcome: "notSatisfied" };
  const unknown = state.unknown ?? {
    rejection: "unknownOperand" as const,
    detail: "an operand did not resolve",
  };
  return { outcome: "rejected", rejection: unknown.rejection, detail: unknown.detail };
}

// The boolean form: true only when the expression is provably satisfied. Every
// rejection and every unknown operand collapses to false here, so a caller that
// does not log the reason cannot accidentally read one as a match.
export function isAuthorizationSafeConditionSatisfied(
  expr: CompilerConditionInput | null | undefined,
  payload: ExpressionPayload,
  options?: CompilerAuthorizationSafeOptions,
): boolean {
  return evaluateAuthorizationSafeCondition(expr, payload, options).outcome === "satisfied";
}

function resolveAuthorizationSafeLimits(
  options?: CompilerAuthorizationSafeOptions,
): AuthorizationSafeLimits {
  const positive = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  const roots = options?.operandRoots;
  return {
    operandRoots:
      Array.isArray(roots) &&
      roots.length > 0 &&
      roots.every((root) => typeof root === "string" && root.length > 0)
        ? roots
        : AUTHORIZATION_SAFE_DEFAULT_OPERAND_ROOTS,
    maxNodes: positive(options?.maxNodes, AUTHORIZATION_SAFE_DEFAULT_MAX_NODES),
    maxDepth: positive(options?.maxDepth, AUTHORIZATION_SAFE_DEFAULT_MAX_DEPTH),
    maxPathSegments: positive(
      options?.maxPathSegments,
      AUTHORIZATION_SAFE_DEFAULT_MAX_PATH_SEGMENTS,
    ),
  };
}

function reject(
  rejection: CompilerAuthorizationSafeRejection,
  detail: string,
): AuthorizationSafeRejected {
  return { rejection, detail };
}

function validateSafeBoolean(
  expr: CompilerExpressionInput | null | undefined,
  depth: number,
  limits: AuthorizationSafeLimits,
  state: AuthorizationSafeState,
): AuthorizationSafeRejected | undefined {
  if (expr === null || expr === undefined) {
    return reject("unsupportedExpression", "the condition is missing");
  }
  if (typeof expr !== "object" || Array.isArray(expr)) {
    return reject("unsupportedExpression", "the condition is not an object");
  }
  if (depth > limits.maxDepth) {
    return reject("complexityExceeded", `the condition nests deeper than ${limits.maxDepth}`);
  }
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    return reject("complexityExceeded", `the condition holds more than ${limits.maxNodes} nodes`);
  }
  const kind = inferKind(expr);
  if (kind === "group") return validateSafeGroup(expr as GroupExpr, depth, limits, state);
  if (kind === "rule") return validateSafeRule(expr as RuleExpr, limits, state);
  return reject(
    "unsupportedExpression",
    `${describeKind(kind)} is not a condition in the authorization-safe subset`,
  );
}

function validateSafeGroup(
  expr: GroupExpr,
  depth: number,
  limits: AuthorizationSafeLimits,
  state: AuthorizationSafeState,
): AuthorizationSafeRejected | undefined {
  const keys = (["conditions", "all", "any"] as const).filter(
    (key) => (expr as Record<string, unknown>)[key] !== undefined,
  );
  if (keys.length !== 1) {
    return reject(
      "unsupportedExpression",
      keys.length === 0
        ? "a group without children"
        : `a group declaring both ${keys.join(" and ")}`,
    );
  }
  const key = keys[0]!;
  const children = (expr as Record<string, unknown>)[key];
  if (!Array.isArray(children) || children.length === 0) {
    return reject("unsupportedExpression", `a group whose \`${key}\` holds no condition`);
  }
  const mode = expr.mode;
  if (mode !== undefined && mode !== "all" && mode !== "any") {
    return reject("unsupportedExpression", "a group with an unknown mode");
  }
  // The open-world evaluator lets an explicit `mode` win over the keyed form, so
  // `any` combined with `mode: all` reads as AND. Refuse rather than pick.
  if ((key === "any" || key === "all") && mode !== undefined && mode !== key) {
    return reject("unsupportedExpression", `an \`${key}\` group contradicted by mode \`${mode}\``);
  }
  for (const child of children as CompilerExpressionInput[]) {
    const rejected = validateSafeBoolean(child, depth + 1, limits, state);
    if (rejected !== undefined) return rejected;
  }
  return undefined;
}

function validateSafeRule(
  expr: RuleExpr,
  limits: AuthorizationSafeLimits,
  state: AuthorizationSafeState,
): AuthorizationSafeRejected | undefined {
  const shape = authorizationSafeOperandShape(expr.operator);
  if (shape === undefined) {
    return reject(
      "unsupportedOperator",
      `operator \`${String(expr.operator)}\` is not in the authorization-safe subset`,
    );
  }
  const left = validateSafeOperand(expr.left, "left", false, limits, state);
  if (left !== undefined) return left;
  if (expr.right === undefined) {
    return reject(
      "unsupportedOperand",
      `operator \`${String(expr.operator)}\` needs a right operand`,
    );
  }
  return validateSafeOperand(expr.right, "right", shape === "membership", limits, state);
}

function validateSafeOperand(
  expr: CompilerExpressionInput | null | undefined,
  position: string,
  listLiteral: boolean,
  limits: AuthorizationSafeLimits,
  state: AuthorizationSafeState,
): AuthorizationSafeRejected | undefined {
  if (expr === null || expr === undefined) {
    return reject("unsupportedOperand", `the ${position} operand is missing`);
  }
  if (typeof expr !== "object" || Array.isArray(expr)) {
    return reject("unsupportedOperand", `the ${position} operand is not an object`);
  }
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    return reject("complexityExceeded", `the condition holds more than ${limits.maxNodes} nodes`);
  }
  switch (inferKind(expr)) {
    case "path":
      return validateSafePath(expr as PathExpr, position, limits);
    case "literal":
      return validateSafeLiteral(expr as LiteralExpr, position, listLiteral);
    case "function": {
      const fn = expr as FunctionExpr;
      if (fn.name !== "today") {
        return reject(
          "unsupportedOperand",
          `the ${position} operand calls unsupported function \`${String(fn.name)}\``,
        );
      }
      return validateSafeOffset(fn.offset, position);
    }
    default:
      return reject(
        "unsupportedOperand",
        `the ${position} operand is ${describeKind(inferKind(expr))}, not a value`,
      );
  }
}

function validateSafePath(
  expr: PathExpr,
  position: string,
  limits: AuthorizationSafeLimits,
): AuthorizationSafeRejected | undefined {
  const path = expr.path;
  if (typeof path !== "string" || path.length === 0) {
    return reject("unsupportedOperand", `the ${position} operand has no path`);
  }
  if (expr.filter !== undefined) {
    return reject("unsupportedOperand", `path \`${path}\` uses an unsupported filter`);
  }
  const segments = path.split(".");
  if (segments.length > limits.maxPathSegments) {
    return reject(
      "complexityExceeded",
      `path \`${path}\` walks more than ${limits.maxPathSegments} segments`,
    );
  }
  if (segments.some((segment) => segment.length === 0)) {
    return reject("unsupportedOperand", `path \`${path}\` has an empty segment`);
  }
  if (!limits.operandRoots.includes(segments[0]!)) {
    return reject(
      "unsupportedOperand",
      `path \`${path}\` is not rooted in ${limits.operandRoots.join(" / ")}`,
    );
  }
  return validateSafeOffset(expr.offset, position);
}

function validateSafeLiteral(
  expr: LiteralExpr,
  position: string,
  listLiteral: boolean,
): AuthorizationSafeRejected | undefined {
  const value = expr.value;
  if (Array.isArray(value)) {
    if (!listLiteral) {
      return reject("unsupportedOperand", `the ${position} operand is a list`);
    }
    return authorizationSafeListDefect(value, position);
  }
  if (!isAuthorizationSafeScalar(value)) {
    return reject(
      "unsupportedOperand",
      `the ${position} operand literal is ${describeValue(value)}`,
    );
  }
  return undefined;
}

function validateSafeOffset(
  offset: { days: number } | undefined,
  position: string,
): AuthorizationSafeRejected | undefined {
  if (offset === undefined) return undefined;
  const days = (offset as { days?: unknown }).days;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    Math.abs(days) > AUTHORIZATION_SAFE_MAX_OFFSET_DAYS
  ) {
    return reject("unsupportedOperand", `the ${position} operand has an unusable day offset`);
  }
  return undefined;
}

// `undefined` is unknown: not provably true and not provably false.
function evalSafeBoolean(
  expr: CompilerExpressionInput,
  payload: ExpressionPayload,
  state: AuthorizationSafeState,
): boolean | undefined {
  if (inferKind(expr) !== "group") {
    return evalSafeRule(expr as RuleExpr, payload, state);
  }
  const group = expr as GroupExpr;
  const children = (group.conditions ?? group.all ?? group.any ?? []) as CompilerExpressionInput[];
  const mode = group.mode ?? (group.any ? "any" : "all");
  let unknown = false;
  for (const child of children) {
    const verdict = evalSafeBoolean(child, payload, state);
    if (verdict === undefined) {
      unknown = true;
      continue;
    }
    // A decided child settles the group: false ends `all`, true ends `any`,
    // whatever the remaining children would have been.
    if (mode === "any") {
      if (verdict) return true;
    } else if (!verdict) {
      return false;
    }
  }
  if (unknown) return undefined;
  return mode !== "any";
}

function evalSafeRule(
  expr: RuleExpr,
  payload: ExpressionPayload,
  state: AuthorizationSafeState,
): boolean | undefined {
  // Authorization operands must come from the supplied record, not its
  // prototype. The ordinary expression evaluator deliberately supports more
  // permissive object traversal; keep that behavior for its existing callers.
  if (!safeOperandPresent(expr.left, payload) || !safeOperandPresent(expr.right, payload)) {
    return markUnknown(state, "unknownOperand", "an operand did not resolve from an own property");
  }
  const left = evaluateExpression(expr.left, payload);
  const right = evaluateExpression(expr.right, payload);
  const operator = String(expr.operator);
  if (!isResolvedOperandValue(left)) {
    return markUnknown(state, "unknownOperand", `the left operand of \`${operator}\` did not resolve`);
  }
  if (!isResolvedOperandValue(right)) {
    return markUnknown(
      state,
      "unknownOperand",
      `the right operand of \`${operator}\` did not resolve`,
    );
  }
  const defect = authorizationSafeOperandDefect(
    authorizationSafeOperandShape(expr.operator),
    left,
    right,
  );
  if (defect !== undefined) return markUnknown(state, "unsupportedOperand", defect);
  return applyConditionOperator(expr.operator, left, right);
}

function safeOperandPresent(expr: CompilerExpressionInput | undefined, payload: ExpressionPayload): boolean {
  if (!expr || inferKind(expr) !== "path") return true;
  let current: unknown = payload;
  for (const segment of (expr as PathExpr).path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

function markUnknown(
  state: AuthorizationSafeState,
  rejection: CompilerAuthorizationSafeRejection,
  detail: string,
): undefined {
  if (state.unknown === undefined) state.unknown = reject(rejection, detail);
  return undefined;
}

function isResolvedOperandValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return true;
}

// The comparison table coerces (`toNumber` turns anything unusable into 0,
// `isEqual` reports two different types as unequal), and under a negative
// operator a coerced mismatch reads as a match. So the pair must already be
// comparable without coercion; anything else is unknown, never a verdict.
function authorizationSafeOperandDefect(
  shape: AuthorizationSafeOperandShape | undefined,
  left: unknown,
  right: unknown,
): string | undefined {
  switch (shape) {
    case "scalar":
      return authorizationSafeScalarPairDefect(left, right);
    case "ordering":
      if (!isOrderedValue(left)) {
        return `the left operand is ${describeValue(left)}, not orderable`;
      }
      if (!isOrderedValue(right)) {
        return `the right operand is ${describeValue(right)}, not orderable`;
      }
      if ((left instanceof Date) !== (right instanceof Date)) {
        return `${describeValue(left)} cannot be ordered against ${describeValue(right)}`;
      }
      return undefined;
    case "textual":
      if (typeof left !== "string") {
        return `the left operand is ${describeValue(left)}, not text`;
      }
      if (typeof right !== "string") {
        return `the right operand is ${describeValue(right)}, not text`;
      }
      return undefined;
    case "membership": {
      const list = authorizationSafeListDefect(right, "right");
      if (list !== undefined) return list.detail;
      return authorizationSafeMemberDefect(left, right as unknown[], "left");
    }
    case "containment":
      if (typeof left === "string") {
        return typeof right === "string"
          ? undefined
          : `the right operand is ${describeValue(right)}, not text`;
      }
      if (Array.isArray(left)) {
        const list = authorizationSafeListDefect(left, "left");
        if (list !== undefined) return list.detail;
        return authorizationSafeMemberDefect(right, left, "right");
      }
      return `the left operand is ${describeValue(left)}, neither text nor a list`;
    default:
      return "the operator is not in the authorization-safe subset";
  }
}

function authorizationSafeScalarPairDefect(left: unknown, right: unknown): string | undefined {
  if (!isAuthorizationSafeScalar(left)) {
    return `the left operand is ${describeValue(left)}, not a single value`;
  }
  if (!isAuthorizationSafeScalar(right)) {
    return `the right operand is ${describeValue(right)}, not a single value`;
  }
  if (describeValue(left) !== describeValue(right)) {
    return `${describeValue(left)} cannot be compared with ${describeValue(right)}`;
  }
  return undefined;
}

function authorizationSafeListDefect(
  value: unknown,
  position: string,
): AuthorizationSafeRejected | undefined {
  if (!Array.isArray(value)) {
    return reject(
      "unsupportedOperand",
      `the ${position} operand is ${describeValue(value)}, not a list`,
    );
  }
  if (value.length === 0) {
    // An empty list makes `notIn` vacuously true, which is the grant this
    // subset exists to prevent.
    return reject("unsupportedOperand", `the ${position} operand is an empty list`);
  }
  if (value.length > AUTHORIZATION_SAFE_MAX_LIST_ITEMS) {
    return reject("complexityExceeded", `the ${position} operand list is too large`);
  }
  for (const item of value) {
    if (!isAuthorizationSafeScalar(item)) {
      return reject(
        "unsupportedOperand",
        `the ${position} operand list holds ${describeValue(item)}`,
      );
    }
  }
  return undefined;
}

function authorizationSafeMemberDefect(
  member: unknown,
  list: unknown[],
  position: string,
): string | undefined {
  if (!isAuthorizationSafeScalar(member)) {
    return `the ${position} operand is ${describeValue(member)}, not a single value`;
  }
  const kind = describeValue(member);
  for (const item of list) {
    if (describeValue(item) !== kind) {
      return `${kind} cannot be looked up in a list of ${describeValue(item)}`;
    }
  }
  return undefined;
}

function isAuthorizationSafeScalar(value: unknown): boolean {
  if (typeof value === "string") return value.length <= AUTHORIZATION_SAFE_MAX_STRING_LENGTH;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return false;
}

function isOrderedValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function describeKind(kind: string): string {
  return kind === "" ? "an untagged expression" : `a \`${kind}\` expression`;
}

// A type, never a value: these strings reach the caller's logs, and the operand
// payload may hold personal data. Doubles as the comparability key above, so
// every scalar type must describe differently.
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "absent";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "an invalid date" : "a date";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "string":
      return "text";
    case "boolean":
      return "a boolean";
    case "number":
      return Number.isFinite(value) ? "a number" : "a non-finite number";
    case "object":
      return "an object";
    default:
      return `a ${typeof value}`;
  }
}
